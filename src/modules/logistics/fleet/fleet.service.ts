import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';
import { FLEET_WIDE_ROLES, Role } from '../../../common/constants/permissions';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { Errors } from '../../../common/utils/errors';
import { ACTIVE_TRIP_STATES, MOVING_TRIP_STATES, TRUCK_AVAILABILITY } from '../../../common/utils/state-machine';
import { AuditService } from '../../audit/audit.service';
import { SettingsService } from '../../settings/settings.service';
import { Driver } from '../drivers/entities/driver.entities';
import { DEFAULT_LOGISTICS_THRESHOLDS, LogisticsThresholds, logisticsThresholds, Paged, pageParams } from '../logistics.constants';
import { Shipment, Trip, TripShipment } from '../shipments/entities/shipment.entities';
import { CreateTruckDto, CreateVehicleTypeDto, LocationHistoryQuery, TruckListQuery, TruckStatusDto, UpdateTruckDto, UpdateVehicleTypeDto, VehicleTypeListQuery } from './dto/fleet.dto';
import { GpsDevice, Truck, TruckLocation, VehicleType } from './entities/fleet.entities';

export type Connectivity = 'ONLINE' | 'STALE' | 'OFFLINE' | 'NEVER_SEEN';

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const isUniqueViolation = (e: any) => e?.code === '23505' || e?.driverError?.code === '23505';

/**
 * Fleet: vehicle types, trucks, truck eligibility & availability (Logistics doc §8, §8.1).
 * Operational status (ACTIVE/MAINTENANCE/OUT_OF_SERVICE), availability (AVAILABLE/RESERVED/ON_TRIP) and GPS connectivity are
 * three independent dimensions — GPS_OFFLINE is telemetry and never changes the operational status (§5.4).
 */
@Injectable()
export class FleetService {
  private readonly logger = new Logger('Fleet');
  private thresholdCache: { value: LogisticsThresholds; at: number } | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(VehicleType) readonly vehicleTypes: Repository<VehicleType>,
    @InjectRepository(Truck) readonly trucks: Repository<Truck>,
    @InjectRepository(GpsDevice) readonly devices: Repository<GpsDevice>,
    @InjectRepository(TruckLocation) readonly locations: Repository<TruckLocation>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(Driver) private readonly drivers: Repository<Driver>,
    private readonly settings: SettingsService,
    private readonly audit: AuditService
  ) {}

  // =====================================================================================================
  // Thresholds & connectivity
  // =====================================================================================================

  /** Runtime thresholds (settings 'logisticsThresholds'), cached for 30 s. Also refreshes the cache used by connectivityOf(). */
  async thresholds(force = false): Promise<LogisticsThresholds> {
    if (!force && this.thresholdCache && Date.now() - this.thresholdCache.at < 30_000) return this.thresholdCache.value;
    try {
      const value = await logisticsThresholds(this.settings);
      this.thresholdCache = { value, at: Date.now() };
      return value;
    } catch (e) {
      this.logger.warn(`Could not load logisticsThresholds: ${(e as Error).message}`);
      return this.thresholdCache?.value ?? DEFAULT_LOGISTICS_THRESHOLDS;
    }
  }

  /** Telemetry connectivity derived from lastSeenAt (thresholds from settings 'logisticsThresholds', cached). */
  connectivityOf(lastSeenAt: Date | null): Connectivity {
    if (!lastSeenAt) return 'NEVER_SEEN';
    const th = this.thresholdCache?.value ?? DEFAULT_LOGISTICS_THRESHOLDS;
    const ageMin = (Date.now() - new Date(lastSeenAt).getTime()) / 60_000;
    if (ageMin <= th.gpsStaleMinutes) return 'ONLINE';
    if (ageMin <= th.gpsOfflineMinutes) return 'STALE';
    return 'OFFLINE';
  }

  /**
   * Effective device connectivity: the worse of the value derived from lastSeenAt and the stored value (set by the
   * stale/offline job or by a GPS-platform "deviceOffline" event). A new accepted position resets the stored value to ONLINE.
   */
  deviceConnectivity(d: GpsDevice): Connectivity {
    const derived = this.connectivityOf(d.lastSeenAt);
    if (derived === 'NEVER_SEEN') return derived;
    const rank: Record<string, number> = { ONLINE: 0, STALE: 1, OFFLINE: 2 };
    return (rank[d.connectivity] ?? 0) > rank[derived] ? (d.connectivity as Connectivity) : derived;
  }

  /** SQL fragment equivalent to deviceConnectivity() for device alias `a` (requires fresh thresholds). */
  connectivitySql(a: string, value: string, th: LogisticsThresholds): { sql: string; params: Record<string, unknown> } {
    const params = { staleBefore: new Date(Date.now() - th.gpsStaleMinutes * 60_000), offlineBefore: new Date(Date.now() - th.gpsOfflineMinutes * 60_000) };
    switch (value) {
      case 'NEVER_SEEN': return { sql: `(${a}.id IS NOT NULL AND ${a}.lastSeenAt IS NULL)`, params: {} };
      case 'ONLINE': return { sql: `(${a}.lastSeenAt >= :staleBefore AND ${a}.connectivity NOT IN ('STALE','OFFLINE'))`, params };
      case 'STALE': return {
        sql: `(${a}.lastSeenAt IS NOT NULL AND ${a}.connectivity <> 'OFFLINE' AND ((${a}.lastSeenAt < :staleBefore AND ${a}.lastSeenAt >= :offlineBefore) OR (${a}.lastSeenAt >= :staleBefore AND ${a}.connectivity = 'STALE')))`,
        params
      };
      case 'OFFLINE': return { sql: `(${a}.lastSeenAt IS NOT NULL AND (${a}.lastSeenAt < :offlineBefore OR ${a}.connectivity = 'OFFLINE'))`, params };
      default: return { sql: '1=1', params: {} };
    }
  }

  // =====================================================================================================
  // Frontend shapes
  // =====================================================================================================

  vehicleTypeToFrontend(v: VehicleType) {
    return {
      id: v.id, code: v.code, name: v.name, maxCapacityValue: v.maxCapacityValue, capacityUnit: v.capacityUnit,
      allowedLicenceClasses: v.allowedLicenceClasses || [], cargoTypes: v.cargoTypes || [], active: v.active
    };
  }

  /** Device summary embedded in truck payloads — never includes IMEI/SIM. */
  private deviceSummary(d: GpsDevice) {
    return {
      id: d.id, provider: d.provider, providerDeviceId: d.providerDeviceId, model: d.model, deviceStatus: d.deviceStatus,
      connectivity: this.deviceConnectivity(d), lastSeenAt: iso(d.lastSeenAt)
    };
  }

  lastPositionOf(t: Truck) {
    if (t.lastLat === null || t.lastLat === undefined || t.lastLng === null || t.lastLng === undefined) return null;
    const th = this.thresholdCache?.value ?? DEFAULT_LOGISTICS_THRESHOLDS;
    const ageSeconds = t.lastPositionAt ? Math.max(0, Math.round((Date.now() - new Date(t.lastPositionAt).getTime()) / 1000)) : null;
    return {
      lat: t.lastLat, lng: t.lastLng, speedKmh: t.lastSpeedKmh, heading: t.lastHeading, recordedAt: iso(t.lastPositionAt),
      ageSeconds, stale: ageSeconds === null ? true : ageSeconds > th.gpsStaleMinutes * 60
    };
  }

  tripSummary(trip: Trip | null | undefined) {
    if (!trip) return null;
    return {
      id: trip.id, tripNumber: trip.tripNumber, status: trip.status, primaryDriverId: trip.primaryDriverId, routeId: trip.routeId,
      plannedStartAt: iso(trip.plannedStartAt), estimatedArrivalAt: iso(trip.estimatedArrivalAt)
    };
  }

  /**
   * Contract (LOGISTICS.md). opts.device / opts.vehicleType are embedded when given (undefined = not loaded → null).
   * opts.currentTrip (extension) embeds the active trip summary.
   */
  truckToFrontend(t: Truck, opts: { device?: GpsDevice | null; vehicleType?: VehicleType | null; currentTrip?: Trip | null } = {}): any {
    const device = opts.device ?? null;
    return {
      id: t.id,
      fleetCode: t.fleetCode,
      plateNumber: t.plateNumber,
      vehicleTypeId: t.vehicleTypeId,
      vehicleType: opts.vehicleType ? this.vehicleTypeToFrontend(opts.vehicleType) : null,
      capacityValue: t.capacityValue,
      capacityUnit: t.capacityUnit,
      ownership: t.ownership,
      transporterName: t.transporterName,
      operationalStatus: t.operationalStatus,
      availabilityStatus: t.availabilityStatus,
      connectivity: device ? this.deviceConnectivity(device) : 'NO_DEVICE',
      device: device ? this.deviceSummary(device) : null,
      lastPosition: this.lastPositionOf(t),
      stationarySince: iso(t.stationarySince),
      currentTrip: this.tripSummary(opts.currentTrip),
      notes: t.notes,
      createdAt: iso(t.createdAt),
      updatedAt: iso(t.updatedAt)
    };
  }

  /** Contract (LOGISTICS.md). IMEI / SIM masked (last 4 digits) unless sensitive (devices:manage). */
  deviceToFrontend(d: GpsDevice, opts: { sensitive?: boolean; truck?: Truck | null } = {}): any {
    const mask = (v: string | null) => (v ? (opts.sensitive ? v : `${'*'.repeat(Math.max(v.length - 4, 0))}${v.slice(-4)}`) : null);
    return {
      id: d.id,
      provider: d.provider,
      providerDeviceId: d.providerDeviceId,
      imei: mask(d.imei),
      model: d.model,
      simNumber: mask(d.simNumber),
      truckId: d.truckId,
      truck: opts.truck ? { id: opts.truck.id, fleetCode: opts.truck.fleetCode, plateNumber: opts.truck.plateNumber } : null,
      deviceStatus: d.deviceStatus,
      connectivity: d.deviceStatus === 'RETIRED' ? d.connectivity : this.deviceConnectivity(d),
      lastSeenAt: iso(d.lastSeenAt),
      lastPositionRecordedAt: iso(d.lastPositionRecordedAt),
      createdAt: iso(d.createdAt),
      updatedAt: iso(d.updatedAt)
    };
  }

  /** Batch-loads devices, vehicle types and active trips for a set of trucks. */
  async decorateTrucks(list: Truck[]): Promise<any[]> {
    if (!list.length) return [];
    await this.thresholds();
    const ids = list.map(t => t.id);
    const [devices, types, trips] = await Promise.all([
      this.devices.find({ where: { truckId: In(ids) } }),
      this.vehicleTypes.find({ where: { id: In([...new Set(list.map(t => t.vehicleTypeId))]) } }),
      this.trips.find({ where: { truckId: In(ids), status: In(ACTIVE_TRIP_STATES) }, order: { createdAt: 'DESC' } })
    ]);
    const devBy = new Map(devices.map(d => [d.truckId!, d]));
    const typeBy = new Map(types.map(v => [v.id, v]));
    const tripBy = new Map<string, Trip>();
    for (const tr of trips) if (!tripBy.has(tr.truckId)) tripBy.set(tr.truckId, tr);
    return list.map(t => this.truckToFrontend(t, { device: devBy.get(t.id) ?? null, vehicleType: typeBy.get(t.vehicleTypeId) ?? null, currentTrip: tripBy.get(t.id) ?? null }));
  }

  // =====================================================================================================
  // Scoping (DRIVER → own active trip truck; WAREHOUSE_OPERATOR → trucks on trips to/from their warehouse)
  // =====================================================================================================

  /** Truck ids the user may see; null = all (fleet-wide roles). */
  async visibleTruckIds(user: AuthUser): Promise<string[] | null> {
    if (FLEET_WIDE_ROLES.includes(user.role)) return null;
    if (user.role === Role.DRIVER) {
      const driver = await this.drivers.findOne({ where: { userId: user.id } });
      if (!driver) return [];
      const trips = await this.trips.find({ where: { primaryDriverId: driver.id, status: In(ACTIVE_TRIP_STATES) } });
      return [...new Set(trips.map(t => t.truckId))];
    }
    if (user.role === Role.WAREHOUSE_OPERATOR) {
      if (!user.warehouseId) return [];
      const rows = await this.trips.createQueryBuilder('t')
        .select('t.truckId', 'truckId').distinct(true)
        .innerJoin(TripShipment, 'ts', 'ts.tripId = t.id')
        .innerJoin(Shipment, 's', 's.id = ts.shipmentId')
        .where('t.status IN (:...st)', { st: ACTIVE_TRIP_STATES })
        .andWhere('(s.originWarehouseId = :w OR s.destinationWarehouseId = :w)', { w: user.warehouseId })
        .getRawMany<{ truckId: string }>();
      return rows.map(r => r.truckId);
    }
    return [];
  }

  async assertCanViewTruck(user: AuthUser, truckId: string): Promise<void> {
    const visible = await this.visibleTruckIds(user);
    if (visible !== null && !visible.includes(truckId)) throw Errors.forbidden('This truck is outside your logistics scope');
  }

  // =====================================================================================================
  // Vehicle types
  // =====================================================================================================

  async listVehicleTypes(q: VehicleTypeListQuery): Promise<Paged<any>> {
    const { page, pageSize, skip, take } = pageParams(q);
    const where = q.active === undefined ? {} : { active: q.active === 'true' };
    const [rows, total] = await this.vehicleTypes.findAndCount({ where, order: { code: 'ASC' }, skip, take });
    return { items: rows.map(v => this.vehicleTypeToFrontend(v)), total, page, pageSize };
  }

  async createVehicleType(user: AuthUser, dto: CreateVehicleTypeDto, ctx: RequestContext) {
    const code = dto.code.toUpperCase();
    if (await this.vehicleTypes.exist({ where: { code } })) throw Errors.conflict(`Vehicle type code ${code} already exists`);
    try {
      const saved = await this.ds.transaction(async m => {
        const v = await m.getRepository(VehicleType).save(m.getRepository(VehicleType).create({
          code, name: dto.name, maxCapacityValue: dto.maxCapacityValue, capacityUnit: dto.capacityUnit || 'MT',
          allowedLicenceClasses: dto.allowedLicenceClasses || [], cargoTypes: dto.cargoTypes || [], active: dto.active ?? true
        }));
        await this.audit.record(user, 'VEHICLE_TYPE_CREATED', v.id, { new: this.vehicleTypeToFrontend(v) }, ctx, m);
        return v;
      });
      return this.vehicleTypeToFrontend(saved);
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict(`Vehicle type code ${code} already exists`);
      throw e;
    }
  }

  async updateVehicleType(user: AuthUser, id: string, dto: UpdateVehicleTypeDto, ctx: RequestContext) {
    const saved = await this.ds.transaction(async m => {
      const repo = m.getRepository(VehicleType);
      const v = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!v) throw Errors.notFound('Vehicle type');
      const old = this.vehicleTypeToFrontend(v);
      if (dto.maxCapacityValue !== undefined && dto.maxCapacityValue !== v.maxCapacityValue) {
        const over = await m.getRepository(Truck).createQueryBuilder('t')
          .where('t.vehicleTypeId = :id AND t.capacityValue > :max', { id, max: dto.maxCapacityValue }).getCount();
        if (over) throw Errors.conflict(`${over} truck(s) of this type exceed the new maximum capacity ${dto.maxCapacityValue}`);
      }
      Object.assign(v, Object.fromEntries(Object.entries(dto).filter(([, val]) => val !== undefined)));
      await repo.save(v);
      await this.audit.record(user, 'VEHICLE_TYPE_UPDATED', id, { old, new: this.vehicleTypeToFrontend(v) }, ctx, m);
      return v;
    });
    return this.vehicleTypeToFrontend(saved);
  }

  // =====================================================================================================
  // Trucks
  // =====================================================================================================

  async listTrucks(q: TruckListQuery): Promise<Paged<any>> {
    const th = await this.thresholds();
    const { page, pageSize, skip, take } = pageParams(q);
    const qb = this.trucks.createQueryBuilder('t').leftJoin(GpsDevice, 'd', 'd.truckId = t.id');
    if (q.status) qb.andWhere('t.operationalStatus = :st', { st: q.status });
    if (q.availability) qb.andWhere('t.availabilityStatus = :av', { av: q.availability });
    if (q.vehicleTypeId) qb.andWhere('t.vehicleTypeId = :vt', { vt: q.vehicleTypeId });
    if (q.q) qb.andWhere('(t.fleetCode ILIKE :q OR t.plateNumber ILIKE :q)', { q: `%${q.q.replace(/[%_]/g, s => '\\' + s)}%` });
    if (q.connectivity === 'NO_DEVICE') qb.andWhere('d.id IS NULL');
    else if (q.connectivity) {
      const c = this.connectivitySql('d', q.connectivity, th);
      qb.andWhere(c.sql, c.params);
    }
    qb.orderBy('t.fleetCode', 'ASC').skip(skip).take(take);
    const [rows, total] = await qb.getManyAndCount();
    return { items: await this.decorateTrucks(rows), total, page, pageSize };
  }

  async getTruck(id: string) {
    const t = await this.trucks.findOne({ where: { id } });
    if (!t) throw Errors.notFound('Truck');
    return (await this.decorateTrucks([t]))[0];
  }

  private async assertCapacity(m: EntityManager, vehicleTypeId: string, capacity: number): Promise<VehicleType> {
    const vt = await m.getRepository(VehicleType).findOne({ where: { id: vehicleTypeId } });
    if (!vt) throw Errors.unprocessable('Unknown vehicle type', [{ field: 'vehicleTypeId', message: 'vehicle type not found' }]);
    if (!(capacity > 0)) throw Errors.unprocessable('Capacity must be greater than 0', [{ field: 'capacityValue', message: 'must be > 0' }]);
    if (capacity > vt.maxCapacityValue) {
      throw Errors.unprocessable(`Capacity ${capacity} exceeds the vehicle type maximum ${vt.maxCapacityValue} ${vt.capacityUnit}`,
        [{ field: 'capacityValue', message: `must be ≤ ${vt.maxCapacityValue}` }]);
    }
    return vt;
  }

  private async assertUniqueTruck(m: EntityManager, fleetCode: string | undefined, plateNumber: string | undefined, excludeId?: string) {
    const repo = m.getRepository(Truck);
    if (fleetCode && await repo.exist({ where: { fleetCode, ...(excludeId ? { id: Not(excludeId) } : {}) } })) throw Errors.conflict(`Fleet code ${fleetCode} is already registered`);
    if (plateNumber && await repo.exist({ where: { plateNumber, ...(excludeId ? { id: Not(excludeId) } : {}) } })) throw Errors.conflict(`Plate number ${plateNumber} is already registered`);
  }

  async createTruck(user: AuthUser, dto: CreateTruckDto, ctx: RequestContext) {
    const fleetCode = dto.fleetCode.toUpperCase();
    const plateNumber = dto.plateNumber.trim().toUpperCase();
    try {
      const saved = await this.ds.transaction(async m => {
        const vt = await this.assertCapacity(m, dto.vehicleTypeId, dto.capacityValue);
        if (!vt.active) throw Errors.unprocessable('Vehicle type is inactive', [{ field: 'vehicleTypeId', message: 'inactive' }]);
        await this.assertUniqueTruck(m, fleetCode, plateNumber);
        const repo = m.getRepository(Truck);
        const t = await repo.save(repo.create({
          fleetCode, plateNumber, vehicleTypeId: vt.id, capacityValue: dto.capacityValue, capacityUnit: dto.capacityUnit || vt.capacityUnit || 'MT',
          ownership: dto.ownership || 'ESLSE', transporterName: dto.transporterName ?? null, notes: dto.notes ?? null,
          operationalStatus: 'ACTIVE', availabilityStatus: 'AVAILABLE'
        }));
        await this.audit.record(user, 'TRUCK_CREATED', t.id, { new: { fleetCode, plateNumber, vehicleTypeId: vt.id, capacityValue: t.capacityValue, ownership: t.ownership } }, ctx, m);
        return t;
      });
      return (await this.decorateTrucks([saved]))[0];
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict('Fleet code or plate number is already registered');
      throw e;
    }
  }

  async updateTruck(user: AuthUser, id: string, dto: UpdateTruckDto, ctx: RequestContext) {
    try {
      const saved = await this.ds.transaction(async m => {
        const repo = m.getRepository(Truck);
        const t = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!t) throw Errors.notFound('Truck');
        const changes: Partial<Truck> = {};
        if (dto.fleetCode !== undefined) changes.fleetCode = dto.fleetCode.toUpperCase();
        if (dto.plateNumber !== undefined) changes.plateNumber = dto.plateNumber.trim().toUpperCase();
        if (dto.vehicleTypeId !== undefined) changes.vehicleTypeId = dto.vehicleTypeId;
        if (dto.capacityValue !== undefined) changes.capacityValue = dto.capacityValue;
        if (dto.capacityUnit !== undefined) changes.capacityUnit = dto.capacityUnit;
        if (dto.ownership !== undefined) changes.ownership = dto.ownership;
        if (dto.transporterName !== undefined) changes.transporterName = dto.transporterName;
        if (dto.notes !== undefined) changes.notes = dto.notes;
        const old: Record<string, unknown> = {};
        for (const k of Object.keys(changes) as (keyof Truck)[]) old[k] = t[k];
        if (changes.vehicleTypeId !== undefined || changes.capacityValue !== undefined) {
          await this.assertCapacity(m, changes.vehicleTypeId ?? t.vehicleTypeId, changes.capacityValue ?? t.capacityValue);
        }
        await this.assertUniqueTruck(m, changes.fleetCode !== t.fleetCode ? changes.fleetCode : undefined, changes.plateNumber !== t.plateNumber ? changes.plateNumber : undefined, id);
        Object.assign(t, changes);
        await repo.save(t);
        await this.audit.record(user, 'TRUCK_UPDATED', id, { old, new: changes }, ctx, m);
        return t;
      });
      return (await this.decorateTrucks([saved]))[0];
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict('Fleet code or plate number is already registered');
      throw e;
    }
  }

  /** Operational status (ACTIVE | MAINTENANCE | OUT_OF_SERVICE). Not allowed to leave service while the truck is on a trip. */
  async setOperationalStatus(user: AuthUser, id: string, dto: TruckStatusDto, ctx: RequestContext) {
    const saved = await this.ds.transaction(async m => {
      const repo = m.getRepository(Truck);
      const t = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!t) throw Errors.notFound('Truck');
      if (t.operationalStatus === dto.operationalStatus) throw Errors.conflict(`Truck is already ${dto.operationalStatus}`);
      if (dto.operationalStatus !== 'ACTIVE') {
        const moving = await m.getRepository(Trip).findOne({ where: { truckId: id, status: In(MOVING_TRIP_STATES) } });
        if (t.availabilityStatus === 'ON_TRIP' || moving) {
          throw Errors.conflict(`Truck ${t.fleetCode} is on a trip and cannot be set to ${dto.operationalStatus}`, { tripId: moving?.id ?? null });
        }
      }
      const old = t.operationalStatus;
      t.operationalStatus = dto.operationalStatus;
      await repo.save(t);
      await this.audit.record(user, 'TRUCK_STATUS_CHANGED', id, { old: { operationalStatus: old }, new: { operationalStatus: t.operationalStatus }, reason: dto.reason }, ctx, m);
      return t;
    });
    return (await this.decorateTrucks([saved]))[0];
  }

  /** Location history: newest first, keyset cursor (nextCursor) or page/pageSize (max 1000). */
  async locationHistory(truckId: string, q: LocationHistoryQuery) {
    if (!(await this.trucks.exist({ where: { id: truckId } }))) throw Errors.notFound('Truck');
    const pageSize = Math.min(Math.max(q.pageSize || 200, 1), 1000);
    const page = Math.max(q.page || 1, 1);
    if (q.from && q.to && q.from > q.to) throw Errors.unprocessable('from must be before to');
    const qb = this.locations.createQueryBuilder('l').where('l.truckId = :truckId', { truckId });
    if (q.from) qb.andWhere('l.recordedAt >= :from', { from: q.from });
    if (q.to) qb.andWhere('l.recordedAt <= :to', { to: q.to });
    let total: number | null = null;
    if (q.cursor) {
      const c = this.decodeCursor(q.cursor);
      qb.andWhere('(l.recordedAt < :ct OR (l.recordedAt = :ct AND l.id < :cid))', { ct: c.t, cid: c.id });
    } else {
      total = await qb.clone().getCount();
      qb.skip((page - 1) * pageSize);
    }
    const rows = await qb.orderBy('l.recordedAt', 'DESC').addOrderBy('l.id', 'DESC').take(pageSize).getMany();
    const last = rows[rows.length - 1];
    return {
      items: rows.map(l => this.locationToFrontend(l)),
      total,
      page: q.cursor ? null : page,
      pageSize,
      nextCursor: rows.length === pageSize && last ? Buffer.from(`${last.recordedAt.toISOString()}|${last.id}`).toString('base64url') : null
    };
  }

  private decodeCursor(cursor: string): { t: Date; id: string } {
    const [t, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const d = new Date(t);
    if (!t || !id || Number.isNaN(d.getTime()) || !/^\d+$/.test(id)) throw Errors.badRequest('Invalid cursor');
    return { t: d, id };
  }

  locationToFrontend(l: TruckLocation) {
    return {
      id: l.id, truckId: l.truckId, deviceId: l.deviceId, tripId: l.tripId, lat: l.latitude, lng: l.longitude, speedKmh: l.speedKmh,
      heading: l.heading, recordedAt: iso(l.recordedAt), receivedAt: iso(l.receivedAt), source: l.source, outOfOrder: l.outOfOrder
    };
  }

  // =====================================================================================================
  // Cross-module contract
  // =====================================================================================================

  async checkTruckEligibility(
    truckId: string,
    ctx: { quantity: number; cargoType?: string | null; requiresTracking: boolean; excludeTripId?: string },
    manager?: EntityManager
  ): Promise<{ eligible: boolean; reasons: string[] }> {
    const m = manager ?? this.ds.manager;
    await this.thresholds();
    const t = await m.getRepository(Truck).findOne({ where: { id: truckId } });
    if (!t) return { eligible: false, reasons: ['Truck not found'] };
    const reasons: string[] = [];
    if (t.operationalStatus !== 'ACTIVE') reasons.push(`Truck operational status is ${t.operationalStatus} (must be ACTIVE)`);
    // When re-validating a trip (reassignment), the truck being RESERVED/ON_TRIP for that same trip is not a conflict.
    const heldByExcluded = !!ctx.excludeTripId && ['RESERVED', 'ON_TRIP'].includes(t.availabilityStatus) &&
      await m.getRepository(Trip).exist({ where: { id: ctx.excludeTripId, truckId, status: In(ACTIVE_TRIP_STATES) } });
    if (t.availabilityStatus !== 'AVAILABLE' && !heldByExcluded) reasons.push(`Truck availability is ${t.availabilityStatus} (must be AVAILABLE)`);
    if (Number(ctx.quantity) > t.capacityValue) reasons.push(`Truck capacity ${t.capacityValue} ${t.capacityUnit} is less than the planned quantity ${ctx.quantity}`);
    const vt = await m.getRepository(VehicleType).findOne({ where: { id: t.vehicleTypeId } });
    if (!vt) reasons.push('Truck vehicle type not found');
    else {
      if (!vt.active) reasons.push(`Vehicle type ${vt.code} is inactive`);
      if (ctx.cargoType && (vt.cargoTypes || []).length && !vt.cargoTypes.includes(ctx.cargoType)) {
        reasons.push(`Vehicle type ${vt.code} cannot carry cargo type ${ctx.cargoType} (allowed: ${vt.cargoTypes.join(', ')})`);
      }
    }
    if (ctx.requiresTracking) {
      const device = await m.getRepository(GpsDevice).findOne({ where: { truckId } });
      if (!device || device.deviceStatus !== 'ACTIVE') reasons.push('Tracking is required but no ACTIVE GPS device is mapped to the truck');
      else {
        const c = this.deviceConnectivity(device);
        if (c === 'OFFLINE' || c === 'NEVER_SEEN') reasons.push(`Tracking is required but the GPS device is ${c}`);
      }
    }
    const tripQb = m.getRepository(Trip).createQueryBuilder('tr')
      .where('tr.truckId = :truckId', { truckId }).andWhere('tr.status IN (:...st)', { st: ACTIVE_TRIP_STATES });
    if (ctx.excludeTripId) tripQb.andWhere('tr.id <> :ex', { ex: ctx.excludeTripId });
    const other = await tripQb.getOne();
    if (other) reasons.push(`Truck already has an active trip ${other.tripNumber} (${other.status})`);
    return { eligible: reasons.length === 0, reasons };
  }

  /** Assignment modal: every non-retired truck split into eligible / ineligible (with reasons) for the given load. */
  async eligibleTrucks(q: { quantity: number; cargoType?: string; requiresTracking?: string; excludeTripId?: string }) {
    const requiresTracking = q.requiresTracking !== 'false';
    const { items } = await this.listTrucks({ pageSize: '200' } as TruckListQuery);
    const eligible: any[] = [];
    const ineligible: Array<{ truck: any; reasons: string[] }> = [];
    for (const t of items) {
      const res = await this.checkTruckEligibility(t.id, { quantity: Number(q.quantity), cargoType: q.cargoType ?? null, requiresTracking, excludeTripId: q.excludeTripId });
      if (res.eligible) eligible.push(t);
      else ineligible.push({ truck: t, reasons: res.reasons });
    }
    // Smallest sufficient truck first: keeps big trucks free for big loads.
    eligible.sort((a, b) => a.capacityValue - b.capacityValue);
    return { quantity: Number(q.quantity), cargoType: q.cargoType ?? null, requiresTracking, eligible, ineligible };
  }

  /** Availability (AVAILABLE | RESERVED | ON_TRIP). Publishes nothing — callers publish trip events. */
  async setAvailability(truckId: string, status: 'AVAILABLE' | 'RESERVED' | 'ON_TRIP', manager?: EntityManager): Promise<void> {
    if (!(TRUCK_AVAILABILITY as readonly string[]).includes(status)) throw Errors.badRequest(`Invalid truck availability ${status}`);
    const res = await (manager ?? this.ds.manager).getRepository(Truck).update({ id: truckId }, { availabilityStatus: status });
    if (!res.affected) throw Errors.notFound('Truck');
  }
}
