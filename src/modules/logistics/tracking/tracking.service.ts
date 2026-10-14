import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Not, Repository } from 'typeorm';
import { Errors } from '../../../common/utils/errors';
import { isValidCoordinate } from '../../../common/utils/geo';
import { ACTIVE_TRIP_STATES, MOVING_TRIP_STATES } from '../../../common/utils/state-machine';
import { AlertsService } from '../../alerts/alerts.service';
import { Driver } from '../drivers/entities/driver.entities';
import { GpsDevice, GpsIngestRejection, Truck, TruckLocation } from '../fleet/entities/fleet.entities';
import { FleetService } from '../fleet/fleet.service';
import { QUEUES, JobsService } from '../jobs/jobs.service';
import { HotStateService } from '../jobs/hot-state.service';
import { LogisticsThresholds } from '../logistics.constants';
import { RealtimeEntities, RealtimeService } from '../realtime/realtime.service';
import { TrackingEvent } from '../routing/entities/routing.entities';
import { Shipment, Trip, TripShipment } from '../shipments/entities/shipment.entities';
import { IngestResult, NormalizedPosition, PositionProcessedEvent, PositionSource, TRACKING_POSITION_JOB } from './tracking.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUniqueViolation = (e: any) => e?.code === '23505' || e?.driverError?.code === '23505';
const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
/** Below this speed the truck is considered stationary (stationarySince) */
const STATIONARY_KMH = 3;
/** Realtime throttle: at most one truck.location.updated per truck per second */
const REALTIME_THROTTLE_SECONDS = 1;
const FLEET_GPS = 'Fleet & GPS';

interface AcceptedPoint {
  truckId: string;
  deviceId: string | null;
  tripId: string | null;
  locationId: string;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  heading: number | null;
  recordedAt: Date;
  receivedAt: Date;
  source: PositionSource;
}

interface OneResult {
  result: IngestResult;
  accepted?: AcceptedPoint;
  connectivityChanged?: { device: GpsDevice; from: string };
}

/**
 * GPS tracking ingestion (Logistics doc §11): normalised positions from the Traccar adapter, partner feeds, the simulator
 * or manual pushes → validation → idempotent persistence (history + current state) → hot cache → realtime → TRACKING queue.
 */
@Injectable()
export class TrackingService {
  private readonly logger = new Logger('Tracking');
  private scanning = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Truck) private readonly trucks: Repository<Truck>,
    @InjectRepository(GpsDevice) private readonly devices: Repository<GpsDevice>,
    @InjectRepository(TruckLocation) private readonly locations: Repository<TruckLocation>,
    @InjectRepository(GpsIngestRejection) private readonly rejections: Repository<GpsIngestRejection>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(TripShipment) private readonly tripShipments: Repository<TripShipment>,
    @InjectRepository(Shipment) private readonly shipments: Repository<Shipment>,
    @InjectRepository(Driver) private readonly drivers: Repository<Driver>,
    @InjectRepository(TrackingEvent) private readonly events: Repository<TrackingEvent>,
    private readonly fleet: FleetService,
    private readonly alerts: AlertsService,
    private readonly realtime: RealtimeService,
    private readonly jobs: JobsService,
    private readonly hot: HotStateService,
    private readonly config: ConfigService
  ) {}

  // =====================================================================================================
  // Ingestion (contract)
  // =====================================================================================================

  /**
   * Ingest a batch of normalised positions. Processed in recordedAt order; results are returned in INPUT order.
   * Every valid point is persisted; realtime publishes are throttled per truck (≤ 1/s, latest point of the batch).
   */
  async ingest(positions: NormalizedPosition[], source: PositionSource): Promise<IngestResult[]> {
    if (!Array.isArray(positions) || !positions.length) return [];
    const th = await this.fleet.thresholds();
    const time = (p: NormalizedPosition) => {
      const t = p?.recordedAt ? new Date(p.recordedAt).getTime() : NaN;
      return Number.isFinite(t) ? t : 0;
    };
    const order = positions.map((p, i) => ({ p, i })).sort((a, b) => time(a.p) - time(b.p) || a.i - b.i);
    const results: IngestResult[] = new Array(positions.length);
    const tripCache = new Map<string, Trip | null>();
    const latest = new Map<string, AcceptedPoint>();

    for (const { p, i } of order) {
      let r: OneResult;
      try {
        r = await this.ingestOne(p, source, th, tripCache);
      } catch (e) {
        this.logger.error(`Position ingestion failed (${source}): ${(e as Error)?.message}`);
        r = { result: { status: 'REJECTED', reason: 'PROCESSING_ERROR' } };
      }
      results[i] = r.result;
      if (r.connectivityChanged) this.publishDeviceStatus(r.connectivityChanged.device, r.connectivityChanged.from, 'ONLINE');
      if (r.accepted) {
        const a = r.accepted;
        latest.set(a.truckId, a);
        await this.hot.setJson(`truck:pos:${a.truckId}`, {
          truckId: a.truckId, deviceId: a.deviceId, tripId: a.tripId, locationId: a.locationId, lat: a.latitude, lng: a.longitude,
          speedKmh: a.speedKmh, heading: a.heading, recordedAt: a.recordedAt.toISOString(), receivedAt: a.receivedAt.toISOString(), source: a.source
        });
        const event: PositionProcessedEvent = {
          truckId: a.truckId, deviceId: a.deviceId, tripId: a.tripId, locationId: a.locationId, latitude: a.latitude, longitude: a.longitude,
          speedKmh: a.speedKmh, heading: a.heading, recordedAt: a.recordedAt.toISOString()
        };
        try {
          await this.jobs.dispatch(QUEUES.TRACKING, TRACKING_POSITION_JOB, event, { jobId: `pos-${a.locationId}` });
        } catch (e) {
          // the position is persisted; processing can be replayed from history
          this.logger.error(`Could not enqueue position ${a.locationId}: ${(e as Error)?.message}`);
        }
      }
    }

    for (const a of latest.values()) {
      try {
        if (await this.hot.setOnce(`rt:truck-pos:${a.truckId}`, REALTIME_THROTTLE_SECONDS)) await this.publishLocation(a);
      } catch (e) {
        this.logger.warn(`Realtime publish failed for truck ${a.truckId}: ${(e as Error)?.message}`);
      }
    }
    return results;
  }

  private async reject(source: PositionSource, p: NormalizedPosition, reason: string, truckId?: string): Promise<OneResult> {
    try {
      await this.rejections.insert({
        source,
        providerDeviceId: p?.providerDeviceId ? String(p.providerDeviceId).slice(0, 60) : null,
        reason,
        payload: {
          provider: p?.provider ?? null, providerDeviceId: p?.providerDeviceId ?? null, truckId: p?.truckId ?? null, providerPositionId: p?.providerPositionId ?? null,
          latitude: p?.latitude ?? null, longitude: p?.longitude ?? null, speedKmh: p?.speedKmh ?? null, heading: p?.heading ?? null,
          recordedAt: p?.recordedAt ? String(p.recordedAt instanceof Date && !Number.isNaN(p.recordedAt.getTime()) ? p.recordedAt.toISOString() : p.recordedAt) : null,
          attributes: p?.attributes ?? null
        } as any
      });
    } catch (e) {
      this.logger.warn(`Could not record GPS rejection: ${(e as Error)?.message}`);
    }
    return { result: { status: 'REJECTED', reason, ...(truckId ? { truckId } : {}) } };
  }

  private async activeTrip(truckId: string, cache?: Map<string, Trip | null>, manager?: EntityManager): Promise<Trip | null> {
    if (cache?.has(truckId)) return cache.get(truckId)!;
    const trip = await (manager ?? this.ds.manager).getRepository(Trip).findOne({ where: { truckId, status: In(ACTIVE_TRIP_STATES) }, order: { createdAt: 'DESC' } });
    cache?.set(truckId, trip);
    return trip;
  }

  private async ingestOne(p: NormalizedPosition, source: PositionSource, th: LogisticsThresholds, tripCache: Map<string, Trip | null>): Promise<OneResult> {
    if (!p || typeof p !== 'object') return this.reject(source, p, 'INVALID_PAYLOAD');
    const provider = (p.provider || 'TRACCAR').toUpperCase();
    const providerDeviceId = p.providerDeviceId !== undefined && p.providerDeviceId !== null && String(p.providerDeviceId).trim() !== '' ? String(p.providerDeviceId).trim() : null;

    // 1. Resolve device → truck (or truck directly)
    let device: GpsDevice | null = null;
    let truckId: string;
    if (providerDeviceId) {
      device = await this.devices.findOne({ where: { provider, providerDeviceId } });
      if (!device) {
        const r = await this.reject(source, p, 'UNKNOWN_DEVICE');
        await this.unknownDeviceAlert(provider, providerDeviceId);
        return r;
      }
      if (device.deviceStatus === 'RETIRED') return this.reject(source, p, 'DEVICE_RETIRED');
      if (!device.truckId) return this.reject(source, p, 'DEVICE_UNASSIGNED');
      truckId = device.truckId;
    } else if (p.truckId) {
      if (!UUID_RE.test(String(p.truckId)) || !(await this.trucks.exist({ where: { id: String(p.truckId) } }))) return this.reject(source, p, 'UNKNOWN_TRUCK');
      truckId = String(p.truckId);
      device = await this.devices.findOne({ where: { truckId, deviceStatus: Not('RETIRED') } });
    } else {
      return this.reject(source, p, 'UNKNOWN_DEVICE');
    }

    // 2. Validate coordinates & timestamp
    if (!isValidCoordinate(p.latitude, p.longitude)) return this.reject(source, p, 'INVALID_COORDINATES', truckId);
    const recordedAt = p.recordedAt instanceof Date ? p.recordedAt : new Date(p.recordedAt as unknown as string);
    const now = new Date();
    if (Number.isNaN(recordedAt.getTime())
      || recordedAt.getTime() > now.getTime() + th.maxFutureSkewMinutes * 60_000
      || recordedAt.getTime() < now.getTime() - th.maxPositionAgeHours * 3600_000) {
      return this.reject(source, p, 'INVALID_TIMESTAMP', truckId);
    }
    const speed = typeof p.speedKmh === 'number' && Number.isFinite(p.speedKmh) && p.speedKmh >= 0 && p.speedKmh < 400 ? Math.round(p.speedKmh * 100) / 100 : null;
    const heading = typeof p.heading === 'number' && Number.isFinite(p.heading) ? ((p.heading % 360) + 360) % 360 : null;
    const providerPositionId = p.providerPositionId !== undefined && p.providerPositionId !== null && String(p.providerPositionId) !== '' ? String(p.providerPositionId).slice(0, 60) : null;

    // 3. Idempotency (cheap pre-check; the partial unique indexes are the final guard)
    // Same truck + same fix time is the same fix whatever the channel (webhook push without id, poller pull with id).
    const dupWhere = providerPositionId
      ? [device ? { deviceId: device.id, providerPositionId } : { truckId, deviceId: IsNull(), providerPositionId }, { truckId, recordedAt }]
      : { truckId, recordedAt };
    const dup = await this.locations.findOne({ where: dupWhere, select: { id: true } });
    if (dup) return { result: { status: 'DUPLICATE', truckId, locationId: dup.id } };

    // 4. Persist (device and truck rows locked → per-truck serialisation; same lock order as device pairing)
    const trip = await this.activeTrip(truckId, tripCache);
    try {
      return await this.ds.transaction(async m => {
        const lockedDevice = device ? await m.getRepository(GpsDevice).findOne({ where: { id: device.id }, lock: { mode: 'pessimistic_write' } }) : null;
        const truck = await m.getRepository(Truck).findOne({ where: { id: truckId }, lock: { mode: 'pessimistic_write' } });
        if (!truck) throw Errors.notFound('Truck');
        if (lockedDevice && lockedDevice.truckId !== truckId && providerDeviceId) {
          // device re-paired between lookup and lock
          throw Object.assign(new Error('DEVICE_REASSIGNED'), { code: 'DEVICE_REASSIGNED' });
        }
        const lastTimes = [lockedDevice?.lastPositionRecordedAt, truck.lastPositionAt].filter((d): d is Date => !!d).map(d => new Date(d).getTime());
        const last = lastTimes.length ? Math.max(...lastTimes) : null;
        const outOfOrder = last !== null && recordedAt.getTime() <= last;
        const receivedAt = new Date();

        const loc = await m.getRepository(TruckLocation).save(m.getRepository(TruckLocation).create({
          truckId, deviceId: lockedDevice?.id ?? null, tripId: trip?.id ?? null, latitude: p.latitude, longitude: p.longitude,
          speedKmh: speed, heading, recordedAt, receivedAt, source, providerPositionId, outOfOrder, attributes: p.attributes ?? null
        }));

        let connectivityChanged: OneResult['connectivityChanged'];
        if (lockedDevice) {
          const from = lockedDevice.connectivity;
          const patch: Partial<GpsDevice> = { lastSeenAt: receivedAt, connectivity: 'ONLINE' };
          if (!outOfOrder) patch.lastPositionRecordedAt = recordedAt;
          if (lockedDevice.deviceStatus !== 'ACTIVE') patch.deviceStatus = 'ACTIVE';
          await m.getRepository(GpsDevice).update({ id: lockedDevice.id }, patch);
          Object.assign(lockedDevice, patch);
          if (from !== 'ONLINE') {
            await m.getRepository(TrackingEvent).insert({
              type: 'DEVICE_ONLINE', truckId, tripId: trip?.id ?? null, shipmentId: null, deviceId: lockedDevice.id,
              payload: { from, source }, dedupeKey: null, occurredAt: receivedAt
            });
            connectivityChanged = { device: lockedDevice, from };
          }
        }

        if (outOfOrder) {
          return { result: { status: 'OUT_OF_ORDER' as const, truckId, locationId: loc.id }, connectivityChanged };
        }

        const truckPatch: Partial<Truck> = { lastLat: p.latitude, lastLng: p.longitude, lastSpeedKmh: speed, lastHeading: heading, lastPositionAt: recordedAt };
        if (speed !== null) {
          if (speed < STATIONARY_KMH) { if (!truck.stationarySince) truckPatch.stationarySince = recordedAt; }
          else truckPatch.stationarySince = null;
        }
        await m.getRepository(Truck).update({ id: truckId }, truckPatch);

        return {
          result: { status: 'ACCEPTED' as const, truckId, locationId: loc.id },
          accepted: { truckId, deviceId: lockedDevice?.id ?? null, tripId: trip?.id ?? null, locationId: loc.id, latitude: p.latitude, longitude: p.longitude, speedKmh: speed, heading, recordedAt, receivedAt, source },
          connectivityChanged
        };
      });
    } catch (e) {
      if (isUniqueViolation(e)) return { result: { status: 'DUPLICATE', truckId } };
      if ((e as any)?.code === 'DEVICE_REASSIGNED') return this.reject(source, p, 'DEVICE_UNASSIGNED');
      throw e;
    }
  }

  /** LOW_BLUE alert for an unregistered device (deduplicated per provider device per day). */
  private async unknownDeviceAlert(provider: string, providerDeviceId: string) {
    const day = new Date().toISOString().slice(0, 10);
    const dedupeKey = `gps-unknown-device:${provider}:${providerDeviceId}:${day}`.slice(0, 160);
    try {
      if (!(await this.hot.setOnce(`alert-gate:${dedupeKey}`, 3600))) return;
      if (await this.alerts.repo.exist({ where: { dedupeKey } })) return;
      const alert = await this.alerts.raise({
        severity: 'LOW_BLUE',
        title: `Unregistered GPS device ${providerDeviceId} is reporting`,
        category: FLEET_GPS,
        trigger: `Positions received from ${provider} device ${providerDeviceId}, which is not registered in the fleet device registry`,
        affectedArea: 'Fleet GPS registry',
        actionRequired: 'Register the device and pair it with a truck, or remove it from the GPS platform',
        sourceType: 'GPS_DEVICE',
        sourceId: providerDeviceId.slice(0, 80),
        dedupeKey
      });
      this.realtime.publish('alert.created', { alertId: alert.id }, alert);
    } catch (e) {
      if (!isUniqueViolation(e)) this.logger.warn(`Unknown-device alert failed: ${(e as Error)?.message}`);
    }
  }

  /** Entities for realtime routing: trip, shipments, driver, origin/destination warehouses. */
  private async tripEntities(tripId: string | null): Promise<{ trip: Trip | null; shipmentIds: string[]; warehouseIds: string[]; driverId: string | null }> {
    if (!tripId) return { trip: null, shipmentIds: [], warehouseIds: [], driverId: null };
    const trip = await this.trips.findOne({ where: { id: tripId } });
    const links = await this.tripShipments.find({ where: { tripId } });
    const shipmentIds = links.map(l => l.shipmentId);
    const ships = shipmentIds.length ? await this.shipments.find({ where: { id: In(shipmentIds) }, select: { id: true, originWarehouseId: true, destinationWarehouseId: true } }) : [];
    const warehouseIds = [...new Set(ships.flatMap(s => [s.originWarehouseId, s.destinationWarehouseId]).filter(Boolean))];
    return { trip, shipmentIds, warehouseIds, driverId: trip?.primaryDriverId ?? null };
  }

  private async publishLocation(a: AcceptedPoint) {
    const ctx = await this.tripEntities(a.tripId);
    const truck = await this.trucks.findOne({ where: { id: a.truckId }, select: { id: true, fleetCode: true, plateNumber: true, stationarySince: true } });
    const entities: RealtimeEntities = { truckId: a.truckId, tripId: a.tripId, deviceId: a.deviceId, shipmentIds: ctx.shipmentIds, driverId: ctx.driverId, warehouseIds: ctx.warehouseIds };
    this.realtime.publish('truck.location.updated', entities, {
      truckId: a.truckId, fleetCode: truck?.fleetCode ?? null, plateNumber: truck?.plateNumber ?? null, tripId: a.tripId, deviceId: a.deviceId,
      locationId: a.locationId, lat: a.latitude, lng: a.longitude, speedKmh: a.speedKmh, heading: a.heading,
      recordedAt: a.recordedAt.toISOString(), receivedAt: a.receivedAt.toISOString(), stationarySince: iso(truck?.stationarySince), connectivity: 'ONLINE', source: a.source
    });
  }

  private publishDeviceStatus(device: GpsDevice, from: string, to: string, extra: Record<string, unknown> = {}) {
    try {
      this.realtime.publish('truck.device.status_changed', { truckId: device.truckId, deviceId: device.id }, {
        change: 'CONNECTIVITY', deviceId: device.id, providerDeviceId: device.providerDeviceId, truckId: device.truckId,
        from, to, connectivity: to, lastSeenAt: iso(device.lastSeenAt), ...extra
      });
    } catch (e) {
      this.logger.warn(`Realtime publish failed: ${(e as Error)?.message}`);
    }
  }

  // =====================================================================================================
  // Current positions (contract) & views
  // =====================================================================================================

  /** Latest known position per truck (trucks that have reported at least once), with connectivity, active trip, shipments, driver. */
  async currentPositions(filter?: { truckIds?: string[] }): Promise<any[]> {
    const th = await this.fleet.thresholds();
    if (filter?.truckIds && !filter.truckIds.length) return [];
    const qb = this.trucks.createQueryBuilder('t').where('t.lastLat IS NOT NULL AND t.lastLng IS NOT NULL');
    if (filter?.truckIds) qb.andWhere('t.id IN (:...ids)', { ids: filter.truckIds });
    const trucks = await qb.orderBy('t.fleetCode', 'ASC').getMany();
    if (!trucks.length) return [];
    const ids = trucks.map(t => t.id);
    const [devices, trips] = await Promise.all([
      this.devices.find({ where: { truckId: In(ids) } }),
      this.trips.find({ where: { truckId: In(ids), status: In(ACTIVE_TRIP_STATES) }, order: { createdAt: 'DESC' } })
    ]);
    const devBy = new Map(devices.map(d => [d.truckId!, d]));
    const tripBy = new Map<string, Trip>();
    for (const tr of trips) if (!tripBy.has(tr.truckId)) tripBy.set(tr.truckId, tr);
    const tripIds = [...tripBy.values()].map(t => t.id);
    const links = tripIds.length ? await this.tripShipments.find({ where: { tripId: In(tripIds) } }) : [];
    const ships = links.length ? await this.shipments.find({ where: { id: In([...new Set(links.map(l => l.shipmentId))]) } }) : [];
    const shipBy = new Map(ships.map(s => [s.id, s]));
    const driverIds = [...new Set([...tripBy.values()].map(t => t.primaryDriverId))];
    const drivers = driverIds.length ? await this.drivers.find({ where: { id: In(driverIds) } }) : [];
    const driverBy = new Map(drivers.map(d => [d.id, d]));

    return trucks.map(t => {
      const device = devBy.get(t.id) ?? null;
      const trip = tripBy.get(t.id) ?? null;
      const driver = trip ? driverBy.get(trip.primaryDriverId) ?? null : null;
      const pos = this.fleet.lastPositionOf(t)!;
      const tripShips = trip ? links.filter(l => l.tripId === trip.id).sort((a, b) => a.stopSequence - b.stopSequence).map(l => shipBy.get(l.shipmentId)).filter((s): s is Shipment => !!s) : [];
      return {
        truckId: t.id,
        fleetCode: t.fleetCode,
        plateNumber: t.plateNumber,
        operationalStatus: t.operationalStatus,
        availabilityStatus: t.availabilityStatus,
        lat: pos.lat,
        lng: pos.lng,
        speedKmh: pos.speedKmh,
        heading: pos.heading,
        recordedAt: pos.recordedAt,
        ageSeconds: pos.ageSeconds,
        stale: pos.ageSeconds === null ? true : pos.ageSeconds > th.gpsStaleMinutes * 60,
        stationarySince: iso(t.stationarySince),
        connectivity: device ? this.fleet.deviceConnectivity(device) : 'NO_DEVICE',
        device: device ? { id: device.id, providerDeviceId: device.providerDeviceId, deviceStatus: device.deviceStatus, lastSeenAt: iso(device.lastSeenAt) } : null,
        trip: this.fleet.tripSummary(trip),
        shipments: tripShips.map(s => ({
          id: s.id, shipmentNumber: s.shipmentNumber, status: s.status, isDelayed: s.isDelayed, cargoDescription: s.cargoDescription,
          plannedQuantity: s.plannedQuantity, quantityUnit: s.quantityUnit, originWarehouseId: s.originWarehouseId, destinationWarehouseId: s.destinationWarehouseId,
          estimatedArrivalAt: iso(s.estimatedArrivalAt)
        })),
        driver: driver ? { id: driver.id, name: `${driver.firstName} ${driver.lastName}`, employeeNumber: driver.employeeNumber, phone: driver.phone } : null
      };
    });
  }

  /** Current state + last 50 points of one truck. */
  async truckTracking(truckId: string) {
    const truck = await this.fleet.getTruck(truckId);
    const [current] = await this.currentPositions({ truckIds: [truckId] });
    const points = await this.locations.find({ where: { truckId }, order: { recordedAt: 'DESC', id: 'DESC' }, take: 50 });
    return { truck, current: current ?? null, points: points.map(l => this.fleet.locationToFrontend(l)) };
  }

  async resolveTruck(ref: { truckId?: string; fleetCode?: string }): Promise<Truck> {
    const t = ref.truckId
      ? await this.trucks.findOne({ where: { id: ref.truckId } })
      : ref.fleetCode ? await this.trucks.findOne({ where: { fleetCode: ref.fleetCode.toUpperCase() } }) : null;
    if (!ref.truckId && !ref.fleetCode) throw Errors.unprocessable('truckId or fleetCode is required', [{ field: 'truckId', message: 'truckId or fleetCode is required' }]);
    if (!t) throw Errors.notFound('Truck');
    return t;
  }

  // =====================================================================================================
  // GPS platform device events (Traccar event forwarding)
  // =====================================================================================================

  async providerDeviceEvent(input: {
    provider: string; providerDeviceId: string | null; type: 'DEVICE_OFFLINE' | 'DEVICE_ONLINE' | 'DEVICE_STALE'; occurredAt: Date; externalId?: string | null; raw?: Record<string, unknown>;
  }): Promise<{ status: 'RECORDED' | 'DUPLICATE' | 'IGNORED'; reason?: string; deviceId?: string }> {
    if (!input.providerDeviceId) return { status: 'IGNORED', reason: 'NO_DEVICE_ID' };
    const device = await this.devices.findOne({ where: { provider: input.provider, providerDeviceId: input.providerDeviceId } });
    if (!device) return { status: 'IGNORED', reason: 'UNKNOWN_DEVICE' };
    if (device.deviceStatus === 'RETIRED') return { status: 'IGNORED', reason: 'DEVICE_RETIRED', deviceId: device.id };
    const occurredAt = Number.isNaN(input.occurredAt.getTime()) ? new Date() : input.occurredAt;
    const dedupeKey = (input.externalId ? `${input.provider}-event:${input.externalId}` : `${input.type}:${device.id}:${occurredAt.getTime()}`).slice(0, 160);
    const trip = device.truckId ? await this.activeTrip(device.truckId) : null;
    const ins = await this.events.createQueryBuilder().insert().into(TrackingEvent).values({
      type: input.type, truckId: device.truckId, tripId: trip?.id ?? null, shipmentId: null, deviceId: device.id,
      payload: { source: input.provider, ...(input.raw ?? {}) }, dedupeKey, occurredAt
    }).orIgnore().execute();
    // ON CONFLICT DO NOTHING → no RETURNING row when the dedupe key already exists
    if (Array.isArray(ins.raw) ? ins.raw.length === 0 : !ins.identifiers[0]?.id) return { status: 'DUPLICATE', deviceId: device.id };

    const target = input.type === 'DEVICE_OFFLINE' ? 'OFFLINE' : input.type === 'DEVICE_STALE' ? 'STALE' : null;
    // Trackers close their TCP link between sends (Teltonika "open link timeout"), and the platform reports that as
    // offline. While the device has reported within the stale threshold, the event is recorded but connectivity is
    // left to the time-based scan, so a normal reconnect cycle never flaps the status or raises an offline alert.
    if (target && device.lastSeenAt) {
      const th = await this.fleet.thresholds();
      const silentMs = occurredAt.getTime() - new Date(device.lastSeenAt).getTime();
      if (silentMs < th.gpsStaleMinutes * 60_000) return { status: 'RECORDED', reason: 'RECENTLY_SEEN', deviceId: device.id };
    }
    if (target && device.connectivity !== target && !(target === 'STALE' && device.connectivity === 'OFFLINE')) {
      const from = device.connectivity;
      await this.devices.update({ id: device.id }, { connectivity: target });
      device.connectivity = target;
      this.publishDeviceStatus(device, from, target, { reportedBy: input.provider });
      if (target === 'OFFLINE') await this.offlineTripAlert(device);
    }
    return { status: 'RECORDED', deviceId: device.id };
  }

  // =====================================================================================================
  // Stale / offline detection (telemetry only — the truck's operational status is never changed)
  // =====================================================================================================

  @Interval('tracking-connectivity-scan', 60_000)
  async scheduledConnectivityScan() {
    if (!this.config.get<boolean>('schedulerEnabled')) return;
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.runConnectivityScan();
    } catch (e) {
      this.logger.error(`Connectivity scan failed: ${(e as Error)?.message}`);
    } finally {
      this.scanning = false;
    }
  }

  /** ONLINE → STALE after gpsStaleMinutes, → OFFLINE after gpsOfflineMinutes (TrackingEvent + realtime + alert for moving trips). */
  async runConnectivityScan(): Promise<{ checked: number; stale: number; offline: number }> {
    const th = await this.fleet.thresholds(true);
    const now = Date.now();
    const candidates = await this.devices.find({ where: { connectivity: In(['ONLINE', 'STALE']), deviceStatus: Not('RETIRED'), lastSeenAt: Not(IsNull()) } });
    let stale = 0, offline = 0;
    for (const d of candidates) {
      const ageMin = (now - d.lastSeenAt!.getTime()) / 60_000;
      const target = ageMin > th.gpsOfflineMinutes ? 'OFFLINE' : ageMin > th.gpsStaleMinutes ? 'STALE' : 'ONLINE';
      if (target === 'ONLINE' || target === d.connectivity) continue;
      // conditional update: a position accepted meanwhile (new lastSeenAt) wins
      const res = await this.devices.createQueryBuilder().update(GpsDevice).set({ connectivity: target })
        .where('id = :id AND last_seen_at = :seen AND connectivity = :from', { id: d.id, seen: d.lastSeenAt, from: d.connectivity }).execute();
      if (!res.affected) continue;
      const from = d.connectivity;
      d.connectivity = target;
      const trip = d.truckId ? await this.activeTrip(d.truckId) : null;
      const type = target === 'OFFLINE' ? 'DEVICE_OFFLINE' : 'DEVICE_STALE';
      await this.events.createQueryBuilder().insert().into(TrackingEvent).values({
        type, truckId: d.truckId, tripId: trip?.id ?? null, shipmentId: null, deviceId: d.id,
        payload: { from, lastSeenAt: d.lastSeenAt!.toISOString(), minutesSinceLastSeen: Math.round(ageMin) },
        dedupeKey: `${type}:${d.id}:${d.lastSeenAt!.getTime()}`, occurredAt: new Date()
      }).orIgnore().execute();
      this.publishDeviceStatus(d, from, target);
      if (target === 'OFFLINE') { offline++; await this.offlineTripAlert(d); } else stale++;
    }
    return { checked: candidates.length, stale, offline };
  }

  /** MEDIUM_YELLOW alert when an OFFLINE device belongs to a truck on a moving trip (deduplicated per trip/device/lastSeenAt). */
  private async offlineTripAlert(device: GpsDevice) {
    if (!device.truckId) return;
    try {
      const trip = await this.trips.findOne({ where: { truckId: device.truckId, status: In(MOVING_TRIP_STATES) }, order: { createdAt: 'DESC' } });
      if (!trip) return;
      const truck = await this.trucks.findOne({ where: { id: device.truckId } });
      const seen = device.lastSeenAt ? device.lastSeenAt.getTime() : 0;
      const dedupeKey = `gps-offline:${trip.id}:${device.id}:${seen}`;
      if (await this.alerts.repo.exist({ where: { dedupeKey } })) return;
      const alert = await this.alerts.raise({
        severity: 'MEDIUM_YELLOW',
        title: `GPS offline: ${truck?.fleetCode ?? device.truckId} on trip ${trip.tripNumber}`,
        category: FLEET_GPS,
        trigger: `No GPS data from device ${device.providerDeviceId} since ${device.lastSeenAt ? device.lastSeenAt.toISOString() : 'never'} while trip ${trip.tripNumber} is ${trip.status}`,
        affectedArea: truck ? `${truck.fleetCode} (${truck.plateNumber})` : null,
        actionRequired: 'Contact the driver and check the tracking device / GSM coverage',
        sourceType: 'TRIP',
        sourceId: trip.id,
        dedupeKey
      });
      const ctx = await this.tripEntities(trip.id);
      this.realtime.publish('alert.created', {
        alertId: alert.id, truckId: device.truckId, tripId: trip.id, deviceId: device.id, shipmentIds: ctx.shipmentIds, driverId: ctx.driverId, warehouseIds: ctx.warehouseIds
      }, alert);
    } catch (e) {
      if (!isUniqueViolation(e)) this.logger.warn(`GPS offline alert failed: ${(e as Error)?.message}`);
    }
  }
}
