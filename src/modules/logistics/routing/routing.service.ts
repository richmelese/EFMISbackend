import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { FLEET_WIDE_ROLES } from '../../../common/constants/permissions';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { Errors } from '../../../common/utils/errors';
import { isValidCoordinate, LatLng, polylineLengthKm } from '../../../common/utils/geo';
import { round } from '../../../common/utils/helpers';
import { applySearch } from '../../../common/utils/query-filters';
import { AuditService } from '../../audit/audit.service';
import { SettingsService } from '../../settings/settings.service';
import { Driver } from '../drivers/entities/driver.entities';
import { Truck } from '../fleet/entities/fleet.entities';
import { logisticsThresholds, Paged, pageParams } from '../logistics.constants';
import { Shipment, Trip, TripShipment } from '../shipments/entities/shipment.entities';
import { PositionProcessedEvent } from '../tracking/tracking.types';
import { Warehouse } from '../warehouses/entities/warehouse.entities';
import {
  CreateGeofenceDto, CreateMilestoneDto, CreateRouteDto, GEOFENCE_MAX_RADIUS_M, GEOFENCE_MIN_RADIUS_M, GeofenceEventsQuery, GeofenceListQuery,
  RouteListQuery, UpdateGeofenceDto, UpdateRouteDto
} from './dto/routing.dto';
import { Geofence, GeofenceEvent, Route, RouteMilestone, TripMilestone } from './entities/routing.entities';
import { RouteEstimate, RouteEstimatorService } from './route-estimator.service';
import { EtaResult, TrackingProcessorService } from './tracking-processor.service';

const DEFAULT_CHECKPOINT_RADIUS_M = 500;
const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const isUniqueViolation = (err: any) => err?.code === '23505' || err?.driverError?.code === '23505';

/**
 * Routes, milestones, geofences and ETA (Logistics doc §12). Cross-module contract (LOGISTICS.md):
 * estimate(), initTripMilestones(), refreshEta(). The GPS event processor itself lives in TrackingProcessorService.
 */
@Injectable()
export class RoutingService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly estimator: RouteEstimatorService,
    private readonly processor: TrackingProcessorService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService
  ) {}

  // ================================================================== contract

  estimate(origin: LatLng, destination: LatLng, viaGeometry?: LatLng[]): Promise<RouteEstimate> {
    return this.estimator.estimate(origin, destination, viaGeometry);
  }

  /**
   * Copy the route's milestones into trip_milestones (expectedAt = plannedStartAt + expectedOffsetMin).
   * Re-callable on re-planning: PENDING rows are rebuilt, REACHED/MISSED rows are kept.
   */
  async initTripMilestones(tripId: string, routeId: string | null, plannedStartAt: Date, manager?: EntityManager): Promise<void> {
    const work = async (m: EntityManager) => {
      const repo = m.getRepository(TripMilestone);
      await repo.delete({ tripId, status: 'PENDING' });
      if (!routeId) return;
      const kept = await repo.find({ where: { tripId } });
      const keptIds = new Set(kept.map(k => k.routeMilestoneId));
      const routeMs = await m.getRepository(RouteMilestone).find({ where: { routeId }, order: { sequence: 'ASC' } });
      const start = new Date(plannedStartAt).getTime();
      const rows = routeMs.filter(r => !keptIds.has(r.id)).map(r => repo.create({
        tripId, routeMilestoneId: r.id, sequence: r.sequence, name: r.name, geofenceId: r.geofenceId,
        expectedAt: new Date(start + r.expectedOffsetMin * 60000), reachedAt: null, status: 'PENDING'
      }));
      if (rows.length) await repo.insert(rows);
    };
    return manager ? work(manager) : this.ds.transaction(work);
  }

  refreshEta(tripId: string, force = false): Promise<EtaResult | null> {
    return this.processor.refreshEta(tripId, force);
  }

  /** Tracking event processor entry point (also registered on QUEUES.TRACKING). */
  processPosition(evt: PositionProcessedEvent): Promise<void> {
    return this.processor.processPosition(evt);
  }

  runMilestoneScan() {
    return this.processor.runMilestoneScan();
  }

  // ================================================================== routes

  async routeToFrontend(r: Route, opts: { warehouses?: Map<string, Warehouse>; milestones?: RouteMilestone[] } = {}) {
    const wh = opts.warehouses ?? await this.warehouseMap([r.originWarehouseId, r.destinationWarehouseId]);
    const ref = (id: string) => {
      const w = wh.get(id);
      return w ? { id: w.id, code: w.code, name: w.name, latitude: w.latitude, longitude: w.longitude } : { id };
    };
    return {
      id: r.id, code: r.code, name: r.name,
      originWarehouseId: r.originWarehouseId, destinationWarehouseId: r.destinationWarehouseId,
      origin: ref(r.originWarehouseId), destination: ref(r.destinationWarehouseId),
      label: `${wh.get(r.originWarehouseId)?.name ?? '?'} -> ${wh.get(r.destinationWarehouseId)?.name ?? '?'}`,
      geometry: r.geometry ?? [], distanceKm: r.distanceKm, estimatedDurationMin: r.estimatedDurationMin,
      corridorWidthKm: r.corridorWidthKm, geometrySource: r.geometrySource, providerReference: r.providerReference,
      active: r.active, createdBy: r.createdBy, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
      ...(opts.milestones ? { milestones: opts.milestones.map(x => this.milestoneToFrontend(x)) } : {})
    };
  }

  milestoneToFrontend(x: RouteMilestone, geofence?: Geofence | null) {
    return {
      id: x.id, routeId: x.routeId, sequence: x.sequence, name: x.name, geofenceId: x.geofenceId,
      expectedOffsetMin: x.expectedOffsetMin, toleranceMin: x.toleranceMin,
      ...(geofence !== undefined ? { geofence: geofence ? this.geofenceToFrontend(geofence) : null } : {})
    };
  }

  async listRoutes(q: RouteListQuery): Promise<Paged<any>> {
    const { page, pageSize, skip, take } = pageParams(q);
    const qb = this.ds.getRepository(Route).createQueryBuilder('r');
    if (q.active) qb.andWhere('r.active = :active', { active: q.active === 'true' });
    if (q.originWarehouseId) qb.andWhere('r.originWarehouseId = :o', { o: q.originWarehouseId });
    if (q.destinationWarehouseId) qb.andWhere('r.destinationWarehouseId = :d', { d: q.destinationWarehouseId });
    applySearch(qb, ['r.code', 'r.name'], q.q);
    const [rows, total] = await qb.orderBy('r.code', 'ASC').skip(skip).take(take).getManyAndCount();
    const wh = await this.warehouseMap(rows.flatMap(r => [r.originWarehouseId, r.destinationWarehouseId]));
    const items = await Promise.all(rows.map(r => this.routeToFrontend(r, { warehouses: wh })));
    return { items, total, page, pageSize };
  }

  async getRoute(id: string) {
    const r = await this.findRoute(id);
    const milestones = await this.ds.getRepository(RouteMilestone).find({ where: { routeId: id }, order: { sequence: 'ASC' } });
    return this.routeToFrontend(r, { milestones });
  }

  async createRoute(user: AuthUser, dto: CreateRouteDto, ctx: RequestContext) {
    if (dto.originWarehouseId === dto.destinationWarehouseId) throw Errors.unprocessable('Origin and destination warehouses must differ');
    const wh = await this.warehouseMap([dto.originWarehouseId, dto.destinationWarehouseId]);
    const origin = wh.get(dto.originWarehouseId);
    const dest = wh.get(dto.destinationWarehouseId);
    if (!origin) throw Errors.notFound('Origin warehouse');
    if (!dest) throw Errors.notFound('Destination warehouse');
    const code = dto.code.trim().toUpperCase();
    if (await this.ds.getRepository(Route).exists({ where: { code } })) throw Errors.conflict(`Route code ${code} already exists`);

    const geo = await this.resolveGeometry(dto.geometry, origin, dest, dto.distanceKm, dto.estimatedDurationMin);
    try {
      return await this.ds.transaction(async m => {
        const repo = m.getRepository(Route);
        const route = await repo.save(repo.create({
          code, name: dto.name.trim(), originWarehouseId: origin.id, destinationWarehouseId: dest.id,
          geometry: geo.geometry, distanceKm: geo.distanceKm, estimatedDurationMin: geo.durationMin,
          corridorWidthKm: dto.corridorWidthKm ?? 2, geometrySource: geo.source, providerReference: dto.providerReference ?? null,
          active: true, createdBy: user.name
        }));
        await this.audit.record(user, 'ROUTE_CREATED', route.id, {
          new: { code, name: route.name, originWarehouseId: origin.id, destinationWarehouseId: dest.id, distanceKm: route.distanceKm, geometrySource: route.geometrySource }
        }, ctx, m);
        return this.routeToFrontend(route, { warehouses: wh, milestones: [] });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict(`Route code ${code} already exists`);
      throw err;
    }
  }

  async updateRoute(user: AuthUser, id: string, dto: UpdateRouteDto, ctx: RequestContext) {
    const route = await this.findRoute(id);
    const old = { name: route.name, corridorWidthKm: route.corridorWidthKm, active: route.active, distanceKm: route.distanceKm, geometrySource: route.geometrySource };
    if (dto.name !== undefined) route.name = dto.name.trim();
    if (dto.corridorWidthKm !== undefined) route.corridorWidthKm = dto.corridorWidthKm;
    if (dto.active !== undefined) route.active = dto.active;
    if (dto.providerReference !== undefined) route.providerReference = dto.providerReference;
    const wh = await this.warehouseMap([route.originWarehouseId, route.destinationWarehouseId]);
    if (dto.geometry || dto.recompute) {
      const geo = await this.resolveGeometry(dto.recompute ? undefined : dto.geometry, wh.get(route.originWarehouseId), wh.get(route.destinationWarehouseId), dto.distanceKm, dto.estimatedDurationMin);
      route.geometry = geo.geometry;
      route.distanceKm = geo.distanceKm;
      route.estimatedDurationMin = geo.durationMin;
      route.geometrySource = geo.source;
    } else {
      if (dto.distanceKm !== undefined) route.distanceKm = dto.distanceKm;
      if (dto.estimatedDurationMin !== undefined) route.estimatedDurationMin = dto.estimatedDurationMin;
    }
    return this.ds.transaction(async m => {
      await m.getRepository(Route).save(route);
      await this.audit.record(user, 'ROUTE_UPDATED', route.id, {
        old, new: { name: route.name, corridorWidthKm: route.corridorWidthKm, active: route.active, distanceKm: route.distanceKm, geometrySource: route.geometrySource }
      }, ctx, m);
      const milestones = await m.getRepository(RouteMilestone).find({ where: { routeId: id }, order: { sequence: 'ASC' } });
      return this.routeToFrontend(route, { warehouses: wh, milestones });
    });
  }

  /** Geometry from the request (validated) or from estimate() between the warehouse coordinates. */
  private async resolveGeometry(geometry: Array<[number, number]> | undefined, origin: Warehouse | undefined, dest: Warehouse | undefined, distanceKm?: number, durationMin?: number) {
    const t = await logisticsThresholds(this.settings);
    if (geometry) {
      const line = this.validatePoints(geometry, 2, 'geometry');
      const d = distanceKm ?? round(polylineLengthKm(line), 2);
      return { geometry: line, distanceKm: d, durationMin: durationMin ?? round((d / Math.max(t.averageSpeedKmh, 1)) * 60, 1), source: 'MANUAL' };
    }
    if (!origin || !dest || origin.latitude == null || origin.longitude == null || dest.latitude == null || dest.longitude == null) {
      throw Errors.unprocessable('Origin and destination warehouses need coordinates to compute the route (or supply geometry)');
    }
    const est = await this.estimator.estimate([origin.latitude, origin.longitude], [dest.latitude, dest.longitude]);
    return { geometry: est.geometry, distanceKm: distanceKm ?? est.distanceKm, durationMin: durationMin ?? est.durationMin, source: est.source as string };
  }

  // ================================================================== route milestones

  async listMilestones(routeId: string): Promise<Paged<any>> {
    await this.findRoute(routeId);
    const rows = await this.ds.getRepository(RouteMilestone).find({ where: { routeId }, order: { sequence: 'ASC' } });
    const fences = await this.geofenceMap(rows.map(r => r.geofenceId));
    const items = rows.map(r => this.milestoneToFrontend(r, r.geofenceId ? fences.get(r.geofenceId) ?? null : null));
    return { items, total: items.length, page: 1, pageSize: Math.max(items.length, 1) };
  }

  async addMilestone(user: AuthUser, routeId: string, dto: CreateMilestoneDto, ctx: RequestContext) {
    const route = await this.findRoute(routeId);
    if (!dto.geofenceId && (dto.lat == null || dto.lng == null)) throw Errors.unprocessable('Provide geofenceId or lat/lng (+ radiusM) for the milestone');
    if (!dto.geofenceId && !isValidCoordinate(dto.lat, dto.lng)) throw Errors.unprocessable('Invalid milestone coordinates');
    const existing = await this.ds.getRepository(RouteMilestone).find({ where: { routeId }, order: { sequence: 'ASC' } });
    const sequence = dto.sequence ?? (existing.length ? existing[existing.length - 1].sequence + 1 : 1);
    if (existing.some(x => x.sequence === sequence)) throw Errors.conflict(`Milestone sequence ${sequence} already exists on route ${route.code}`);
    const prev = [...existing].reverse().find(x => x.sequence < sequence);
    const next = existing.find(x => x.sequence > sequence);
    if (prev && dto.expectedOffsetMin < prev.expectedOffsetMin) {
      throw Errors.unprocessable(`expectedOffsetMin must be ≥ ${prev.expectedOffsetMin} (milestone ${prev.sequence} "${prev.name}")`);
    }
    if (next && dto.expectedOffsetMin > next.expectedOffsetMin) {
      throw Errors.unprocessable(`expectedOffsetMin must be ≤ ${next.expectedOffsetMin} (milestone ${next.sequence} "${next.name}")`);
    }
    let fence: Geofence | null = null;
    if (dto.geofenceId) {
      fence = await this.ds.getRepository(Geofence).findOne({ where: { id: dto.geofenceId } });
      if (!fence) throw Errors.notFound('Geofence');
    }
    try {
      const result = await this.ds.transaction(async m => {
        if (!fence) {
          const gRepo = m.getRepository(Geofence);
          fence = await gRepo.save(gRepo.create({
            name: `${route.code} · ${dto.name}`.slice(0, 160), kind: 'CHECKPOINT', shape: 'CIRCLE',
            centerLat: dto.lat!, centerLng: dto.lng!, radiusM: dto.radiusM ?? DEFAULT_CHECKPOINT_RADIUS_M, polygon: null,
            warehouseId: null, alertOnEnter: true, alertOnExit: true, minConsecutivePoints: 2, active: true
          }));
          await this.audit.record(user, 'GEOFENCE_CREATED', fence.id, { new: this.geofenceToFrontend(fence), reason: `Checkpoint for route ${route.code}` }, ctx, m);
        }
        const repo = m.getRepository(RouteMilestone);
        const ms = await repo.save(repo.create({
          routeId, sequence, name: dto.name.trim(), geofenceId: fence.id, expectedOffsetMin: dto.expectedOffsetMin, toleranceMin: dto.toleranceMin ?? 60
        }));
        await this.audit.record(user, 'ROUTE_MILESTONE_ADDED', route.id, { new: this.milestoneToFrontend(ms) }, ctx, m);
        return this.milestoneToFrontend(ms, fence);
      });
      this.processor.invalidateGeofences();
      return result;
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict(`Milestone sequence ${sequence} already exists on route ${route.code}`);
      throw err;
    }
  }

  async removeMilestone(user: AuthUser, routeId: string, milestoneId: string, ctx: RequestContext) {
    const route = await this.findRoute(routeId);
    const ms = await this.ds.getRepository(RouteMilestone).findOne({ where: { id: milestoneId, routeId } });
    if (!ms) throw Errors.notFound('Route milestone');
    await this.ds.transaction(async m => {
      await m.getRepository(RouteMilestone).delete({ id: ms.id });
      await this.audit.record(user, 'ROUTE_MILESTONE_REMOVED', route.id, { old: this.milestoneToFrontend(ms) }, ctx, m);
    });
    return { deleted: true, id: ms.id };
  }

  // ================================================================== geofences

  geofenceToFrontend(g: Geofence) {
    return {
      id: g.id, name: g.name, kind: g.kind, shape: g.shape, centerLat: g.centerLat, centerLng: g.centerLng, radiusM: g.radiusM,
      polygon: g.polygon, warehouseId: g.warehouseId, alertOnEnter: g.alertOnEnter, alertOnExit: g.alertOnExit,
      minConsecutivePoints: g.minConsecutivePoints, active: g.active, createdAt: iso(g.createdAt), updatedAt: iso(g.updatedAt)
    };
  }

  async listGeofences(q: GeofenceListQuery): Promise<Paged<any>> {
    const { page, pageSize, skip, take } = pageParams(q);
    const qb = this.ds.getRepository(Geofence).createQueryBuilder('g');
    if (q.kind) qb.andWhere('g.kind = :kind', { kind: q.kind });
    if (q.active) qb.andWhere('g.active = :active', { active: q.active === 'true' });
    if (q.warehouseId) qb.andWhere('g.warehouseId = :w', { w: q.warehouseId });
    applySearch(qb, ['g.name'], q.q);
    const [rows, total] = await qb.orderBy('g.name', 'ASC').skip(skip).take(take).getManyAndCount();
    return { items: rows.map(g => this.geofenceToFrontend(g)), total, page, pageSize };
  }

  async getGeofence(id: string) {
    return this.geofenceToFrontend(await this.findGeofence(id));
  }

  async createGeofence(user: AuthUser, dto: CreateGeofenceDto, ctx: RequestContext) {
    const repo = this.ds.getRepository(Geofence);
    const g = repo.create({
      name: dto.name.trim(), kind: dto.kind, shape: dto.shape, centerLat: dto.centerLat ?? null, centerLng: dto.centerLng ?? null,
      radiusM: dto.radiusM ?? null, polygon: dto.polygon ?? null, warehouseId: dto.warehouseId ?? null,
      alertOnEnter: dto.alertOnEnter ?? true, alertOnExit: dto.alertOnExit ?? true, minConsecutivePoints: dto.minConsecutivePoints ?? 2,
      active: dto.active ?? true
    });
    this.normalizeShape(g);
    if (g.warehouseId) await this.assertWarehouse(g.warehouseId);
    const saved = await this.ds.transaction(async m => {
      const s = await m.getRepository(Geofence).save(g);
      await this.audit.record(user, 'GEOFENCE_CREATED', s.id, { new: this.geofenceToFrontend(s) }, ctx, m);
      return s;
    });
    this.processor.invalidateGeofences();
    return this.geofenceToFrontend(saved);
  }

  async updateGeofence(user: AuthUser, id: string, dto: UpdateGeofenceDto, ctx: RequestContext) {
    const g = await this.findGeofence(id);
    const old = this.geofenceToFrontend(g);
    const fields: Array<keyof UpdateGeofenceDto> = ['name', 'kind', 'shape', 'centerLat', 'centerLng', 'radiusM', 'polygon', 'warehouseId', 'alertOnEnter', 'alertOnExit', 'minConsecutivePoints', 'active'];
    for (const f of fields) if (dto[f] !== undefined) (g as any)[f] = dto[f];
    if (typeof g.name === 'string') g.name = g.name.trim();
    this.normalizeShape(g);
    if (g.warehouseId && g.warehouseId !== old.warehouseId) await this.assertWarehouse(g.warehouseId);
    const saved = await this.ds.transaction(async m => {
      const s = await m.getRepository(Geofence).save(g);
      await this.audit.record(user, 'GEOFENCE_UPDATED', s.id, { old, new: this.geofenceToFrontend(s) }, ctx, m);
      return s;
    });
    this.processor.invalidateGeofences();
    return this.geofenceToFrontend(saved);
  }

  async geofenceEvents(id: string, q: GeofenceEventsQuery): Promise<Paged<any>> {
    const g = await this.findGeofence(id);
    const { page, pageSize, skip, take } = pageParams(q);
    const qb = this.ds.getRepository(GeofenceEvent).createQueryBuilder('e').where('e.geofenceId = :id', { id: g.id });
    if (q.truckId) qb.andWhere('e.truckId = :truckId', { truckId: q.truckId });
    if (q.tripId) qb.andWhere('e.tripId = :tripId', { tripId: q.tripId });
    if (q.type) qb.andWhere('e.type = :type', { type: q.type });
    const [rows, total] = await qb.orderBy('e.occurredAt', 'DESC').skip(skip).take(take).getManyAndCount();
    const truckIds = [...new Set(rows.map(r => r.truckId))];
    const trucks = truckIds.length ? await this.ds.getRepository(Truck).find({ where: { id: In(truckIds) } }) : [];
    const codes = new Map(trucks.map(t => [t.id, t]));
    const items = rows.map(r => ({
      id: r.id, geofenceId: r.geofenceId, geofenceName: g.name, type: r.type, truckId: r.truckId,
      fleetCode: codes.get(r.truckId)?.fleetCode ?? null, plateNumber: codes.get(r.truckId)?.plateNumber ?? null,
      tripId: r.tripId, latitude: r.latitude, longitude: r.longitude, occurredAt: iso(r.occurredAt)
    }));
    return { items, total, page, pageSize };
  }

  /** CIRCLE: valid centre + radius 50–50000 m. POLYGON: ≥ 3 valid [lat, lng] points. */
  private normalizeShape(g: Geofence) {
    if (g.shape === 'CIRCLE') {
      if (!isValidCoordinate(g.centerLat, g.centerLng)) throw Errors.unprocessable('CIRCLE geofence requires a valid centerLat/centerLng');
      if (typeof g.radiusM !== 'number' || g.radiusM < GEOFENCE_MIN_RADIUS_M || g.radiusM > GEOFENCE_MAX_RADIUS_M) {
        throw Errors.unprocessable(`CIRCLE geofence radiusM must be between ${GEOFENCE_MIN_RADIUS_M} and ${GEOFENCE_MAX_RADIUS_M} m`);
      }
      g.polygon = null;
    } else if (g.shape === 'POLYGON') {
      g.polygon = this.validatePoints(g.polygon, 3, 'polygon');
      const distinct = new Set(g.polygon.map(p => `${p[0]},${p[1]}`));
      if (distinct.size < 3) throw Errors.unprocessable('polygon needs at least 3 distinct points');
      g.centerLat = null;
      g.centerLng = null;
      g.radiusM = null;
    } else {
      throw Errors.unprocessable('shape must be CIRCLE or POLYGON');
    }
  }

  private validatePoints(points: unknown, min: number, field: string): LatLng[] {
    if (!Array.isArray(points) || points.length < min) throw Errors.unprocessable(`${field} needs at least ${min} points`);
    const bad = points.findIndex(p => !Array.isArray(p) || p.length !== 2 || !isValidCoordinate(p[0], p[1]));
    if (bad >= 0) throw Errors.unprocessable(`${field}[${bad}] is not a valid [lat, lng] coordinate`);
    return points.map(p => [Number(p[0]), Number(p[1])] as LatLng);
  }

  // ================================================================== trip views

  async tripMilestones(user: AuthUser, tripId: string): Promise<Paged<any>> {
    const trip = await this.visibleTrip(user, tripId);
    const rows = await this.ds.getRepository(TripMilestone).find({ where: { tripId: trip.id }, order: { sequence: 'ASC' } });
    const routeMs = rows.length ? await this.ds.getRepository(RouteMilestone).find({ where: { id: In(rows.map(r => r.routeMilestoneId)) } }) : [];
    const tol = new Map(routeMs.map(r => [r.id, r.toleranceMin]));
    const fences = await this.geofenceMap(rows.map(r => r.geofenceId));
    const now = Date.now();
    const items = rows.map(r => {
      const toleranceMin = tol.get(r.routeMilestoneId) ?? 60;
      const expected = r.expectedAt ? new Date(r.expectedAt).getTime() : null;
      const lateMin = expected == null ? null
        : r.reachedAt ? Math.round((new Date(r.reachedAt).getTime() - expected) / 60000)
        : r.status === 'PENDING' && now > expected ? Math.round((now - expected) / 60000) : null;
      const g = r.geofenceId ? fences.get(r.geofenceId) : undefined;
      return {
        id: r.id, tripId: r.tripId, routeMilestoneId: r.routeMilestoneId, sequence: r.sequence, name: r.name, status: r.status,
        geofenceId: r.geofenceId, geofenceName: g?.name ?? null,
        location: g ? (g.shape === 'CIRCLE' ? { lat: g.centerLat, lng: g.centerLng, radiusM: g.radiusM } : { polygon: g.polygon }) : null,
        expectedAt: iso(r.expectedAt), reachedAt: iso(r.reachedAt), toleranceMin, lateMin,
        overdue: r.status === 'PENDING' && expected != null && now > expected + toleranceMin * 60000
      };
    });
    return { items, total: items.length, page: 1, pageSize: Math.max(items.length, 1) };
  }

  async tripEta(user: AuthUser, tripId: string, refresh = false) {
    let trip = await this.visibleTrip(user, tripId);
    if (refresh) {
      await this.refreshEta(trip.id, false);
      trip = (await this.ds.getRepository(Trip).findOne({ where: { id: trip.id } })) ?? trip;
    }
    const links = await this.ds.getRepository(TripShipment).find({ where: { tripId: trip.id }, order: { stopSequence: 'ASC' } });
    const shipments = links.length ? await this.ds.getRepository(Shipment).find({ where: { id: In(links.map(l => l.shipmentId)) } }) : [];
    const byId = new Map(shipments.map(s => [s.id, s]));
    const truck = await this.ds.getRepository(Truck).findOne({ where: { id: trip.truckId } });
    const eta = trip.estimatedArrivalAt ? new Date(trip.estimatedArrivalAt).getTime() : null;
    return {
      tripId: trip.id, tripNumber: trip.tripNumber, status: trip.status, routeId: trip.routeId,
      estimatedArrivalAt: iso(trip.estimatedArrivalAt), remainingDistanceKm: trip.remainingDistanceKm, etaComputedAt: iso(trip.etaComputedAt),
      etaRemainingMin: eta != null ? Math.max(0, Math.round((eta - Date.now()) / 60000)) : null,
      offRoute: trip.offRoute, actualArrivalAt: iso(trip.actualArrivalAt),
      lastPosition: truck && truck.lastLat != null ? { lat: truck.lastLat, lng: truck.lastLng, speedKmh: truck.lastSpeedKmh, at: iso(truck.lastPositionAt) } : null,
      shipments: links.map(l => byId.get(l.shipmentId)).filter((s): s is Shipment => !!s).map(s => ({
        shipmentId: s.id, shipmentNumber: s.shipmentNumber, status: s.status, destinationWarehouseId: s.destinationWarehouseId,
        plannedDeliveryAt: iso(s.plannedDeliveryAt), estimatedArrivalAt: iso(s.estimatedArrivalAt), isDelayed: s.isDelayed,
        minutesLate: s.estimatedArrivalAt ? Math.max(0, Math.round((new Date(s.estimatedArrivalAt).getTime() - new Date(s.plannedDeliveryAt).getTime()) / 60000)) : null
      }))
    };
  }

  /** Trip visibility: fleet-wide roles; DRIVER own trips; WAREHOUSE_OPERATOR trips touching their warehouse. */
  private async visibleTrip(user: AuthUser, tripId: string): Promise<Trip> {
    const trip = await this.ds.getRepository(Trip).findOne({ where: { id: tripId } });
    if (!trip) throw Errors.notFound('Trip');
    if (FLEET_WIDE_ROLES.includes(user.role)) return trip;
    if (user.role === 'DRIVER') {
      const driver = await this.ds.getRepository(Driver).findOne({ where: { userId: user.id } });
      if (driver && driver.id === trip.primaryDriverId) return trip;
      throw Errors.notFound('Trip');
    }
    if (user.role === 'WAREHOUSE_OPERATOR' && user.warehouseId) {
      const count = await this.ds.getRepository(Shipment).createQueryBuilder('s')
        .innerJoin(TripShipment, 'ts', 'ts.shipmentId = s.id')
        .where('ts.tripId = :tripId', { tripId: trip.id })
        .andWhere('(s.originWarehouseId = :w OR s.destinationWarehouseId = :w)', { w: user.warehouseId })
        .getCount();
      if (count > 0) return trip;
    }
    throw Errors.notFound('Trip');
  }

  // ================================================================== helpers

  private async findRoute(id: string) {
    const r = await this.ds.getRepository(Route).findOne({ where: { id } });
    if (!r) throw Errors.notFound('Route');
    return r;
  }

  private async findGeofence(id: string) {
    const g = await this.ds.getRepository(Geofence).findOne({ where: { id } });
    if (!g) throw Errors.notFound('Geofence');
    return g;
  }

  private async assertWarehouse(id: string) {
    if (!(await this.ds.getRepository(Warehouse).exists({ where: { id } }))) throw Errors.notFound('Warehouse');
  }

  private async warehouseMap(ids: Array<string | null | undefined>): Promise<Map<string, Warehouse>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map();
    const rows = await this.ds.getRepository(Warehouse).find({ where: { id: In(unique) } });
    return new Map(rows.map(w => [w.id, w]));
  }

  private async geofenceMap(ids: Array<string | null | undefined>): Promise<Map<string, Geofence>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map();
    const rows = await this.ds.getRepository(Geofence).find({ where: { id: In(unique) } });
    return new Map(rows.map(g => [g.id, g]));
  }
}

