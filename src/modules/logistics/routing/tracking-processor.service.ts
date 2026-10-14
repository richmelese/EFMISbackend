import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { distanceToPolylineKm, haversineKm, LatLng, pointInPolygon, remainingAlongPolylineKm } from '../../../common/utils/geo';
import { round } from '../../../common/utils/helpers';
import { MOVING_TRIP_STATES } from '../../../common/utils/state-machine';
import { AlertsService, RaiseAlertInput } from '../../alerts/alerts.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { SettingsService } from '../../settings/settings.service';
import { Truck, TruckLocation } from '../fleet/entities/fleet.entities';
import { HotStateService } from '../jobs/hot-state.service';
import { JobsService, QUEUES } from '../jobs/jobs.service';
import { LogisticsThresholds, logisticsThresholds } from '../logistics.constants';
import { RealtimeEntities, RealtimeService } from '../realtime/realtime.service';
import { Shipment, Trip, TripShipment } from '../shipments/entities/shipment.entities';
import { TripsService } from '../shipments/trips.service';
import { PositionProcessedEvent, TRACKING_POSITION_JOB } from '../tracking/tracking.types';
import { Warehouse } from '../warehouses/entities/warehouse.entities';
import { Geofence, GeofenceEvent, GeofenceState, Route, RouteMilestone, TrackingEvent, TripMilestone } from './entities/routing.entities';
import { RouteEstimatorService } from './route-estimator.service';

/** Work executed only after the processing transaction committed (realtime pushes, trip status changes). */
type PostAction = () => Promise<unknown> | unknown;

interface TripContext {
  trip: Trip;
  truck: Truck;
  shipments: Shipment[];
  links: TripShipment[];
  route: Route | null;
  entities: RealtimeEntities;
}

export interface EtaResult {
  estimatedArrivalAt: Date | null;
  remainingDistanceKm: number | null;
}

const GEOFENCE_CACHE_MS = 60_000;
const PROCESSED_MARKER_TTL_S = 2 * 24 * 3600;
const FIRST_MOVEMENT_KMH = 5;
const SPEED_WINDOW_MIN = 30;
/** Shipments still travelling (eligible for ETA / delay evaluation) */
const CLOSED_SHIPMENT_STATES = ['ARRIVED', 'DELIVERED', 'CLOSED', 'CANCELLED', 'DRAFT', 'PLANNED'];
const DEPOT_KINDS = ['WAREHOUSE', 'DEPOT'];

const isUniqueViolation = (err: any) => err?.code === '23505' || err?.driverError?.code === '23505';

/**
 * Tracking event processor (Logistics doc §11/§12). Consumes QUEUES.TRACKING / TRACKING_POSITION_JOB:
 * position → geofence transition (hysteresis) → milestone update → route deviation → throttled ETA → delay vs promised
 * window → de-duplicated alert → dispatcher notification; plus stationary-truck detection and automatic trip
 * IN_PROGRESS / ARRIVED transitions (TripsService.systemTransition, after commit).
 *
 * All database writes for one position run in ONE transaction. Re-processing the same locationId is a no-op
 * (processed marker in hot state + dedupeKeys on tracking_events + monotonic geofence state).
 */
@Injectable()
export class TrackingProcessorService implements OnModuleInit {
  private readonly logger = new Logger('TrackingProcessor');
  private geofenceCache: { at: number; version: string; items: Geofence[] } | null = null;
  private scanRunning = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly config: ConfigService,
    private readonly moduleRef: ModuleRef,
    private readonly jobs: JobsService,
    private readonly hot: HotStateService,
    private readonly realtime: RealtimeService,
    private readonly settings: SettingsService,
    private readonly alerts: AlertsService,
    private readonly notifications: NotificationsService,
    private readonly estimator: RouteEstimatorService
  ) {}

  onModuleInit() {
    this.jobs.register(QUEUES.TRACKING, TRACKING_POSITION_JOB, data => this.processPosition(data as PositionProcessedEvent));
  }

  // ------------------------------------------------------------------ geofence cache

  /**
   * Active geofences, cached ~60 s. A tiny version probe (count + max(updatedAt)) detects changes made by other
   * instances or direct DB writes so a new/edited geofence is honoured immediately without reloading polygons.
   */
  async activeGeofences(): Promise<Geofence[]> {
    const probe = await this.ds.getRepository(Geofence).createQueryBuilder('g')
      .select('COUNT(*)', 'n').addSelect('MAX(g.updatedAt)', 'v')
      .getRawOne<{ n: string; v: Date | string | null }>();
    const version = `${probe?.n ?? 0}:${probe?.v ? new Date(probe.v).getTime() : 0}`;
    if (this.geofenceCache && this.geofenceCache.version === version && Date.now() - this.geofenceCache.at < GEOFENCE_CACHE_MS) {
      return this.geofenceCache.items;
    }
    const items = await this.ds.getRepository(Geofence).find({ where: { active: true } });
    this.geofenceCache = { at: Date.now(), version, items };
    return items;
  }

  invalidateGeofences() {
    this.geofenceCache = null;
  }

  static isInside(g: Geofence, p: LatLng): boolean {
    if (g.shape === 'CIRCLE') {
      if (g.centerLat == null || g.centerLng == null || !g.radiusM) return false;
      return haversineKm(p, [g.centerLat, g.centerLng]) * 1000 <= g.radiusM;
    }
    return Array.isArray(g.polygon) && g.polygon.length >= 3 && pointInPolygon(p, g.polygon);
  }

  // ------------------------------------------------------------------ entry point

  /** Process one accepted position (idempotent per locationId). */
  async processPosition(evt: PositionProcessedEvent): Promise<void> {
    if (!evt?.truckId || !Number.isFinite(evt.latitude) || !Number.isFinite(evt.longitude)) return;
    const marker = `routing:pos:${evt.locationId}`;
    if (evt.locationId && (await this.hot.getJson(marker))) return;

    const t = await logisticsThresholds(this.settings);
    const geofences = await this.activeGeofences();
    let post: PostAction[] = [];

    for (let attempt = 1; ; attempt++) {
      post = [];
      try {
        await this.ds.transaction(m => this.processInTx(m, evt, t, geofences, post));
        break;
      } catch (err) {
        // Concurrent insert of the same state / dedupe key: the retry sees the committed row.
        if (isUniqueViolation(err) && attempt < 3) continue;
        throw err;
      }
    }

    if (evt.locationId) await this.hot.setJson(marker, 1, PROCESSED_MARKER_TTL_S);
    await this.runPost(post);
  }

  private async processInTx(m: EntityManager, evt: PositionProcessedEvent, t: LogisticsThresholds, geofences: Geofence[], post: PostAction[]) {
    const at = new Date(evt.recordedAt);
    const p: LatLng = [evt.latitude, evt.longitude];
    // Lock order trip → truck (same as trip commands) serialises processing per trip/truck without deadlocks.
    let ctx = evt.tripId ? await this.loadTripContext(m, evt.tripId, null, true) : null;
    const truck = await m.getRepository(Truck).findOne({ where: { id: evt.truckId }, lock: { mode: 'pessimistic_write' } });
    if (!truck) return;
    if (ctx) {
      if (ctx.trip.truckId !== truck.id) ctx = null;
      else ctx.truck = truck;
    }
    const trip = ctx?.trip ?? null;
    const moving = !!trip && MOVING_TRIP_STATES.includes(trip.status);

    // 1. Geofences with hysteresis -----------------------------------------------------------------------
    const insideNow = new Map<string, boolean>();
    const transitions: Array<{ g: Geofence; type: 'ENTERED' | 'EXITED' }> = [];
    const states = await m.getRepository(GeofenceState).find({ where: { truckId: truck.id } });
    const byGeofence = new Map(states.map(s => [s.geofenceId, s]));
    for (const g of geofences) {
      const inside = TrackingProcessorService.isInside(g, p);
      insideNow.set(g.id, inside);
      let st = byGeofence.get(g.id);
      if (!st) {
        if (!inside) continue; // implicit "outside" state; nothing to record
        st = m.getRepository(GeofenceState).create({ truckId: truck.id, geofenceId: g.id, inside: false, pendingCount: 0, lastTransitionAt: null });
      }
      // Older than the last confirmed transition (replay / late job): never flip state backwards.
      if (st.lastTransitionAt && at.getTime() <= new Date(st.lastTransitionAt).getTime()) continue;
      if (inside === st.inside) {
        if (st.pendingCount !== 0) {
          st.pendingCount = 0;
          await m.getRepository(GeofenceState).save(st);
        }
        continue;
      }
      st.pendingCount += 1;
      const minPoints = Math.max(1, g.minConsecutivePoints > 0 ? g.minConsecutivePoints : t.geofenceMinPoints);
      if (st.pendingCount >= minPoints) {
        st.inside = inside;
        st.pendingCount = 0;
        st.lastTransitionAt = at;
        transitions.push({ g, type: inside ? 'ENTERED' : 'EXITED' });
      }
      await m.getRepository(GeofenceState).save(st);
    }

    const entered = new Set(transitions.filter(x => x.type === 'ENTERED').map(x => x.g.id));
    const milestonesReached: Array<Record<string, unknown>> = [];

    // 2. Milestones ------------------------------------------------------------------------------------
    let missedCount = 0;
    if (ctx) {
      const res = await this.processMilestones(m, ctx, entered, at, post);
      milestonesReached.push(...res.reached);
      missedCount = res.missed;
    }

    for (const { g, type } of transitions) {
      await m.getRepository(GeofenceEvent).insert({
        truckId: truck.id, geofenceId: g.id, tripId: trip?.id ?? null, type, latitude: p[0], longitude: p[1], occurredAt: at
      });
      const entities: RealtimeEntities = {
        ...(ctx?.entities ?? { truckId: truck.id, tripId: null }),
        geofenceId: g.id,
        warehouseIds: uniq([g.warehouseId, ...(ctx?.entities.warehouseIds ?? [])])
      };
      const payload = {
        geofenceId: g.id, geofenceName: g.name, kind: g.kind, warehouseId: g.warehouseId, type,
        truckId: truck.id, fleetCode: truck.fleetCode, tripId: trip?.id ?? null, latitude: p[0], longitude: p[1],
        occurredAt: at.toISOString(),
        milestonesReached: type === 'ENTERED' ? milestonesReached.filter(x => x.geofenceId === g.id) : []
      };
      post.push(() => this.realtime.publish(type === 'ENTERED' ? 'geofence.entered' : 'geofence.exited', entities, payload));

      if (type === 'ENTERED' && g.kind === 'RESTRICTED' && g.alertOnEnter) {
        await this.raiseAlert(m, post, entities, {
          severity: 'LOW_BLUE',
          title: `Truck ${truck.fleetCode} entered restricted zone ${g.name}`,
          category: 'Logistics',
          trigger: `Geofence ${g.name} entered at ${at.toISOString()} (${p[0].toFixed(5)}, ${p[1].toFixed(5)})`,
          affectedArea: g.name,
          actionRequired: 'Verify the reason with the driver',
          sourceType: 'TRUCK',
          sourceId: truck.id,
          dedupeKey: `restricted:${truck.id}:${g.id}:${at.getTime()}`
        });
      }
    }

    if (!ctx || !trip) {
      return;
    }

    // 3. Automatic trip transitions (executed after commit through TripsService) ------------------------
    // Fixes recorded before dispatch (buffered/late device uploads) must not drive the trip lifecycle.
    const afterDispatch = !trip.actualStartAt || at.getTime() >= new Date(trip.actualStartAt).getTime();
    const destinations = new Set(ctx.shipments.map(s => s.destinationWarehouseId));
    const arrivedAt = transitions.find(x => x.type === 'ENTERED' && x.g.warehouseId && destinations.has(x.g.warehouseId));
    const arriving = moving && afterDispatch && !!arrivedAt;
    if (arriving) {
      post.push(() => this.systemTransition(trip.id, 'ARRIVED', 'Destination geofence entered', at));
    } else if (afterDispatch && trip.status === 'DISPATCHED' && (evt.speedKmh ?? 0) > FIRST_MOVEMENT_KMH) {
      post.push(() => this.systemTransition(trip.id, 'IN_PROGRESS', 'First movement after dispatch', at));
    }

    if (!moving) return;

    // 4. Route deviation -------------------------------------------------------------------------------
    await this.checkDeviation(m, ctx, p, at, evt.locationId, t, post);

    // 5 + 6. Throttled ETA refresh and delay detection --------------------------------------------------
    if (!arriving) await this.computeEta(m, ctx, p, at, missedCount > 0, t, `pos:${evt.locationId}`, post);

    // 7. Stationary truck outside depots -------------------------------------------------------------
    await this.checkStationary(m, ctx, geofences, insideNow, t, post);
  }

  // ------------------------------------------------------------------ context

  private async loadTripContext(m: EntityManager, tripId: string, truck: Truck | null, lock: boolean): Promise<TripContext | null> {
    const trip = await m.getRepository(Trip).findOne({ where: { id: tripId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!trip || trip.status === 'COMPLETED' || trip.status === 'ABORTED') return null;
    const tr = truck && truck.id === trip.truckId ? truck : await m.getRepository(Truck).findOne({ where: { id: trip.truckId } });
    if (!tr) return null;
    const links = await m.getRepository(TripShipment).find({ where: { tripId: trip.id }, order: { stopSequence: 'ASC' } });
    const shipments = links.length ? await m.getRepository(Shipment).find({ where: { id: In(links.map(l => l.shipmentId)) } }) : [];
    const route = trip.routeId ? await m.getRepository(Route).findOne({ where: { id: trip.routeId } }) : null;
    return {
      trip, truck: tr, shipments, links, route,
      entities: {
        truckId: tr.id, tripId: trip.id, driverId: trip.primaryDriverId, shipmentIds: shipments.map(s => s.id),
        warehouseIds: uniq(shipments.flatMap(s => [s.originWarehouseId, s.destinationWarehouseId]))
      }
    };
  }

  // ------------------------------------------------------------------ milestones

  private async processMilestones(m: EntityManager, ctx: TripContext, entered: Set<string>, at: Date, post: PostAction[]) {
    const reached: Array<Record<string, unknown>> = [];
    const repo = m.getRepository(TripMilestone);
    const list = await repo.find({ where: { tripId: ctx.trip.id }, order: { sequence: 'ASC' } });
    if (!list.length) return { reached, missed: 0 };
    for (const ms of list) {
      if (ms.status !== 'PENDING' || !ms.geofenceId || !entered.has(ms.geofenceId)) continue;
      ms.status = 'REACHED';
      ms.reachedAt = at;
      await repo.update({ id: ms.id }, { status: 'REACHED', reachedAt: at });
      const lateMin = ms.expectedAt ? Math.round((at.getTime() - new Date(ms.expectedAt).getTime()) / 60000) : null;
      const info = { milestoneId: ms.id, name: ms.name, sequence: ms.sequence, geofenceId: ms.geofenceId, expectedAt: iso(ms.expectedAt), reachedAt: at.toISOString(), lateMin };
      await this.addEvent(m, { type: 'MILESTONE_REACHED', truckId: ctx.truck.id, tripId: ctx.trip.id, payload: info, dedupeKey: `milestone:${ctx.trip.id}:${ms.id}`, occurredAt: at });
      reached.push(info);
    }
    const missed = await this.markMissed(m, ctx, list, at, post);
    return { reached, missed };
  }

  /** PENDING milestones past expectedAt + tolerance while a later milestone is already REACHED → MISSED. */
  private async markMissed(m: EntityManager, ctx: TripContext, list: TripMilestone[], now: Date, post: PostAction[]): Promise<number> {
    const maxReached = Math.max(-Infinity, ...list.filter(x => x.status === 'REACHED').map(x => x.sequence));
    const candidates = list.filter(x => x.status === 'PENDING' && x.expectedAt && x.sequence < maxReached);
    if (!candidates.length) return 0;
    const routeMs = await m.getRepository(RouteMilestone).find({ where: { id: In(candidates.map(c => c.routeMilestoneId)) } });
    const tol = new Map(routeMs.map(r => [r.id, r.toleranceMin]));
    let count = 0;
    for (const ms of candidates) {
      const deadline = new Date(ms.expectedAt!).getTime() + (tol.get(ms.routeMilestoneId) ?? 60) * 60000;
      if (deadline >= now.getTime()) continue;
      ms.status = 'MISSED';
      await m.getRepository(TripMilestone).update({ id: ms.id }, { status: 'MISSED' });
      const key = `milestone-missed:${ctx.trip.id}:${ms.id}`;
      const inserted = await this.addEvent(m, {
        type: 'MILESTONE_MISSED', truckId: ctx.truck.id, tripId: ctx.trip.id, dedupeKey: key, occurredAt: now,
        payload: { milestoneId: ms.id, name: ms.name, sequence: ms.sequence, expectedAt: iso(ms.expectedAt), toleranceMin: tol.get(ms.routeMilestoneId) ?? 60 }
      });
      if (inserted) {
        count++;
        await this.raiseAlert(m, post, ctx.entities, {
          severity: 'MEDIUM_YELLOW',
          title: `Trip ${ctx.trip.tripNumber}: milestone "${ms.name}" missed`,
          category: 'Logistics Delays',
          trigger: `Milestone ${ms.sequence} (${ms.name}) expected by ${iso(ms.expectedAt)} was not reached; a later checkpoint was`,
          affectedArea: ms.name,
          actionRequired: 'Confirm the route with the driver',
          sourceType: 'TRIP',
          sourceId: ctx.trip.id,
          dedupeKey: key
        });
      }
    }
    return count;
  }

  // ------------------------------------------------------------------ route deviation

  private async checkDeviation(m: EntityManager, ctx: TripContext, p: LatLng, at: Date, locationId: string, t: LogisticsThresholds, post: PostAction[]) {
    const { trip, route } = ctx;
    const geometry = route?.geometry;
    if (!route || !Array.isArray(geometry) || geometry.length < 2) return;
    const corridor = route.corridorWidthKm || t.routeDeviationKm;
    const distance = distanceToPolylineKm(p, geometry);
    if (distance > corridor) {
      trip.offRouteCount = (trip.offRouteCount || 0) + 1;
      const changes: Partial<Trip> = { offRouteCount: trip.offRouteCount };
      if (trip.offRouteCount >= Math.max(1, t.routeDeviationMinPoints) && !trip.offRoute) {
        trip.offRoute = true;
        changes.offRoute = true;
        const key = `deviation:${trip.id}:${Math.floor(at.getTime() / 3_600_000)}`;
        const payload = {
          tripId: trip.id, tripNumber: trip.tripNumber, truckId: ctx.truck.id, routeId: route.id, routeCode: route.code,
          distanceFromRouteKm: round(distance, 2), corridorWidthKm: corridor, latitude: p[0], longitude: p[1], occurredAt: at.toISOString()
        };
        const inserted = await this.addEvent(m, { type: 'ROUTE_DEVIATION', truckId: ctx.truck.id, tripId: trip.id, payload, dedupeKey: key, occurredAt: at });
        if (inserted) {
          post.push(() => this.realtime.publish('route.deviation.detected', ctx.entities, payload));
          await this.raiseAlert(m, post, ctx.entities, {
            severity: 'MEDIUM_YELLOW',
            title: `Truck ${ctx.truck.fleetCode} off route ${route.code}`,
            category: 'Logistics',
            trigger: `${round(distance, 1)} km from the planned corridor (limit ${corridor} km) on trip ${trip.tripNumber}`,
            affectedArea: route.name,
            actionRequired: 'Contact the driver and confirm the reason for the deviation',
            sourceType: 'TRIP',
            sourceId: trip.id,
            dedupeKey: key
          }, true);
        }
      }
      await m.getRepository(Trip).update({ id: trip.id }, changes);
      return;
    }
    if (trip.offRouteCount || trip.offRoute) {
      const wasOff = trip.offRoute;
      trip.offRouteCount = 0;
      trip.offRoute = false;
      await m.getRepository(Trip).update({ id: trip.id }, { offRouteCount: 0, offRoute: false });
      if (wasOff) {
        await this.addEvent(m, {
          type: 'ROUTE_RETURNED', truckId: ctx.truck.id, tripId: trip.id, occurredAt: at, dedupeKey: `route-returned:${trip.id}:${locationId}`,
          payload: { routeId: route.id, distanceFromRouteKm: round(distance, 2), latitude: p[0], longitude: p[1] }
        });
      }
    }
  }

  // ------------------------------------------------------------------ ETA + delay

  /**
   * Recompute the trip ETA when forced, never computed, older than etaRefreshMinutes or the truck moved more than
   * etaRefreshDistanceKm since the last computation. Returns null when throttled / not computable.
   */
  private async computeEta(m: EntityManager, ctx: TripContext, p: LatLng, positionAt: Date, force: boolean, t: LogisticsThresholds, keySuffix: string, post: PostAction[]): Promise<EtaResult | null> {
    const { trip } = ctx;
    const now = new Date();
    if (!force && trip.etaComputedAt) {
      const ageMin = (now.getTime() - new Date(trip.etaComputedAt).getTime()) / 60000;
      const moved = trip.etaComputedAtLat != null && trip.etaComputedAtLng != null ? haversineKm(p, [trip.etaComputedAtLat, trip.etaComputedAtLng]) : Infinity;
      if (ageMin < t.etaRefreshMinutes && moved <= t.etaRefreshDistanceKm) return null;
    }

    let remainingKm: number | null = null;
    let method: string;
    const geometry = ctx.route?.geometry;
    if (Array.isArray(geometry) && geometry.length >= 2) {
      remainingKm = remainingAlongPolylineKm(p, geometry);
      method = 'ROUTE_GEOMETRY';
    } else {
      const lastStop = [...ctx.links].sort((a, b) => b.stopSequence - a.stopSequence)[0];
      const destId = ctx.shipments.find(s => s.id === lastStop?.shipmentId)?.destinationWarehouseId ?? ctx.route?.destinationWarehouseId ?? null;
      const dest = destId ? await m.getRepository(Warehouse).findOne({ where: { id: destId } }) : null;
      if (!dest || dest.latitude == null || dest.longitude == null) return null;
      const est = await this.estimator.estimate(p, [dest.latitude, dest.longitude]);
      remainingKm = est.distanceKm;
      method = est.source;
    }
    if (remainingKm == null || !Number.isFinite(remainingKm)) return null;

    const since = new Date(positionAt.getTime() - SPEED_WINDOW_MIN * 60000);
    const row = await m.getRepository(TruckLocation).createQueryBuilder('l')
      .select('AVG(l.speedKmh)', 'avg')
      .where('l.truckId = :truckId', { truckId: ctx.truck.id })
      .andWhere('l.speedKmh IS NOT NULL')
      .andWhere('l.recordedAt BETWEEN :since AND :until', { since, until: positionAt })
      .getRawOne<{ avg: string | number | null }>();
    const avg = row?.avg != null ? Number(row.avg) : t.averageSpeedKmh;
    const speed = Math.max(Number.isFinite(avg) ? avg : 0, t.averageSpeedKmh * 0.5, 1);
    const eta = new Date(now.getTime() + (remainingKm / speed) * 3_600_000);
    const remaining = round(remainingKm, 2);

    Object.assign(trip, { estimatedArrivalAt: eta, remainingDistanceKm: remaining, etaComputedAt: now, etaComputedAtLat: p[0], etaComputedAtLng: p[1] });
    await m.getRepository(Trip).update({ id: trip.id }, {
      estimatedArrivalAt: eta, remainingDistanceKm: remaining, etaComputedAt: now, etaComputedAtLat: p[0], etaComputedAtLng: p[1]
    });
    const open = ctx.shipments.filter(s => !CLOSED_SHIPMENT_STATES.includes(s.status));
    if (open.length) await m.getRepository(Shipment).update({ id: In(open.map(s => s.id)) }, { estimatedArrivalAt: eta });
    open.forEach(s => (s.estimatedArrivalAt = eta));

    const payload = {
      tripId: trip.id, tripNumber: trip.tripNumber, truckId: ctx.truck.id, estimatedArrivalAt: eta.toISOString(), remainingDistanceKm: remaining,
      averageSpeedKmh: round(speed, 1), method, computedAt: now.toISOString()
    };
    await this.addEvent(m, { type: 'ETA_UPDATED', truckId: ctx.truck.id, tripId: trip.id, payload, dedupeKey: `eta:${trip.id}:${keySuffix}`, occurredAt: now });

    await this.evaluateDelays(m, ctx, open, eta, t, post);
    post.push(() => this.realtime.publish('shipment.eta.updated', ctx.entities, {
      ...payload,
      shipments: open.map(s => ({ shipmentId: s.id, shipmentNumber: s.shipmentNumber, estimatedArrivalAt: eta.toISOString(), plannedDeliveryAt: iso(s.plannedDeliveryAt), isDelayed: s.isDelayed }))
    }));
    return { estimatedArrivalAt: eta, remainingDistanceKm: remaining };
  }

  /** ETA beyond promised delivery + tolerance → isDelayed + one de-duplicated alert per lateness band (hour). */
  private async evaluateDelays(m: EntityManager, ctx: TripContext, shipments: Shipment[], eta: Date, t: LogisticsThresholds, post: PostAction[]) {
    for (const s of shipments) {
      const lateMs = eta.getTime() - new Date(s.plannedDeliveryAt).getTime();
      if (lateMs > t.delayToleranceMinutes * 60000) {
        if (!s.isDelayed) {
          s.isDelayed = true;
          await m.getRepository(Shipment).update({ id: s.id }, { isDelayed: true });
        }
        const band = Math.floor(lateMs / 3_600_000);
        const key = `delay:${s.id}:${band}`;
        const minutesLate = Math.round(lateMs / 60000);
        const payload = {
          shipmentId: s.id, shipmentNumber: s.shipmentNumber, tripId: ctx.trip.id, tripNumber: ctx.trip.tripNumber,
          estimatedArrivalAt: eta.toISOString(), plannedDeliveryAt: iso(s.plannedDeliveryAt), minutesLate, lateHoursBand: band,
          toleranceMinutes: t.delayToleranceMinutes
        };
        const inserted = await this.addEvent(m, { type: 'SHIPMENT_DELAYED', truckId: ctx.truck.id, tripId: ctx.trip.id, shipmentId: s.id, payload, dedupeKey: key, occurredAt: new Date() });
        if (!inserted) continue;
        const entities: RealtimeEntities = { ...ctx.entities, shipmentIds: [s.id], warehouseIds: uniq([s.originWarehouseId, s.destinationWarehouseId]) };
        post.push(() => this.realtime.publish('shipment.delayed', entities, payload));
        await this.raiseAlert(m, post, entities, {
          severity: 'HIGH_ORANGE',
          title: `Shipment ${s.shipmentNumber} delayed`,
          category: 'Logistics Delays',
          trigger: `ETA ${eta.toISOString()} is ${minutesLate} min after the promised delivery ${iso(s.plannedDeliveryAt)} (tolerance ${t.delayToleranceMinutes} min)`,
          affectedArea: s.customerName || null,
          actionRequired: 'Contact the driver, update the receiver and re-plan if needed',
          sourceType: 'SHIPMENT',
          sourceId: s.id,
          dedupeKey: key
        }, true, ['IN_APP', 'EMAIL']);
      } else if (s.isDelayed) {
        s.isDelayed = false;
        await m.getRepository(Shipment).update({ id: s.id }, { isDelayed: false });
      }
    }
  }

  // ------------------------------------------------------------------ stationary

  private async checkStationary(m: EntityManager, ctx: TripContext, geofences: Geofence[], insideNow: Map<string, boolean>, t: LogisticsThresholds, post: PostAction[]) {
    const since = ctx.truck.stationarySince ? new Date(ctx.truck.stationarySince) : null;
    if (!since || Date.now() - since.getTime() < t.stationaryAlertMinutes * 60000) return;
    if (geofences.some(g => DEPOT_KINDS.includes(g.kind) && insideNow.get(g.id))) return;
    const key = `stationary:${ctx.truck.id}:${since.getTime()}`;
    const hours = round((Date.now() - since.getTime()) / 3_600_000, 1);
    const lat = ctx.truck.lastLat, lng = ctx.truck.lastLng;
    const inserted = await this.addEvent(m, {
      type: 'STATIONARY', truckId: ctx.truck.id, tripId: ctx.trip.id, dedupeKey: key, occurredAt: new Date(),
      payload: { stationarySince: since.toISOString(), stationaryHours: hours, latitude: lat, longitude: lng }
    });
    if (!inserted) return;
    await this.raiseAlert(m, post, ctx.entities, {
      severity: 'HIGH_ORANGE',
      title: `Truck ${ctx.truck.fleetCode} stationary beyond threshold`,
      category: 'Theft/Diversion Risk',
      trigger: `Stationary ${hours} hrs at ${lat ?? '?'},${lng ?? '?'} during trip ${ctx.trip.tripNumber} (outside any warehouse/depot)`,
      affectedArea: ctx.route?.name ?? null,
      actionRequired: 'Contact the driver immediately; escalate to security if unreachable',
      sourceType: 'TRUCK',
      sourceId: ctx.truck.id,
      dedupeKey: key
    }, true, ['IN_APP', 'EMAIL']);
  }

  // ------------------------------------------------------------------ public helpers used by RoutingService

  /** Force/throttled ETA refresh from the truck's last known position (contract: RoutingService.refreshEta). */
  async refreshEta(tripId: string, force = false): Promise<EtaResult | null> {
    const t = await logisticsThresholds(this.settings);
    const post: PostAction[] = [];
    const result = await this.ds.transaction(async m => {
      const ctx = await this.loadTripContext(m, tripId, null, true);
      if (!ctx) {
        const trip = await m.getRepository(Trip).findOne({ where: { id: tripId } });
        return trip ? { estimatedArrivalAt: trip.estimatedArrivalAt, remainingDistanceKm: trip.remainingDistanceKm } : null;
      }
      const current = { estimatedArrivalAt: ctx.trip.estimatedArrivalAt, remainingDistanceKm: ctx.trip.remainingDistanceKm };
      const { truck } = ctx;
      if (!MOVING_TRIP_STATES.includes(ctx.trip.status) || truck.lastLat == null || truck.lastLng == null) return current;
      const at = truck.lastPositionAt ? new Date(truck.lastPositionAt) : new Date();
      const res = await this.computeEta(m, ctx, [truck.lastLat, truck.lastLng], at, force, t, `refresh:${Date.now()}`, post);
      return res ?? current;
    });
    await this.runPost(post);
    return result;
  }

  @Interval('routing-milestone-scan', 5 * 60 * 1000)
  async scheduledMilestoneScan() {
    if (!this.config.get<boolean>('schedulerEnabled')) return;
    if (this.scanRunning) return;
    try {
      await this.runMilestoneScan();
    } catch (err) {
      this.logger.error(`Milestone scan failed: ${(err as Error)?.message}`, (err as Error)?.stack);
    }
  }

  /** Mark overdue milestones of moving trips as MISSED (and force an ETA/delay evaluation for those trips). */
  async runMilestoneScan(): Promise<{ tripsScanned: number; missed: number }> {
    this.scanRunning = true;
    try {
      const trips = await this.ds.getRepository(Trip).find({ where: { status: In(MOVING_TRIP_STATES) }, select: { id: true } });
      let missed = 0;
      for (const { id } of trips) {
        const post: PostAction[] = [];
        const n = await this.ds.transaction(async m => {
          const ctx = await this.loadTripContext(m, id, null, true);
          if (!ctx) return 0;
          const list = await m.getRepository(TripMilestone).find({ where: { tripId: id }, order: { sequence: 'ASC' } });
          return list.length ? this.markMissed(m, ctx, list, new Date(), post) : 0;
        });
        await this.runPost(post);
        if (n > 0) {
          missed += n;
          await this.refreshEta(id, true).catch(err => this.logger.warn(`ETA refresh after missed milestone failed for trip ${id}: ${(err as Error)?.message}`));
        }
      }
      return { tripsScanned: trips.length, missed };
    } finally {
      this.scanRunning = false;
    }
  }

  // ------------------------------------------------------------------ plumbing

  /** Insert a tracking event; returns false when the dedupeKey already exists (ON CONFLICT DO NOTHING keeps the tx alive). */
  private async addEvent(m: EntityManager, e: Partial<TrackingEvent>): Promise<boolean> {
    const res = await m.createQueryBuilder().insert().into(TrackingEvent)
      .values({
        type: e.type!, truckId: e.truckId ?? null, tripId: e.tripId ?? null, shipmentId: e.shipmentId ?? null, deviceId: e.deviceId ?? null,
        payload: (e.payload ?? null) as any, dedupeKey: e.dedupeKey ?? null, occurredAt: e.occurredAt ?? new Date()
      })
      .orIgnore()
      .returning('id')
      .execute();
    return Array.isArray(res.raw) ? res.raw.length > 0 : (res.identifiers?.length ?? 0) > 0;
  }

  private async raiseAlert(
    m: EntityManager, post: PostAction[], entities: RealtimeEntities, input: RaiseAlertInput,
    notifyDispatcher = false, channels: Array<'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH'> = ['IN_APP']
  ) {
    const alert = await this.alerts.raise(input, m);
    if (notifyDispatcher) {
      await this.notifications.notify({
        role: 'DISPATCHER', title: `[${input.severity}] ${input.title}`, message: input.trigger || input.title, link: `/alerts/${alert.id}`, channels
      }, m);
    }
    post.push(() => this.realtime.publish('alert.created', { ...entities, alertId: alert.id }, alert));
    return alert;
  }

  private async systemTransition(tripId: string, to: 'IN_PROGRESS' | 'ARRIVED', reason: string, at?: Date) {
    let trips: TripsService | null = null;
    try {
      trips = this.moduleRef.get(TripsService, { strict: false });
    } catch {
      trips = null;
    }
    if (!trips) {
      this.logger.warn(`TripsService unavailable — cannot apply ${to} to trip ${tripId}`);
      return false;
    }
    return trips.systemTransition(tripId, to, reason, at);
  }

  private async runPost(post: PostAction[]) {
    for (const action of post) {
      try {
        await action();
      } catch (err) {
        this.logger.warn(`Post-commit action failed: ${(err as Error)?.message}`);
      }
    }
  }
}

function uniq(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

function iso(d: Date | string | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null;
}

