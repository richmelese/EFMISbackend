import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { can, Role } from '../../../common/constants/permissions';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { Errors } from '../../../common/utils/errors';
import { ACTIVE_TRIP_STATES, MOVING_TRIP_STATES } from '../../../common/utils/state-machine';
import { applySearch } from '../../../common/utils/query-filters';
import { AuditService } from '../../audit/audit.service';
import { Paged, pageParams } from '../logistics.constants';
import { RealtimeService } from '../realtime/realtime.service';
import { Trip } from '../shipments/entities/shipment.entities';
import { AssignDeviceDto, CreateGpsDeviceDto, GpsDeviceListQuery, RetireDeviceDto, UnassignDeviceDto, UpdateGpsDeviceDto } from './dto/fleet.dto';
import { GpsDevice, GpsDeviceAssignment, GpsIngestRejection, Truck, TruckLocation } from './entities/fleet.entities';
import { FleetService } from './fleet.service';

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const isUniqueViolation = (e: any) => e?.code === '23505' || e?.driverError?.code === '23505';
/** Restricted identifiers never go into audit details in clear text */
const maskId = (v: string | null | undefined) => (v ? `***${v.slice(-4)}` : null);

/** GPS device registry & device ↔ truck pairing (Logistics doc §8 steps 17–26). */
@Injectable()
export class GpsDevicesService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(GpsDevice) private readonly devices: Repository<GpsDevice>,
    @InjectRepository(GpsDeviceAssignment) private readonly assignments: Repository<GpsDeviceAssignment>,
    @InjectRepository(GpsIngestRejection) private readonly rejections: Repository<GpsIngestRejection>,
    @InjectRepository(TruckLocation) private readonly locations: Repository<TruckLocation>,
    @InjectRepository(Truck) private readonly trucks: Repository<Truck>,
    private readonly fleet: FleetService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService
  ) {}

  sensitive(user: AuthUser): boolean {
    return can(user, 'devices:manage');
  }

  private async withTrucks(user: AuthUser, list: GpsDevice[]) {
    await this.fleet.thresholds();
    const truckIds = [...new Set(list.map(d => d.truckId).filter((x): x is string => !!x))];
    const trucks = truckIds.length ? await this.trucks.find({ where: { id: In(truckIds) } }) : [];
    const by = new Map(trucks.map(t => [t.id, t]));
    const sensitive = this.sensitive(user);
    return list.map(d => this.fleet.deviceToFrontend(d, { sensitive, truck: d.truckId ? by.get(d.truckId) ?? null : null }));
  }

  async list(user: AuthUser, q: GpsDeviceListQuery): Promise<Paged<any>> {
    const th = await this.fleet.thresholds();
    const { page, pageSize, skip, take } = pageParams(q);
    const qb = this.devices.createQueryBuilder('d');
    if (q.status) qb.andWhere('d.deviceStatus = :st', { st: q.status });
    if (q.assigned === 'true') qb.andWhere('d.truckId IS NOT NULL');
    if (q.assigned === 'false') qb.andWhere('d.truckId IS NULL');
    // IMEI search only for callers allowed to see IMEIs
    const searchCols = ['d.providerDeviceId', 'd.model', ...(this.sensitive(user) ? ['d.imei'] : [])];
    applySearch(qb, searchCols, q.q);
    if (q.connectivity) {
      const c = this.fleet.connectivitySql('d', q.connectivity, th);
      qb.andWhere(c.sql, c.params);
    }
    const [rows, total] = await qb.orderBy('d.createdAt', 'DESC').skip(skip).take(take).getManyAndCount();
    return { items: await this.withTrucks(user, rows), total, page, pageSize };
  }

  private async load(id: string): Promise<GpsDevice> {
    const d = await this.devices.findOne({ where: { id } });
    if (!d) throw Errors.notFound('GPS device');
    return d;
  }

  async get(user: AuthUser, id: string) {
    return (await this.withTrucks(user, [await this.load(id)]))[0];
  }

  private async assertUnique(provider: string, providerDeviceId?: string, imei?: string, excludeId?: string) {
    const ex = excludeId ? { id: Not(excludeId) } : {};
    if (providerDeviceId && await this.devices.exist({ where: { provider, providerDeviceId, ...ex } })) {
      throw Errors.conflict(`Device ${providerDeviceId} is already registered for provider ${provider}`);
    }
    if (imei && await this.devices.exist({ where: { imei, ...ex } })) throw Errors.conflict('A device with this IMEI is already registered');
  }

  async create(user: AuthUser, dto: CreateGpsDeviceDto, ctx: RequestContext) {
    const provider = (dto.provider || 'TRACCAR').toUpperCase();
    const providerDeviceId = dto.providerDeviceId.trim();
    await this.assertUnique(provider, providerDeviceId, dto.imei);
    try {
      const saved = await this.ds.transaction(async m => {
        const repo = m.getRepository(GpsDevice);
        const d = await repo.save(repo.create({
          provider, providerDeviceId, imei: dto.imei ?? null, model: dto.model ?? null, simNumber: dto.simNumber ?? null,
          truckId: null, deviceStatus: 'REGISTERED', connectivity: 'NEVER_SEEN'
        }));
        await this.audit.record(user, 'GPS_DEVICE_REGISTERED', d.id, { new: { provider, providerDeviceId, model: d.model, imei: maskId(d.imei), simNumber: maskId(d.simNumber) } }, ctx, m);
        return d;
      });
      return (await this.withTrucks(user, [saved]))[0];
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict('Device (provider id or IMEI) is already registered');
      throw e;
    }
  }

  async update(user: AuthUser, id: string, dto: UpdateGpsDeviceDto, ctx: RequestContext) {
    try {
      const saved = await this.ds.transaction(async m => {
        const repo = m.getRepository(GpsDevice);
        const d = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!d) throw Errors.notFound('GPS device');
        if (d.deviceStatus === 'RETIRED') throw Errors.conflict('Retired devices cannot be modified');
        const changes: Partial<GpsDevice> = {};
        if (dto.providerDeviceId !== undefined && dto.providerDeviceId.trim() !== d.providerDeviceId) changes.providerDeviceId = dto.providerDeviceId.trim();
        if (dto.imei !== undefined && dto.imei !== d.imei) changes.imei = dto.imei;
        if (dto.model !== undefined) changes.model = dto.model;
        if (dto.simNumber !== undefined && dto.simNumber !== d.simNumber) changes.simNumber = dto.simNumber;
        await this.assertUnique(d.provider, changes.providerDeviceId, changes.imei ?? undefined, id);
        const old = { providerDeviceId: d.providerDeviceId, model: d.model, imei: maskId(d.imei), simNumber: maskId(d.simNumber) };
        Object.assign(d, changes);
        await repo.save(d);
        const neu: Record<string, unknown> = { ...changes };
        if ('imei' in neu) neu.imei = maskId(changes.imei);
        if ('simNumber' in neu) neu.simNumber = maskId(changes.simNumber);
        await this.audit.record(user, 'GPS_DEVICE_UPDATED', id, { old, new: neu }, ctx, m);
        return d;
      });
      return (await this.withTrucks(user, [saved]))[0];
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict('Device (provider id or IMEI) is already registered');
      throw e;
    }
  }

  /** Pair device ↔ truck: one device per truck and one truck per device (409 otherwise). */
  async assignTruck(user: AuthUser, id: string, dto: AssignDeviceDto, ctx: RequestContext) {
    let saved: GpsDevice;
    let truck: Truck;
    try {
      ({ device: saved, truck } = await this.ds.transaction(async m => {
        const d = await m.getRepository(GpsDevice).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!d) throw Errors.notFound('GPS device');
        const t = await m.getRepository(Truck).findOne({ where: { id: dto.truckId }, lock: { mode: 'pessimistic_write' } });
        if (!t) throw Errors.notFound('Truck');
        if (d.deviceStatus === 'RETIRED') throw Errors.conflict('Retired devices cannot be assigned');
        if (d.truckId === t.id) throw Errors.conflict(`Device is already assigned to truck ${t.fleetCode}`);
        if (d.truckId) throw Errors.conflict('Device is already assigned to another truck — unassign it first', { truckId: d.truckId });
        const other = await m.getRepository(GpsDevice).findOne({ where: { truckId: t.id } });
        if (other) throw Errors.conflict(`Truck ${t.fleetCode} already has GPS device ${other.providerDeviceId} — unassign it first`, { deviceId: other.id });
        const now = new Date();
        // close any dangling open assignment of this device
        await m.getRepository(GpsDeviceAssignment).update({ deviceId: d.id, unassignedAt: IsNull() }, { unassignedAt: now, unassignedBy: user.name });
        await m.getRepository(GpsDeviceAssignment).save(m.getRepository(GpsDeviceAssignment).create({
          deviceId: d.id, truckId: t.id, assignedAt: now, assignedBy: user.name, reason: dto.reason
        }));
        d.truckId = t.id;
        d.deviceStatus = 'ACTIVE';
        await m.getRepository(GpsDevice).save(d);
        await this.audit.record(user, 'GPS_DEVICE_ASSIGNED', d.id, { old: { truckId: null }, new: { truckId: t.id, fleetCode: t.fleetCode }, reason: dto.reason }, ctx, m);
        return { device: d, truck: t };
      }));
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict('Truck already has a GPS device (concurrent assignment)');
      throw e;
    }
    await this.fleet.thresholds();
    this.realtime.publish('truck.device.status_changed', { truckId: truck.id, deviceId: saved.id }, {
      change: 'ASSIGNED', truckId: truck.id, fleetCode: truck.fleetCode, deviceId: saved.id, providerDeviceId: saved.providerDeviceId,
      deviceStatus: saved.deviceStatus, connectivity: this.fleet.deviceConnectivity(saved)
    });
    return (await this.withTrucks(user, [saved]))[0];
  }

  /** Unpair; 409 while the truck is on a trip unless force=true by ADMIN. */
  async unassign(user: AuthUser, id: string, dto: UnassignDeviceDto, ctx: RequestContext) {
    if (dto.force && user.role !== Role.ADMIN) throw Errors.forbidden('Only ADMIN may force-unassign a device from a truck on a trip');
    const { device, truck, forced } = await this.ds.transaction(async m => {
      const d = await m.getRepository(GpsDevice).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!d) throw Errors.notFound('GPS device');
      if (!d.truckId) throw Errors.conflict('Device is not assigned to a truck');
      const t = await m.getRepository(Truck).findOne({ where: { id: d.truckId }, lock: { mode: 'pessimistic_write' } });
      const onTrip = t?.availabilityStatus === 'ON_TRIP' || !!(await m.getRepository(Trip).findOne({ where: { truckId: d.truckId, status: In(MOVING_TRIP_STATES) } }));
      if (onTrip && !dto.force) throw Errors.conflict(`Truck ${t?.fleetCode ?? d.truckId} is on a trip — the device cannot be unassigned (ADMIN may force)`);
      const now = new Date();
      await m.getRepository(GpsDeviceAssignment).update({ deviceId: d.id, unassignedAt: IsNull() }, { unassignedAt: now, unassignedBy: user.name });
      const oldTruckId = d.truckId;
      d.truckId = null;
      if (d.deviceStatus === 'ACTIVE') d.deviceStatus = 'REGISTERED';
      await m.getRepository(GpsDevice).save(d);
      await this.audit.record(user, 'GPS_DEVICE_UNASSIGNED', d.id, { old: { truckId: oldTruckId, fleetCode: t?.fleetCode }, new: { truckId: null }, reason: dto.reason, forced: !!(onTrip && dto.force) }, ctx, m);
      return { device: d, truck: t, forced: !!(onTrip && dto.force) };
    });
    this.realtime.publish('truck.device.status_changed', { truckId: truck?.id ?? null, deviceId: device.id }, {
      change: 'UNASSIGNED', truckId: truck?.id ?? null, fleetCode: truck?.fleetCode ?? null, deviceId: device.id, providerDeviceId: device.providerDeviceId,
      deviceStatus: device.deviceStatus, forced
    });
    return (await this.withTrucks(user, [device]))[0];
  }

  async retire(user: AuthUser, id: string, dto: RetireDeviceDto, ctx: RequestContext) {
    const device = await this.ds.transaction(async m => {
      const d = await m.getRepository(GpsDevice).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!d) throw Errors.notFound('GPS device');
      if (d.deviceStatus === 'RETIRED') throw Errors.conflict('Device is already retired');
      if (d.truckId) throw Errors.conflict('Device is still assigned to a truck — unassign it before retiring', { truckId: d.truckId });
      const old = d.deviceStatus;
      d.deviceStatus = 'RETIRED';
      await m.getRepository(GpsDevice).save(d);
      await this.audit.record(user, 'GPS_DEVICE_RETIRED', d.id, { old: { deviceStatus: old }, new: { deviceStatus: 'RETIRED' }, reason: dto.reason }, ctx, m);
      return d;
    });
    this.realtime.publish('truck.device.status_changed', { deviceId: device.id }, { change: 'RETIRED', deviceId: device.id, providerDeviceId: device.providerDeviceId, deviceStatus: 'RETIRED' });
    return (await this.withTrucks(user, [device]))[0];
  }

  /** Diagnostics: connectivity, last seen, positions (24 h), out-of-order count, recent rejections, assignment history. */
  async diagnostics(user: AuthUser, id: string) {
    const d = await this.load(id);
    await this.fleet.thresholds();
    const since = new Date(Date.now() - 24 * 3600_000);
    const [positions24h, outOfOrder24h, outOfOrderTotal, rejections, rejections24h, history] = await Promise.all([
      this.locations.count({ where: { deviceId: d.id, receivedAt: MoreThanOrEqual(since) } }),
      this.locations.count({ where: { deviceId: d.id, receivedAt: MoreThanOrEqual(since), outOfOrder: true } }),
      this.locations.count({ where: { deviceId: d.id, outOfOrder: true } }),
      this.rejections.find({ where: { providerDeviceId: d.providerDeviceId }, order: { receivedAt: 'DESC' }, take: 20 }),
      this.rejections.count({ where: { providerDeviceId: d.providerDeviceId, receivedAt: MoreThanOrEqual(since) } }),
      this.assignments.find({ where: { deviceId: d.id }, order: { assignedAt: 'DESC' }, take: 50 })
    ]);
    const truckIds = [...new Set(history.map(h => h.truckId))];
    const trucks = truckIds.length ? await this.trucks.find({ where: { id: In(truckIds) } }) : [];
    const tBy = new Map(trucks.map(t => [t.id, t]));
    const activeTrip = d.truckId ? await this.ds.getRepository(Trip).findOne({ where: { truckId: d.truckId, status: In(ACTIVE_TRIP_STATES) }, order: { createdAt: 'DESC' } }) : null;
    const sensitive = this.sensitive(user);
    return {
      device: this.fleet.deviceToFrontend(d, { sensitive, truck: d.truckId ? tBy.get(d.truckId) ?? (await this.trucks.findOne({ where: { id: d.truckId } })) : null }),
      connectivity: d.deviceStatus === 'RETIRED' ? d.connectivity : this.fleet.deviceConnectivity(d),
      storedConnectivity: d.connectivity,
      lastSeenAt: iso(d.lastSeenAt),
      lastPositionRecordedAt: iso(d.lastPositionRecordedAt),
      secondsSinceLastSeen: d.lastSeenAt ? Math.round((Date.now() - d.lastSeenAt.getTime()) / 1000) : null,
      positionsLast24h: positions24h,
      outOfOrderLast24h: outOfOrder24h,
      outOfOrderTotal,
      rejectionsLast24h: rejections24h,
      recentRejections: rejections.map(r => ({ id: r.id, source: r.source, reason: r.reason, receivedAt: iso(r.receivedAt), ...(sensitive ? { payload: r.payload } : {}) })),
      activeTrip: this.fleet.tripSummary(activeTrip),
      assignmentHistory: history.map(h => ({
        id: h.id, truckId: h.truckId, fleetCode: tBy.get(h.truckId)?.fleetCode ?? null, plateNumber: tBy.get(h.truckId)?.plateNumber ?? null,
        assignedAt: iso(h.assignedAt), assignedBy: h.assignedBy, unassignedAt: iso(h.unassignedAt), unassignedBy: h.unassignedBy, reason: h.reason
      }))
    };
  }
}
