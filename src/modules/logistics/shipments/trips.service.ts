import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { Errors } from '../../../common/utils/errors';
import {
  ACTIVE_TRIP_STATES, SHIPMENT_TRANSITIONS, TRIP_TRANSITIONS, assertTransition, canTransition
} from '../../../common/utils/state-machine';
import { AlertsService } from '../../alerts/alerts.service';
import { AuditService } from '../../audit/audit.service';
import { SettingsService } from '../../settings/settings.service';
import { Driver, DriverTripAssignment } from '../drivers/entities/driver.entities';
import { DriversService } from '../drivers/drivers.service';
import { GpsDevice, Truck, VehicleType } from '../fleet/entities/fleet.entities';
import { FleetService } from '../fleet/fleet.service';
import { Paged, logisticsThresholds, pageParams } from '../logistics.constants';
import { RealtimeEntities, RealtimeService } from '../realtime/realtime.service';
import { Route, TripMilestone } from '../routing/entities/routing.entities';
import { RoutingService } from '../routing/routing.service';
import { Product } from '../warehouses/entities/warehouse.entities';
import { InventoryService } from '../warehouses/inventory.service';
import { ChecklistDto, CreateTripDto, IncidentDto, ListTripsQueryDto, LoadingDto, ReassignTripDto, TripReasonDto } from './dto/trip.dto';
import {
  Delivery, IdempotencyKey, Shipment, Trip, TripChecklist, TripEvent, TripShipment
} from './entities/shipment.entities';
import { ShipmentChange, ShipmentsService, deliveryToFrontend } from './shipments.service';
import {
  GPS_ACTOR, LogisticsScope, PRE_DISPATCH_TRIP_STATES, PRE_TRANSIT_SHIPMENT_STATES, QTY_EPS, TRIP_NUMBER_LOCK, iso, isDriver,
  isWarehouseOperator, r3, uniqueViolation
} from './shipments.util';

type Actor = AuthUser | typeof GPS_ACTOR;

interface TripChange {
  trip: Trip;
  previousStatus: string | null;
}

/** Collected side effects of a transaction, published after commit. */
interface Outbox {
  trips: TripChange[];
  shipments: ShipmentChange[];
  assignments: Array<{ tripId: string; driverId: string; truckId: string; status: string; previousDriverId?: string | null; previousTruckId?: string | null }>;
  alerts: any[];
}

const newOutbox = (): Outbox => ({ trips: [], shipments: [], assignments: [], alerts: [] });

/**
 * Trips = one vehicle journey carrying one or more shipments (Logistics doc §5.2, §6 steps 7–14, §10 steps 32–41).
 * Every state change: assertTransition → transaction with row locks → audit (before/after) → realtime publish after commit.
 */
@Injectable()
export class TripsService {
  private readonly logger = new Logger('Trips');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly audit: AuditService,
    private readonly alerts: AlertsService,
    private readonly settings: SettingsService,
    private readonly realtime: RealtimeService,
    private readonly shipments: ShipmentsService,
    private readonly drivers: DriversService,
    private readonly fleet: FleetService,
    private readonly inventory: InventoryService,
    // forwardRef: routing/tracking-processor imports this file (lazy ModuleRef lookup), creating a file-level cycle
    @Inject(forwardRef(() => RoutingService)) private readonly routing: RoutingService
  ) {}

  // ================================================================== contract methods (LOGISTICS.md)

  /** Active trip of a truck (any ACTIVE_TRIP_STATES), newest first. */
  async activeTripForTruck(truckId: string): Promise<Trip | null> {
    return this.ds.getRepository(Trip).findOne({ where: { truckId, status: In(ACTIVE_TRIP_STATES) }, order: { createdAt: 'DESC' } });
  }

  /**
   * GPS-driven transition (routing processor). IN_PROGRESS only from DISPATCHED; ARRIVED from any state that allows it
   * (also moves IN_TRANSIT shipments to ARRIVED). Returns false (no-op) when the transition is not allowed.
   */
  async systemTransition(tripId: string, to: 'IN_PROGRESS' | 'ARRIVED', reason: string, at?: Date): Promise<boolean> {
    const outbox = newOutbox();
    const when = at ?? new Date();
    const done = await this.ds.transaction(async m => {
      const trip = await m.getRepository(Trip).createQueryBuilder('t').setLock('pessimistic_write').where('t.id = :id', { id: tripId }).getOne();
      if (!trip) return false;
      if (!canTransition(TRIP_TRANSITIONS, trip.status, to)) return false;
      if (to === 'IN_PROGRESS' && trip.status !== 'DISPATCHED') return false;
      if (to === 'ARRIVED') await this.doArrive(m, trip, GPS_ACTOR, {}, reason, when, outbox);
      else await this.transition(m, trip, 'IN_PROGRESS', GPS_ACTOR, 'TRIP_IN_PROGRESS', {}, {}, { reason }, outbox, when);
      return true;
    });
    if (done) this.flush(outbox);
    return done;
  }

  /** API shape of a trip (ISO timestamps). `detail` adds checklist, milestones, events and deliveries. */
  async tripToFrontend(t: Trip, opts: { detail?: boolean } = {}): Promise<any> {
    const ds = this.ds;
    const links = await ds.getRepository(TripShipment).find({ where: { tripId: t.id }, order: { stopSequence: 'ASC' } });
    const shipmentIds = links.map(l => l.shipmentId);
    const [shipments, truck, device, driver, route] = await Promise.all([
      shipmentIds.length ? ds.getRepository(Shipment).findBy({ id: In(shipmentIds) }) : Promise.resolve([] as Shipment[]),
      ds.getRepository(Truck).findOne({ where: { id: t.truckId } }),
      ds.getRepository(GpsDevice).findOne({ where: { truckId: t.truckId } }),
      ds.getRepository(Driver).findOne({ where: { id: t.primaryDriverId } }),
      t.routeId ? ds.getRepository(Route).findOne({ where: { id: t.routeId } }) : Promise.resolve(null)
    ]);
    const vehicleType = truck ? await ds.getRepository(VehicleType).findOne({ where: { id: truck.vehicleTypeId } }) : null;
    const byId = new Map(shipments.map(s => [s.id, s]));
    const shipmentRows = links.map(l => {
      const s = byId.get(l.shipmentId);
      return {
        shipmentId: l.shipmentId,
        shipmentNumber: s?.shipmentNumber ?? null,
        waybillNumber: s?.waybillNumber ?? null,
        status: s?.status ?? null,
        stopSequence: l.stopSequence,
        originWarehouseId: s?.originWarehouseId ?? null,
        destinationWarehouseId: s?.destinationWarehouseId ?? null,
        cargoDescription: s?.cargoDescription ?? null,
        plannedQuantity: s?.plannedQuantity ?? null,
        loadedQuantity: l.loadedQuantity,
        loadingDiscrepancy: l.loadingDiscrepancy,
        loadedAt: iso(l.loadedAt),
        loadedBy: l.loadedBy,
        deliveredQuantity: s?.deliveredQuantity ?? 0,
        plannedDeliveryAt: iso(s?.plannedDeliveryAt ?? null),
        isDelayed: s?.isDelayed ?? false
      };
    });
    const out: any = {
      id: t.id,
      tripNumber: t.tripNumber,
      status: t.status,
      truckId: t.truckId,
      truck: truck ? await this.fleet.truckToFrontend(truck, { device, vehicleType }) : null,
      primaryDriverId: t.primaryDriverId,
      driver: driver ? await this.drivers.toFrontend(driver) : null,
      routeId: t.routeId,
      route: route ? { id: route.id, code: route.code, name: route.name, distanceKm: route.distanceKm, estimatedDurationMin: route.estimatedDurationMin } : null,
      plannedStartAt: iso(t.plannedStartAt),
      actualStartAt: iso(t.actualStartAt),
      estimatedArrivalAt: iso(t.estimatedArrivalAt),
      actualArrivalAt: iso(t.actualArrivalAt),
      completedAt: iso(t.completedAt),
      requiresDriverAcceptance: t.requiresDriverAcceptance,
      requiresTracking: t.requiresTracking,
      remainingDistanceKm: t.remainingDistanceKm,
      etaComputedAt: iso(t.etaComputedAt),
      offRoute: t.offRoute,
      abortReason: t.abortReason,
      originWarehouseId: shipments[0]?.originWarehouseId ?? null,
      destinationWarehouseIds: [...new Set(shipments.map(s => s.destinationWarehouseId))],
      shipments: shipmentRows,
      totals: {
        plannedQuantity: r3(shipments.reduce((a, s) => a + (Number(s.plannedQuantity) || 0), 0)),
        loadedQuantity: r3(links.reduce((a, l) => a + (Number(l.loadedQuantity) || 0), 0)),
        deliveredQuantity: r3(shipments.reduce((a, s) => a + (Number(s.deliveredQuantity) || 0), 0))
      },
      createdBy: t.createdBy,
      createdAt: iso(t.createdAt),
      updatedAt: iso(t.updatedAt)
    };
    if (!opts.detail) return out;

    const [checklist, milestones, events, deliveries] = await Promise.all([
      ds.getRepository(TripChecklist).findOne({ where: { tripId: t.id }, order: { createdAt: 'DESC' } }),
      ds.getRepository(TripMilestone).find({ where: { tripId: t.id }, order: { sequence: 'ASC' } }),
      ds.getRepository(TripEvent).find({ where: { tripId: t.id }, order: { occurredAt: 'ASC' } }),
      ds.getRepository(Delivery).find({ where: { tripId: t.id }, order: { deliveredAt: 'ASC' } })
    ]);
    const next = milestones.find(x => x.status === 'PENDING');
    out.checklist = checklist ? this.checklistToFrontend(checklist) : null;
    out.milestones = {
      total: milestones.length,
      reached: milestones.filter(x => x.status === 'REACHED').length,
      missed: milestones.filter(x => x.status === 'MISSED').length,
      pending: milestones.filter(x => x.status === 'PENDING').length,
      next: next ? { id: next.id, sequence: next.sequence, name: next.name, expectedAt: iso(next.expectedAt) } : null,
      items: milestones.map(x => ({ id: x.id, sequence: x.sequence, name: x.name, status: x.status, expectedAt: iso(x.expectedAt), reachedAt: iso(x.reachedAt) }))
    };
    out.events = events.map(e => this.eventToFrontend(e));
    out.deliveries = deliveries.map(d => deliveryToFrontend(d));
    return out;
  }

  // ================================================================== helpers

  private checklistToFrontend(c: TripChecklist) {
    return {
      id: c.id, tripId: c.tripId, items: c.items, passed: c.passed, driverAcknowledged: c.driverAcknowledged, odometerKm: c.odometerKm,
      completedBy: c.completedBy, createdAt: iso(c.createdAt)
    };
  }

  private eventToFrontend(e: TripEvent) {
    return {
      id: e.id, tripId: e.tripId, type: e.type, severity: e.severity, description: e.description, lat: e.latitude, lng: e.longitude,
      data: e.data, recordedBy: e.recordedBy, occurredAt: iso(e.occurredAt)
    };
  }

  private async getTrip(id: string, m?: EntityManager, lock = false): Promise<Trip> {
    const qb = (m ?? this.ds.manager).getRepository(Trip).createQueryBuilder('t').where('t.id = :id', { id });
    if (lock) qb.setLock('pessimistic_write');
    const t = await qb.getOne();
    if (!t) throw Errors.notFound('Trip');
    return t;
  }

  /** Trip shipments (locked, ordered by stop) with their join rows. */
  private async tripCargo(m: EntityManager, tripId: string, lock = true) {
    const links = await m.getRepository(TripShipment).find({ where: { tripId }, order: { stopSequence: 'ASC' } });
    if (!links.length) return { links, shipments: [] as Shipment[] };
    const qb = m.getRepository(Shipment).createQueryBuilder('s').where('s.id IN (:...ids)', { ids: links.map(l => l.shipmentId) }).orderBy('s.id');
    if (lock) qb.setLock('pessimistic_write');
    const rows = await qb.getMany();
    const byId = new Map(rows.map(s => [s.id, s]));
    return { links, shipments: links.map(l => byId.get(l.shipmentId)!).filter(Boolean) };
  }

  private async scopeTrip(user: AuthUser, t: Trip, scope?: LogisticsScope): Promise<void> {
    const sc = scope ?? (await this.shipments.scopeFor(user));
    if (sc.kind === 'ALL') return;
    if (sc.kind === 'DRIVER') {
      if (sc.driverId && t.primaryDriverId === sc.driverId) return;
    } else {
      const { shipments } = await this.tripCargo(this.ds.manager, t.id, false);
      for (const s of shipments) {
        try { await this.shipments.assertVisible(user, s, sc); return; } catch { /* try next */ }
      }
    }
    throw Errors.forbidden('This trip is outside your logistics scope');
  }

  /** DRIVER may only act on their own trip; dispatcher roles may act on any. */
  private async assertDriverOrDispatcher(user: AuthUser, t: Trip) {
    if (!isDriver(user)) return;
    const d = await this.drivers.driverForUser(user.id);
    if (!d || d.id !== t.primaryDriverId) throw Errors.forbidden('Only the assigned driver (or a dispatcher) can perform this action');
  }

  /** WAREHOUSE_OPERATOR may only act at their own warehouse. */
  private assertWarehouse(user: AuthUser, warehouseIds: string[], what: string) {
    if (!isWarehouseOperator(user)) return;
    if (!user.warehouseId || !warehouseIds.includes(user.warehouseId)) throw Errors.forbidden(`Only the ${what} warehouse operator can perform this action`);
  }

  private async lockTruck(m: EntityManager, id: string): Promise<Truck> {
    const t = await m.getRepository(Truck).createQueryBuilder('t').setLock('pessimistic_write').where('t.id = :id', { id }).getOne();
    if (!t) throw Errors.notFound('Truck');
    return t;
  }

  private async lockDriver(m: EntityManager, id: string): Promise<Driver> {
    const d = await m.getRepository(Driver).createQueryBuilder('d').setLock('pessimistic_write').where('d.id = :id', { id }).getOne();
    if (!d) throw Errors.notFound('Driver');
    return d;
  }

  private async event(m: EntityManager, tripId: string, type: string, description: string, recordedBy: string, data: Record<string, unknown> | null = null,
    extra: { severity?: string | null; lat?: number | null; lng?: number | null; at?: Date } = {}): Promise<TripEvent> {
    const repo = m.getRepository(TripEvent);
    return repo.save(repo.create({
      tripId, type, severity: extra.severity ?? null, description, latitude: extra.lat ?? null, longitude: extra.lng ?? null, data,
      recordedBy, occurredAt: extra.at ?? new Date()
    }));
  }

  /** Validated trip status change + STATUS_CHANGE event + audit (before/after). */
  private async transition(m: EntityManager, trip: Trip, to: string, actor: Actor, action: string, ctx: RequestContext,
    extra: Partial<Trip>, details: Record<string, unknown>, outbox: Outbox, at = new Date()) {
    assertTransition('trip', TRIP_TRANSITIONS, trip.status, to);
    const from = trip.status;
    await m.getRepository(Trip).update({ id: trip.id }, { ...extra, status: to });
    Object.assign(trip, extra, { status: to });
    await this.event(m, trip.id, 'STATUS_CHANGE', `${from} → ${to}${details.reason ? `: ${details.reason}` : ''}`, actor.name || 'system',
      { from, to, ...details }, { at });
    await this.audit.record(actor, action, trip.id, { old: { status: from }, new: { status: to }, tripNumber: trip.tripNumber, ...details }, ctx, m);
    outbox.trips.push({ trip, previousStatus: from });
  }

  /** Shipment status change (validated) recorded in the outbox. */
  private async shipmentTo(m: EntityManager, actor: Actor, s: Shipment, to: string, action: string, ctx: RequestContext, outbox: Outbox,
    extra: Partial<Shipment> = {}, details: Record<string, unknown> = {}) {
    const change = await this.shipments.setStatus(m, actor, s, to, action, ctx, extra, details);
    outbox.shipments.push(change);
  }

  private async raiseAlert(m: EntityManager, input: Parameters<AlertsService['raise']>[0], outbox: Outbox) {
    const a = await this.alerts.raise(input, m);
    outbox.alerts.push({ alert: a, sourceId: input.sourceId });
  }

  /** Publish everything collected in the outbox (after commit). */
  private flush(outbox: Outbox, cargo?: { warehouseIds: string[]; shipmentIds: string[] }) {
    for (const c of outbox.trips) {
      const t = c.trip;
      this.realtime.publish('trip.status.updated', this.entities(t, cargo), {
        tripId: t.id, tripNumber: t.tripNumber, status: t.status, previousStatus: c.previousStatus, truckId: t.truckId, driverId: t.primaryDriverId,
        actualStartAt: iso(t.actualStartAt), actualArrivalAt: iso(t.actualArrivalAt), completedAt: iso(t.completedAt), at: new Date().toISOString()
      });
    }
    for (const a of outbox.assignments) {
      this.realtime.publish('driver.assignment.updated', { tripId: a.tripId, driverId: a.driverId, truckId: a.truckId, shipmentIds: cargo?.shipmentIds },
        { ...a, at: new Date().toISOString() });
      if (a.previousDriverId && a.previousDriverId !== a.driverId) {
        this.realtime.publish('driver.assignment.updated', { tripId: a.tripId, driverId: a.previousDriverId, truckId: a.truckId },
          { tripId: a.tripId, driverId: a.previousDriverId, status: 'REASSIGNED', at: new Date().toISOString() });
      }
    }
    const trip = outbox.trips[0]?.trip;
    this.shipments.publishShipments(outbox.shipments, { tripId: trip?.id ?? null, truckId: trip?.truckId ?? null, driverId: trip?.primaryDriverId ?? null });
    for (const a of outbox.alerts) {
      this.realtime.publish('alert.created', { ...(trip ? this.entities(trip, cargo) : {}), alertId: a.alert?.id ?? null }, a.alert);
    }
  }

  private entities(t: Trip, cargo?: { warehouseIds: string[]; shipmentIds: string[] }): RealtimeEntities {
    return { tripId: t.id, truckId: t.truckId, driverId: t.primaryDriverId, shipmentIds: cargo?.shipmentIds ?? [], warehouseIds: cargo?.warehouseIds ?? [] };
  }

  private cargoRefs(shipments: Shipment[]) {
    return {
      shipmentIds: shipments.map(s => s.id),
      warehouseIds: [...new Set(shipments.flatMap(s => [s.originWarehouseId, s.destinationWarehouseId]))]
    };
  }

  private async cargoTypes(m: EntityManager, shipments: Shipment[]): Promise<Array<string | null>> {
    const ids = [...new Set(shipments.map(s => s.productId).filter(Boolean) as string[])];
    if (!ids.length) return [null];
    const prods = await m.getRepository(Product).findBy({ id: In(ids) });
    const types = [...new Set(prods.map(p => p.cargoType).filter(Boolean))];
    return types.length ? types : [null];
  }

  private async truckEligibility(m: EntityManager, truckId: string, shipments: Shipment[], requiresTracking: boolean, excludeTripId?: string) {
    const quantity = r3(shipments.reduce((a, s) => a + Math.max(Number(s.plannedQuantity) || 0, Number(s.loadedQuantity) || 0), 0));
    const reasons: string[] = [];
    let eligible = true;
    for (const cargoType of await this.cargoTypes(m, shipments)) {
      const r = await this.fleet.checkTruckEligibility(truckId, { quantity, cargoType, requiresTracking, excludeTripId }, m);
      if (!r.eligible) eligible = false;
      for (const x of r.reasons) if (!reasons.includes(x)) reasons.push(x);
    }
    return { eligible, reasons };
  }

  private driverWindow(plannedStartAt: Date, shipments: Shipment[]) {
    const maxDelivery = Math.max(...shipments.map(s => new Date(s.plannedDeliveryAt).getTime()));
    const from = new Date(plannedStartAt);
    const to = new Date(Math.max(maxDelivery, from.getTime() + 60_000));
    return { from, to };
  }

  private mapBookingConflict(e: any): never {
    const c = uniqueViolation(e);
    if (c && /uq_truck_active_trip|uq_driver_active_assignment/.test(c)) throw Errors.conflict('Truck or driver is already booked', { constraint: c });
    throw e;
  }

  private async nextTripNumber(m: EntityManager): Promise<string> {
    await m.query('SELECT pg_advisory_xact_lock($1)', [TRIP_NUMBER_LOCK]);
    const [row] = await m.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(trip_number FROM 4) AS INTEGER)), 1000) AS n FROM trips WHERE trip_number ~ '^TR-[0-9]+$'`
    );
    return `TR-${Number(row?.n ?? 1000) + 1}`;
  }

  private async result(tripId: string, detail = false) {
    return this.tripToFrontend(await this.getTrip(tripId), { detail });
  }

  // ================================================================== queries

  async list(user: AuthUser, q: ListTripsQueryDto): Promise<Paged<any>> {
    const { page, pageSize, skip, take } = pageParams(q);
    const qb = this.ds.getRepository(Trip).createQueryBuilder('t');
    const scope = await this.shipments.scopeFor(user);
    if (scope.kind === 'DRIVER') {
      if (!scope.driverId) qb.andWhere('1=0');
      else qb.andWhere('t.primaryDriverId = :scopeDriver', { scopeDriver: scope.driverId });
    } else if (scope.kind !== 'ALL') {
      const sub = this.ds.getRepository(Shipment).createQueryBuilder('s').select('1')
        .innerJoin(TripShipment, 'ts', 'ts.shipmentId = s.id').where('ts.tripId = t.id');
      this.shipments.applyScope(sub, 's', scope);
      qb.andWhere(`EXISTS (${sub.getQuery()})`, sub.getParameters());
    }
    if (q.status) {
      const statuses = q.status.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
      if (statuses.length) qb.andWhere('t.status IN (:...statuses)', { statuses });
    }
    if (q.truckId) qb.andWhere('t.truckId = :truckId', { truckId: q.truckId });
    if (q.driverId) qb.andWhere('t.primaryDriverId = :driverId', { driverId: q.driverId });
    if (q.active === true) qb.andWhere('t.status IN (:...activeStates)', { activeStates: ACTIVE_TRIP_STATES });
    if (q.active === false) qb.andWhere('t.status NOT IN (:...activeStates)', { activeStates: ACTIVE_TRIP_STATES });
    const [rows, total] = await qb.orderBy('t.createdAt', 'DESC').skip(skip).take(take).getManyAndCount();
    const items: any[] = [];
    for (const t of rows) items.push(await this.tripToFrontend(t));
    return { items, total, page, pageSize };
  }

  async detail(user: AuthUser, id: string) {
    const t = await this.getTrip(id);
    await this.scopeTrip(user, t);
    return this.tripToFrontend(t, { detail: true });
  }

  async events(user: AuthUser, id: string) {
    const t = await this.getTrip(id);
    await this.scopeTrip(user, t);
    const rows = await this.ds.getRepository(TripEvent).find({ where: { tripId: t.id }, order: { occurredAt: 'ASC' } });
    return rows.map(e => this.eventToFrontend(e));
  }

  // ================================================================== create / reassign

  async create(user: AuthUser, dto: CreateTripDto, ctx: RequestContext) {
    const plannedStartAt = new Date(dto.plannedStartAt);
    if (Number.isNaN(plannedStartAt.getTime())) throw Errors.unprocessable('Invalid plannedStartAt');
    const requiresDriverAcceptance = dto.requiresDriverAcceptance !== false;
    const requiresTracking = dto.requiresTracking !== false;
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };

    const tripId = await this.ds.transaction(async m => {
      const ids = [...new Set(dto.shipmentIds)];
      const locked = await m.getRepository(Shipment).createQueryBuilder('s').setLock('pessimistic_write')
        .where('s.id IN (:...ids)', { ids }).orderBy('s.id').getMany();
      const byId = new Map(locked.map(s => [s.id, s]));
      const missing = ids.filter(id => !byId.has(id));
      if (missing.length) throw Errors.unprocessable('Shipment(s) not found', { missing });
      const shipments = ids.map(id => byId.get(id)!);

      for (const s of shipments) {
        if (s.status === 'PLANNED') continue;
        if (s.status === 'ASSIGNED') {
          const active = await m.getRepository(TripShipment).createQueryBuilder('ts').innerJoin(Trip, 't', 't.id = ts.tripId')
            .where('ts.shipmentId = :sid AND t.status IN (:...states)', { sid: s.id, states: ACTIVE_TRIP_STATES }).getCount();
          if (active === 0) continue;
          throw Errors.conflict(`Shipment ${s.shipmentNumber} is already on an active trip`);
        }
        throw Errors.conflict(`Shipment ${s.shipmentNumber} must be PLANNED to be put on a trip (is ${s.status})`);
      }
      const origins = [...new Set(shipments.map(s => s.originWarehouseId))];
      if (origins.length > 1) throw Errors.unprocessable('All shipments of a trip must have the same origin warehouse', { origins });
      const destinations = [...new Set(shipments.map(s => s.destinationWarehouseId))];

      let routeId = dto.routeId ?? null;
      if (!routeId) {
        const routes = [...new Set(shipments.map(s => s.routeId))];
        if (routes.length === 1 && routes[0]) routeId = routes[0];
      }
      if (routeId) {
        const r = await m.getRepository(Route).findOne({ where: { id: routeId } });
        if (!r) throw Errors.unprocessable('Route not found', { field: 'routeId' });
        if (!r.active) throw Errors.unprocessable(`Route ${r.code} is inactive`);
        if (r.originWarehouseId !== origins[0]) throw Errors.unprocessable(`Route ${r.code} does not start at the shipments' origin warehouse`);
        if (destinations.length === 1 && r.destinationWarehouseId !== destinations[0]) {
          throw Errors.unprocessable(`Route ${r.code} does not end at the shipment destination warehouse`);
        }
      }

      // Lock truck & driver rows (double-booking prevention) and run eligibility checks
      const truck = await this.lockTruck(m, dto.truckId);
      await this.lockDriver(m, dto.driverId);
      const truckCheck = await this.truckEligibility(m, truck.id, shipments, requiresTracking);
      const window = this.driverWindow(plannedStartAt, shipments);
      const driverCheck = await this.drivers.checkEligibility(dto.driverId, { vehicleTypeId: truck.vehicleTypeId, from: window.from, to: window.to }, m);
      if (!truckCheck.eligible || !driverCheck.eligible) {
        throw Errors.unprocessable('Truck or driver is not eligible for this trip', {
          truckReasons: truckCheck.eligible ? [] : truckCheck.reasons, driverReasons: driverCheck.eligible ? [] : driverCheck.reasons
        });
      }

      const tripNumber = await this.nextTripNumber(m);
      const repo = m.getRepository(Trip);
      const trip = await repo.save(repo.create({
        tripNumber, truckId: truck.id, primaryDriverId: dto.driverId, routeId, plannedStartAt, status: 'PLANNED',
        requiresDriverAcceptance, requiresTracking, createdBy: user.name
      }));
      await m.getRepository(TripShipment).insert(shipments.map((s, i) => ({ tripId: trip.id, shipmentId: s.id, stopSequence: i + 1 })));
      await m.getRepository(DriverTripAssignment).insert({
        driverId: dto.driverId, tripId: trip.id, role: 'PRIMARY', assignedAt: new Date(), assignedBy: user.name, status: 'ACTIVE'
      });
      await this.fleet.setAvailability(truck.id, 'RESERVED', m);
      await this.drivers.setAvailability(dto.driverId, 'ASSIGNED', m);
      for (const s of shipments) {
        if (s.status === 'PLANNED') {
          await this.shipmentTo(m, user, s, 'ASSIGNED', 'SHIPMENT_ASSIGNED', ctx, outbox, {}, { tripId: trip.id, tripNumber });
        } else {
          await this.audit.record(user, 'SHIPMENT_TRIP_ASSIGNED', s.id, { old: { status: s.status }, new: { status: s.status }, tripId: trip.id, tripNumber }, ctx, m);
        }
      }
      await this.routing.initTripMilestones(trip.id, routeId, plannedStartAt, m);
      await this.event(m, trip.id, 'STATUS_CHANGE', `Trip ${tripNumber} planned`, user.name, { from: null, to: 'PLANNED' });
      await this.audit.record(user, 'TRIP_CREATED', trip.id, {
        old: null, new: { status: 'PLANNED' }, tripNumber, truckId: truck.id, driverId: dto.driverId, routeId, shipmentIds: ids,
        plannedStartAt: plannedStartAt.toISOString(), requiresDriverAcceptance, requiresTracking
      }, ctx, m);
      outbox.trips.push({ trip, previousStatus: null });
      outbox.assignments.push({ tripId: trip.id, driverId: dto.driverId, truckId: truck.id, status: 'ACTIVE' });
      cargo = this.cargoRefs(shipments);
      return trip.id;
    }).catch(e => this.mapBookingConflict(e));

    this.flush(outbox, cargo);
    return this.result(tripId, true);
  }

  async reassign(user: AuthUser, id: string, dto: ReassignTripDto, ctx: RequestContext) {
    if (!dto.driverId && !dto.truckId) throw Errors.unprocessable('Provide driverId and/or truckId to reassign');
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };
    await this.ds.transaction(async m => {
      const trip = await this.getTrip(id, m, true);
      if (!PRE_DISPATCH_TRIP_STATES.includes(trip.status)) throw Errors.conflict(`Trip ${trip.tripNumber} can only be reassigned before dispatch (is ${trip.status})`);
      const { shipments } = await this.tripCargo(m, trip.id);
      cargo = this.cargoRefs(shipments);
      const newTruckId = dto.truckId && dto.truckId !== trip.truckId ? dto.truckId : null;
      const newDriverId = dto.driverId && dto.driverId !== trip.primaryDriverId ? dto.driverId : null;
      if (!newTruckId && !newDriverId) throw Errors.unprocessable('The trip already uses this truck and driver');

      const truck = await this.lockTruck(m, newTruckId ?? trip.truckId);
      if (newDriverId) await this.lockDriver(m, newDriverId);
      const truckCheck = newTruckId ? await this.truckEligibility(m, truck.id, shipments, trip.requiresTracking, trip.id) : { eligible: true, reasons: [] };
      const window = this.driverWindow(trip.plannedStartAt, shipments);
      const driverId = newDriverId ?? trip.primaryDriverId;
      // a truck change can change the vehicle type → re-validate the (possibly unchanged) driver's licence class too
      const driverCheck = newDriverId || newTruckId
        ? await this.drivers.checkEligibility(driverId, { vehicleTypeId: truck.vehicleTypeId, from: window.from, to: window.to, excludeTripId: trip.id }, m)
        : { eligible: true, reasons: [] };
      if (!truckCheck.eligible || !driverCheck.eligible) {
        throw Errors.unprocessable('Truck or driver is not eligible for this trip', {
          truckReasons: truckCheck.eligible ? [] : truckCheck.reasons, driverReasons: driverCheck.eligible ? [] : driverCheck.reasons
        });
      }

      const prev = { truckId: trip.truckId, driverId: trip.primaryDriverId };
      const now = new Date();
      if (newDriverId) {
        await m.getRepository(DriverTripAssignment).update({ tripId: trip.id, status: 'ACTIVE' }, { status: 'REASSIGNED', releasedAt: now });
        await this.shipments.freeDriverIfIdle(m, prev.driverId);
        await m.getRepository(DriverTripAssignment).insert({
          driverId: newDriverId, tripId: trip.id, role: 'PRIMARY', assignedAt: now, assignedBy: user.name, status: 'ACTIVE'
        });
        await this.drivers.setAvailability(newDriverId, 'ASSIGNED', m);
      }
      await m.getRepository(Trip).update({ id: trip.id }, { truckId: truck.id, primaryDriverId: driverId });
      trip.truckId = truck.id;
      trip.primaryDriverId = driverId;
      if (newTruckId) {
        await this.shipments.freeTruckIfIdle(m, prev.truckId, trip.id);
        await this.fleet.setAvailability(newTruckId, 'RESERVED', m);
      }
      await this.event(m, trip.id, 'NOTE', `Reassigned: ${dto.reason}`, user.name, {
        kind: newTruckId ? 'TRUCK_REASSIGNED' : 'DRIVER_REASSIGNED', truckChanged: !!newTruckId, driverChanged: !!newDriverId,
        previousTruckId: prev.truckId, previousDriverId: prev.driverId, truckId: truck.id, driverId, reason: dto.reason
      });
      await this.audit.record(user, 'TRIP_REASSIGNED', trip.id, {
        old: { status: trip.status, truckId: prev.truckId, driverId: prev.driverId },
        new: { status: trip.status, truckId: truck.id, driverId }, reason: dto.reason, tripNumber: trip.tripNumber
      }, ctx, m);
      outbox.trips.push({ trip, previousStatus: trip.status });
      outbox.assignments.push({
        tripId: trip.id, driverId, truckId: truck.id, status: 'ACTIVE', previousDriverId: prev.driverId, previousTruckId: prev.truckId
      });
    }).catch(e => this.mapBookingConflict(e));
    this.flush(outbox, cargo);
    return this.result(id, true);
  }

  // ================================================================== driver acceptance & checklist

  async accept(user: AuthUser, id: string, ctx: RequestContext) {
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };
    await this.ds.transaction(async m => {
      const trip = await this.getTrip(id, m, true);
      await this.assertDriverOrDispatcher(user, trip);
      await this.transition(m, trip, 'DRIVER_ACCEPTED', user, 'TRIP_ACCEPTED_BY_DRIVER', ctx, {}, { driverId: trip.primaryDriverId }, outbox);
      cargo = this.cargoRefs((await this.tripCargo(m, trip.id, false)).shipments);
      outbox.assignments.push({ tripId: trip.id, driverId: trip.primaryDriverId, truckId: trip.truckId, status: 'ACCEPTED' });
    });
    this.flush(outbox, cargo);
    return this.result(id);
  }

  async checklist(user: AuthUser, id: string, dto: ChecklistDto, ctx: RequestContext) {
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };
    const failed = dto.items.filter(i => !i.ok);
    const passed = failed.length === 0 && dto.driverAcknowledged === true;
    const stored = await this.ds.transaction(async m => {
      const trip = await this.getTrip(id, m, true);
      await this.assertDriverOrDispatcher(user, trip);
      const allowed = trip.status === 'DRIVER_ACCEPTED' || (trip.status === 'PLANNED' && !trip.requiresDriverAcceptance);
      if (!allowed) {
        throw Errors.conflict(trip.status === 'PLANNED'
          ? `Trip ${trip.tripNumber} must be accepted by the driver before the vehicle check`
          : `Vehicle checklist not allowed in status ${trip.status}`);
      }
      const repo = m.getRepository(TripChecklist);
      const c = await repo.save(repo.create({
        tripId: trip.id, items: dto.items.map(i => ({ item: i.item, ok: i.ok, ...(i.note ? { note: i.note } : {}) })), passed,
        driverAcknowledged: dto.driverAcknowledged, odometerKm: dto.odometerKm ?? null, completedBy: user.name
      }));
      if (passed) {
        await this.transition(m, trip, 'VEHICLE_CHECKED', user, 'TRIP_VEHICLE_CHECKED', ctx, {}, { checklistId: c.id, odometerKm: dto.odometerKm ?? null }, outbox);
      } else {
        await this.event(m, trip.id, 'NOTE', 'Pre-trip checklist failed', user.name, {
          checklistId: c.id, failedItems: failed.map(f => f.item), driverAcknowledged: dto.driverAcknowledged
        });
        await this.audit.record(user, 'TRIP_CHECKLIST_FAILED', trip.id, {
          old: { status: trip.status }, new: { status: trip.status }, checklistId: c.id, failedItems: failed.map(f => ({ item: f.item, note: f.note ?? null })),
          driverAcknowledged: dto.driverAcknowledged
        }, ctx, m);
      }
      cargo = this.cargoRefs((await this.tripCargo(m, trip.id, false)).shipments);
      return c;
    });
    if (!passed) {
      throw Errors.unprocessable('Pre-trip checklist failed: the vehicle cannot proceed', {
        checklistId: stored.id,
        failedItems: failed.map(f => ({ item: f.item, note: f.note ?? null })),
        driverAcknowledged: dto.driverAcknowledged,
        ...(dto.driverAcknowledged ? {} : { reason: 'Driver acknowledgement is required' })
      });
    }
    this.flush(outbox, cargo);
    return { ...(await this.result(id)), checklist: this.checklistToFrontend(stored) };
  }

  // ================================================================== loading

  async startLoading(user: AuthUser, id: string, ctx: RequestContext) {
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };
    await this.ds.transaction(async m => {
      const trip = await this.getTrip(id, m, true);
      const { shipments } = await this.tripCargo(m, trip.id, false);
      this.assertWarehouse(user, [...new Set(shipments.map(s => s.originWarehouseId))], 'origin');
      await this.transition(m, trip, 'LOADING', user, 'TRIP_LOADING_STARTED', ctx, {}, {}, outbox);
      cargo = this.cargoRefs(shipments);
    });
    this.flush(outbox, cargo);
    return this.result(id);
  }

  async recordLoading(user: AuthUser, id: string, dto: LoadingDto, ctx: RequestContext) {
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };
    const discrepancies: Array<{ shipmentId: string; shipmentNumber: string; plannedQuantity: number; loadedQuantity: number; discrepancy: number }> = [];
    await this.ds.transaction(async m => {
      const trip = await this.getTrip(id, m, true);
      if (trip.status !== 'LOADING') throw Errors.conflict(`Loading can only be recorded while the trip is LOADING (is ${trip.status})`);
      const { links, shipments } = await this.tripCargo(m, trip.id);
      cargo = this.cargoRefs(shipments);
      this.assertWarehouse(user, [...new Set(shipments.map(s => s.originWarehouseId))], 'origin');
      const lineIds = dto.lines.map(l => l.shipmentId);
      if (new Set(lineIds).size !== lineIds.length) throw Errors.unprocessable('Each shipment may appear only once in lines');
      const unknown = lineIds.filter(sid => !links.some(l => l.shipmentId === sid));
      if (unknown.length) throw Errors.unprocessable('Shipment(s) are not on this trip', { shipmentIds: unknown });

      const truck = await m.getRepository(Truck).findOne({ where: { id: trip.truckId } });
      const newLoaded = new Map(links.map(l => [l.shipmentId, l.loadedQuantity]));
      for (const line of dto.lines) newLoaded.set(line.shipmentId, r3(line.loadedQuantity));
      const total = r3([...newLoaded.values()].reduce<number>((a, v) => a + (Number(v) || 0), 0));
      if (truck && total > Number(truck.capacityValue) + QTY_EPS) {
        throw Errors.unprocessable(`Loaded quantity ${total} ${truck.capacityUnit} exceeds truck capacity ${truck.capacityValue} ${truck.capacityUnit}`, {
          loadedTotal: total, capacity: truck.capacityValue
        });
      }

      const now = new Date();
      for (const line of dto.lines) {
        const s = shipments.find(x => x.id === line.shipmentId)!;
        if (!['ASSIGNED', 'READY_FOR_DISPATCH'].includes(s.status)) {
          throw Errors.conflict(`Shipment ${s.shipmentNumber} cannot be loaded in status ${s.status}`);
        }
        const loaded = r3(line.loadedQuantity);
        const discrepancy = r3(loaded - s.plannedQuantity);
        await m.getRepository(TripShipment).update({ tripId: trip.id, shipmentId: s.id }, {
          loadedQuantity: loaded, loadingDiscrepancy: discrepancy, loadedAt: now, loadedBy: user.name
        });
        await m.getRepository(Shipment).update({ id: s.id }, { loadedQuantity: loaded });
        s.loadedQuantity = loaded;
        const l = links.find(x => x.shipmentId === s.id)!;
        l.loadedQuantity = loaded;
        if (Math.abs(discrepancy) > QTY_EPS) {
          discrepancies.push({ shipmentId: s.id, shipmentNumber: s.shipmentNumber, plannedQuantity: s.plannedQuantity, loadedQuantity: loaded, discrepancy });
          await this.event(m, trip.id, 'NOTE', `Loading discrepancy on ${s.shipmentNumber}: planned ${s.plannedQuantity} MT, loaded ${loaded} MT (${discrepancy > 0 ? '+' : ''}${discrepancy} MT)`,
            user.name, { kind: 'LOADING_DISCREPANCY', shipmentId: s.id, plannedQuantity: s.plannedQuantity, loadedQuantity: loaded, discrepancy });
          await this.raiseAlert(m, {
            severity: 'MEDIUM_YELLOW', category: 'Inventory', title: `Loading discrepancy ${s.shipmentNumber} (${trip.tripNumber})`,
            trigger: `Planned ${s.plannedQuantity} MT, loaded ${loaded} MT (${discrepancy > 0 ? '+' : ''}${discrepancy} MT)`,
            affectedArea: s.originWarehouseId, actionRequired: 'Verify loaded quantity against the waybill and stock',
            sourceType: 'SHIPMENT', sourceId: s.id, dedupeKey: `loading-discrepancy:${trip.id}:${s.id}`
          }, outbox);
        }
      }
      await this.audit.record(user, 'TRIP_LOADING_RECORDED', trip.id, {
        old: { status: trip.status }, new: { status: trip.status }, tripNumber: trip.tripNumber,
        lines: dto.lines.map(l => ({ shipmentId: l.shipmentId, loadedQuantity: r3(l.loadedQuantity) })), discrepancies
      }, ctx, m);

      const allLoaded = links.every(l => l.loadedQuantity !== null && l.loadedQuantity !== undefined);
      if (allLoaded) {
        for (const s of shipments) {
          if (s.status === 'ASSIGNED') await this.shipmentTo(m, user, s, 'READY_FOR_DISPATCH', 'SHIPMENT_READY_FOR_DISPATCH', ctx, outbox, {}, { tripId: trip.id });
        }
        if (shipments.every(s => s.status === 'READY_FOR_DISPATCH')) {
          await this.transition(m, trip, 'READY', user, 'TRIP_READY', ctx, {}, { loadedTotal: total }, outbox);
        }
      }
    });
    this.flush(outbox, cargo);
    return { ...(await this.result(id)), loadingDiscrepancies: discrepancies };
  }

  // ================================================================== dispatch

  async dispatch(user: AuthUser, id: string, idempotencyKey: string | undefined, ctx: RequestContext) {
    const key = idempotencyKey?.trim() ? `TRIP_DISPATCH:${idempotencyKey.trim()}`.slice(0, 120) : null;
    if (key) {
      const existing = await this.ds.getRepository(IdempotencyKey).findOne({ where: { key } });
      if (existing) return this.replay(existing, id);
    }
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };
    try {
      await this.ds.transaction(async m => {
        if (key) await m.getRepository(IdempotencyKey).insert({ key, scope: 'TRIP_DISPATCH', referenceId: id });
        const trip = await this.getTrip(id, m, true);
        assertTransition('trip', TRIP_TRANSITIONS, trip.status, 'DISPATCHED');
        if (trip.status !== 'READY') throw Errors.conflict(`Trip ${trip.tripNumber} must be READY to dispatch (is ${trip.status})`);
        const { links, shipments } = await this.tripCargo(m, trip.id);
        cargo = this.cargoRefs(shipments);
        if (!shipments.length) throw Errors.conflict('Trip has no shipments');

        // pre-dispatch gates: passed checklist (after the last truck change), cargo loaded, GPS device mapped
        const checklist = await m.getRepository(TripChecklist).findOne({ where: { tripId: trip.id, passed: true }, order: { createdAt: 'DESC' } });
        const lastTruckChange = await m.getRepository(TripEvent).createQueryBuilder('e')
          .where('e.tripId = :id', { id: trip.id }).andWhere(`e.data->>'kind' = 'TRUCK_REASSIGNED'`)
          .orderBy('e.occurredAt', 'DESC').getOne();
        const problems: string[] = [];
        if (!checklist) problems.push('No passed pre-trip checklist');
        else if (lastTruckChange && checklist.createdAt <= lastTruckChange.occurredAt) problems.push('Pre-trip checklist predates the truck reassignment');
        const notLoaded = links.filter(l => l.loadedQuantity === null || l.loadedQuantity === undefined);
        if (notLoaded.length) problems.push(`Not loaded: ${notLoaded.map(l => shipments.find(s => s.id === l.shipmentId)?.shipmentNumber ?? l.shipmentId).join(', ')}`);
        const notReady = shipments.filter(s => s.status !== 'READY_FOR_DISPATCH');
        if (notReady.length) problems.push(`Shipments not READY_FOR_DISPATCH: ${notReady.map(s => `${s.shipmentNumber} (${s.status})`).join(', ')}`);
        if (trip.requiresTracking) {
          const device = await m.getRepository(GpsDevice).createQueryBuilder('d')
            .where('d.truckId = :truckId AND d.deviceStatus <> :retired', { truckId: trip.truckId, retired: 'RETIRED' }).getOne();
          if (!device) problems.push('Truck has no GPS device mapped (tracking required)');
        }
        if (problems.length) throw Errors.unprocessable('Trip cannot be dispatched', { problems });

        const now = new Date();
        for (const s of shipments) {
          const link = links.find(l => l.shipmentId === s.id)!;
          const loaded = Number(link.loadedQuantity) || 0;
          if (s.productId) {
            await this.inventory.dispatchLoaded(s.originWarehouseId, s.productId, loaded, Number(s.reservedQuantity) || 0,
              { type: 'SHIPMENT', id: s.id }, user.name, m);
          }
          // the waybill (legal transport document) is issued at dispatch when the dispatcher did not enter one
          const waybillNumber = s.waybillNumber || (await this.shipments.issueWaybill(m));
          await this.shipmentTo(m, user, s, 'IN_TRANSIT', 'SHIPMENT_IN_TRANSIT', ctx, outbox,
            { reservedQuantity: 0, loadedQuantity: loaded, waybillNumber }, { tripId: trip.id, tripNumber: trip.tripNumber, dispatchedQuantity: loaded, releasedReservation: s.reservedQuantity, waybillNumber });
        }
        await this.fleet.setAvailability(trip.truckId, 'ON_TRIP', m);
        await this.drivers.setAvailability(trip.primaryDriverId, 'ON_TRIP', m);
        await this.transition(m, trip, 'DISPATCHED', user, 'TRIP_DISPATCHED', ctx, { actualStartAt: now },
          { dispatchedBy: user.name, dispatchedByRole: user.role, dispatchedAt: now.toISOString(), idempotencyKey: idempotencyKey ?? null }, outbox, now);
        outbox.assignments.push({ tripId: trip.id, driverId: trip.primaryDriverId, truckId: trip.truckId, status: 'ON_TRIP' });
      });
    } catch (e) {
      if (key && uniqueViolation(e)) {
        const existing = await this.ds.getRepository(IdempotencyKey).findOne({ where: { key } });
        if (existing) return this.replay(existing, id);
      }
      throw e;
    }

    this.flush(outbox, cargo);
    this.routing.refreshEta(id, true).then(
      r => {
        if (r?.estimatedArrivalAt) {
          this.realtime.publish('shipment.eta.updated', { tripId: id, shipmentIds: cargo.shipmentIds, warehouseIds: cargo.warehouseIds },
            { tripId: id, estimatedArrivalAt: iso(r.estimatedArrivalAt), remainingDistanceKm: r.remainingDistanceKm });
        }
      },
      err => this.logger.warn(`ETA refresh after dispatch failed for trip ${id}: ${err?.message ?? err}`)
    );
    const response = await this.result(id, true);
    if (key) await this.ds.getRepository(IdempotencyKey).update({ key }, { response: response as any }).catch(() => undefined);
    return response;
  }

  private async replay(existing: IdempotencyKey, tripId: string) {
    if (existing.referenceId !== tripId) throw Errors.conflict('Idempotency-Key was already used for a different trip', { referenceId: existing.referenceId });
    if (existing.response) return existing.response;
    return this.result(tripId, true);
  }

  // ================================================================== in transit

  /** ARRIVED transition + IN_TRANSIT shipments → ARRIVED (not when the truck returned to origin). */
  private async doArrive(m: EntityManager, trip: Trip, actor: Actor, ctx: RequestContext, reason: string | null, at: Date, outbox: Outbox) {
    const from = trip.status;
    await this.transition(m, trip, 'ARRIVED', actor, 'TRIP_ARRIVED', ctx, { actualArrivalAt: at }, reason ? { reason } : {}, outbox, at);
    if (from === 'RETURNING') return;
    const { shipments } = await this.tripCargo(m, trip.id);
    for (const s of shipments) {
      if (s.status === 'IN_TRANSIT') await this.shipmentTo(m, actor, s, 'ARRIVED', 'SHIPMENT_ARRIVED', ctx, outbox, {}, { tripId: trip.id });
    }
  }

  async arrive(user: AuthUser, id: string, ctx: RequestContext) {
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };
    await this.ds.transaction(async m => {
      const trip = await this.getTrip(id, m, true);
      const { shipments } = await this.tripCargo(m, trip.id, false);
      cargo = this.cargoRefs(shipments);
      await this.assertDriverOrDispatcher(user, trip);
      this.assertWarehouse(user, [...new Set(shipments.map(s => s.destinationWarehouseId))], 'destination');
      await this.doArrive(m, trip, user, ctx, null, new Date(), outbox);
    });
    this.flush(outbox, cargo);
    return this.result(id);
  }

  async unloading(user: AuthUser, id: string, ctx: RequestContext) {
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };
    await this.ds.transaction(async m => {
      const trip = await this.getTrip(id, m, true);
      const { shipments } = await this.tripCargo(m, trip.id, false);
      cargo = this.cargoRefs(shipments);
      this.assertWarehouse(user, [...new Set(shipments.map(s => s.destinationWarehouseId))], 'destination');
      await this.transition(m, trip, 'UNLOADING', user, 'TRIP_UNLOADING', ctx, {}, {}, outbox);
    });
    this.flush(outbox, cargo);
    return this.result(id);
  }

  async complete(user: AuthUser, id: string, ctx: RequestContext) {
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };
    let kpi: Record<string, unknown> = {};
    const thresholds = await logisticsThresholds(this.settings);
    await this.ds.transaction(async m => {
      const trip = await this.getTrip(id, m, true);
      assertTransition('trip', TRIP_TRANSITIONS, trip.status, 'COMPLETED');
      const { links, shipments } = await this.tripCargo(m, trip.id);
      cargo = this.cargoRefs(shipments);
      const open = shipments.filter(s => !['DELIVERED', 'DELIVERY_FAILED', 'CLOSED', 'CANCELLED'].includes(s.status));
      if (open.length) {
        throw Errors.conflict('All shipments must be DELIVERED or DELIVERY_FAILED before the trip can be completed', {
          shipments: open.map(s => ({ id: s.id, shipmentNumber: s.shipmentNumber, status: s.status }))
        });
      }
      const now = new Date();
      const plannedQty = r3(shipments.reduce((a, s) => a + (Number(s.plannedQuantity) || 0), 0));
      const loadedQty = r3(links.reduce((a, l) => a + (Number(l.loadedQuantity) || 0), 0));
      const deliveredQty = r3(shipments.reduce((a, s) => a + (Number(s.deliveredQuantity) || 0), 0));
      const plannedArrival = Math.max(...shipments.map(s => new Date(s.plannedDeliveryAt).getTime()));
      const arrival = trip.actualArrivalAt ? new Date(trip.actualArrivalAt).getTime() : now.getTime();
      kpi = {
        durationMin: trip.actualStartAt ? Math.round((now.getTime() - new Date(trip.actualStartAt).getTime()) / 60000) : null,
        onTime: Number.isFinite(plannedArrival) ? arrival <= plannedArrival + thresholds.delayToleranceMinutes * 60000 : null,
        plannedQty, loadedQty, deliveredQty,
        discrepancy: r3(deliveredQty - loadedQty),
        shipments: shipments.length,
        failedShipments: shipments.filter(s => s.status === 'DELIVERY_FAILED').length
      };
      for (const s of shipments) {
        if (s.status === 'DELIVERED') await this.shipmentTo(m, user, s, 'CLOSED', 'SHIPMENT_CLOSED', ctx, outbox, {}, { tripId: trip.id });
      }
      await this.transition(m, trip, 'COMPLETED', user, 'TRIP_COMPLETED', ctx, { completedAt: now }, { kpi }, outbox, now);
      await this.shipments.releaseTripResources(m, trip, 'RELEASED');
      outbox.assignments.push({ tripId: trip.id, driverId: trip.primaryDriverId, truckId: trip.truckId, status: 'RELEASED' });
    });
    this.flush(outbox, cargo);
    return { ...(await this.result(id)), kpi };
  }

  async incident(user: AuthUser, id: string, dto: IncidentDto, ctx: RequestContext) {
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };
    const ev = await this.ds.transaction(async m => {
      const trip = await this.getTrip(id, m, true);
      await this.assertDriverOrDispatcher(user, trip);
      if (['COMPLETED', 'ABORTED'].includes(trip.status)) throw Errors.conflict(`Trip ${trip.tripNumber} is ${trip.status}`);
      cargo = this.cargoRefs((await this.tripCargo(m, trip.id, false)).shipments);
      const severity = dto.severity ?? (dto.type === 'INCIDENT' ? 'MEDIUM' : null);
      const e = await this.event(m, trip.id, dto.type, dto.description, user.name, { reportedByRole: user.role }, { severity, lat: dto.lat ?? null, lng: dto.lng ?? null });
      await this.audit.record(user, 'TRIP_EVENT_LOGGED', trip.id, {
        old: { status: trip.status }, new: { status: trip.status }, eventId: e.id, type: dto.type, severity
      }, ctx, m);
      const serious = dto.type === 'INCIDENT' && (severity === 'HIGH' || severity === 'CRITICAL');
      if (serious) {
        if (canTransition(TRIP_TRANSITIONS, trip.status, 'INCIDENT')) {
          await this.transition(m, trip, 'INCIDENT', user, 'TRIP_INCIDENT', ctx, {}, { eventId: e.id, severity, reason: dto.description }, outbox);
        }
        await this.raiseAlert(m, {
          severity: severity === 'CRITICAL' ? 'CRITICAL_RED' : 'HIGH_ORANGE', category: 'Logistics',
          title: `Trip incident ${trip.tripNumber} (${severity})`, trigger: dto.description,
          affectedArea: dto.lat !== undefined && dto.lng !== undefined ? `${dto.lat},${dto.lng}` : null,
          actionRequired: 'Contact the driver and decide: resume, return or abort the trip',
          sourceType: 'TRIP', sourceId: trip.id, dedupeKey: `trip-incident:${e.id}`
        }, outbox);
      }
      if (!outbox.trips.length) outbox.trips.push({ trip, previousStatus: trip.status });
      return e;
    });
    this.flush(outbox, cargo);
    return { event: this.eventToFrontend(ev), trip: await this.result(id) };
  }

  async resume(user: AuthUser, id: string, ctx: RequestContext) {
    return this.simple(user, id, 'IN_PROGRESS', 'TRIP_RESUMED', ctx, null, true);
  }

  async returnTrip(user: AuthUser, id: string, dto: TripReasonDto, ctx: RequestContext) {
    return this.simple(user, id, 'RETURNING', 'TRIP_RETURNING', ctx, dto.reason, false);
  }

  private async simple(user: AuthUser, id: string, to: string, action: string, ctx: RequestContext, reason: string | null, driverCheck: boolean) {
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };
    await this.ds.transaction(async m => {
      const trip = await this.getTrip(id, m, true);
      if (driverCheck) await this.assertDriverOrDispatcher(user, trip);
      if (to === 'IN_PROGRESS' && trip.status !== 'INCIDENT') throw Errors.conflict(`Only a trip in INCIDENT can be resumed (is ${trip.status})`);
      cargo = this.cargoRefs((await this.tripCargo(m, trip.id, false)).shipments);
      await this.transition(m, trip, to, user, action, ctx, {}, reason ? { reason } : {}, outbox);
    });
    this.flush(outbox, cargo);
    return this.result(id);
  }

  async abort(user: AuthUser, id: string, dto: TripReasonDto, ctx: RequestContext) {
    const outbox = newOutbox();
    let cargo = { shipmentIds: [] as string[], warehouseIds: [] as string[] };
    await this.ds.transaction(async m => {
      const trip = await this.getTrip(id, m, true);
      assertTransition('trip', TRIP_TRANSITIONS, trip.status, 'ABORTED');
      const { shipments } = await this.tripCargo(m, trip.id);
      cargo = this.cargoRefs(shipments);
      for (const s of shipments) {
        const effective = s.status === 'ON_HOLD' ? s.statusBeforeHold || 'DRAFT' : s.status;
        if (PRE_TRANSIT_SHIPMENT_STATES.includes(effective)) {
          // not dispatched: release the reservation and return the shipment to PLANNED so it can be re-tripped
          if (s.reservedQuantity > 0 && s.productId) {
            await this.inventory.release(s.originWarehouseId, s.productId, s.reservedQuantity, { type: 'SHIPMENT', id: s.id }, user.name, m);
          }
          const released = s.reservedQuantity;
          if (s.status === 'ON_HOLD') {
            await m.getRepository(Shipment).update({ id: s.id }, { reservedQuantity: 0, loadedQuantity: null, statusBeforeHold: 'PLANNED' });
            await this.audit.record(user, 'SHIPMENT_TRIP_ABORTED', s.id, {
              old: { status: s.status }, new: { status: s.status }, statusBeforeHold: 'PLANNED', tripId: trip.id, releasedReservation: released, reason: dto.reason
            }, ctx, m);
            continue;
          }
          const path = s.status === 'READY_FOR_DISPATCH' ? ['ASSIGNED', 'PLANNED'] : s.status === 'ASSIGNED' ? ['PLANNED'] : [];
          let cur = s.status;
          for (const step of path) { assertTransition('shipment', SHIPMENT_TRANSITIONS, cur, step); cur = step; }
          const from = s.status;
          await m.getRepository(Shipment).update({ id: s.id }, { status: cur, reservedQuantity: 0, loadedQuantity: null });
          Object.assign(s, { status: cur, reservedQuantity: 0, loadedQuantity: null });
          await this.audit.record(user, 'SHIPMENT_TRIP_ABORTED', s.id, {
            old: { status: from }, new: { status: cur }, tripId: trip.id, releasedReservation: released, reason: dto.reason
          }, ctx, m);
          if (from !== cur) outbox.shipments.push({ shipment: s, previousStatus: from });
        } else if (['IN_TRANSIT', 'ARRIVED'].includes(s.status) || (s.status === 'ON_HOLD' && effective === 'IN_TRANSIT')) {
          const liftedHold = s.status === 'ON_HOLD';
          if (liftedHold) {
            // ON_HOLD → (IN_TRANSIT) → DELIVERY_FAILED: the hold is lifted implicitly by the abort
            assertTransition('shipment', SHIPMENT_TRANSITIONS, s.status, 'IN_TRANSIT');
            s.status = 'IN_TRANSIT';
          }
          await this.shipmentTo(m, user, s, 'DELIVERY_FAILED', 'SHIPMENT_DELIVERY_FAILED', ctx, outbox,
            { statusBeforeHold: null, holdReason: liftedHold ? null : s.holdReason }, { tripId: trip.id, reason: dto.reason, liftedHold });
        }
      }
      await this.transition(m, trip, 'ABORTED', user, 'TRIP_ABORTED', ctx, { abortReason: dto.reason }, { reason: dto.reason }, outbox);
      await this.shipments.releaseTripResources(m, trip, 'RELEASED');
      outbox.assignments.push({ tripId: trip.id, driverId: trip.primaryDriverId, truckId: trip.truckId, status: 'RELEASED' });
    });
    this.flush(outbox, cargo);
    return this.result(id);
  }
}
