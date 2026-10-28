import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, In, SelectQueryBuilder } from 'typeorm';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { Errors } from '../../../common/utils/errors';
import { ACTIVE_TRIP_STATES, SHIPMENT_TRANSITIONS, assertTransition } from '../../../common/utils/state-machine';
import { applySearch } from '../../../common/utils/query-filters';
import { AuditService } from '../../audit/audit.service';
import { AuditLog } from '../../audit/entities/audit-log.entity';
import { DriverTripAssignment } from '../drivers/entities/driver.entities';
import { DriversService } from '../drivers/drivers.service';
import { FleetService } from '../fleet/fleet.service';
import { Paged, pageParams } from '../logistics.constants';
import { RealtimeService } from '../realtime/realtime.service';
import { Route } from '../routing/entities/routing.entities';
import { InventoryService } from '../warehouses/inventory.service';
import { Product, Warehouse } from '../warehouses/entities/warehouse.entities';
import { CreateShipmentDto, ListShipmentsQueryDto, PlanShipmentDto, ReasonDto, UpdateShipmentDto } from './dto/shipment.dto';
import { Delivery, Shipment, Trip, TripEvent, TripShipment } from './entities/shipment.entities';
import {
  LogisticsScope, PRE_DISPATCH_TRIP_STATES, PRE_TRANSIT_SHIPMENT_STATES, QTY_EPS, SHIPMENT_NUMBER_LOCK, iso, isDriver, isFleetWide,
  isWarehouseOperator, r3, stampToIso
} from './shipments.util';

const PICKUP_SKEW_MS = 15 * 60 * 1000;

interface FrontendCache {
  warehouses?: Map<string, Warehouse>;
  products?: Map<string, Product>;
  trips?: Map<string, { id: string; tripNumber: string; status: string; truckId: string; primaryDriverId: string } | null>;
}

export interface ShipmentChange {
  shipment: Shipment;
  previousStatus: string | null;
}

/**
 * Shipments = cargo movement requests (Logistics doc §9.1, §10 steps 27–31): creation with transactional stock reservation,
 * planning, hold / release, cancellation. Also hosts the visibility scope shared with trips and deliveries.
 */
@Injectable()
export class ShipmentsService {
  constructor(
    @InjectDataSource() readonly ds: DataSource,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly drivers: DriversService,
    private readonly fleet: FleetService,
    private readonly inventory: InventoryService
  ) {}

  // ------------------------------------------------------------------ scope

  /** Visibility scope of a user (FLEET_WIDE → all; DRIVER → own trips; WAREHOUSE_OPERATOR → own warehouse; REGION → region warehouses). */
  async scopeFor(user: AuthUser): Promise<LogisticsScope> {
    if (isFleetWide(user)) return { kind: 'ALL' };
    if (isDriver(user)) {
      const d = await this.drivers.driverForUser(user.id);
      return { kind: 'DRIVER', driverId: d?.id ?? null };
    }
    if (isWarehouseOperator(user)) return { kind: 'WAREHOUSE', warehouseId: user.warehouseId ?? null };
    return { kind: 'REGION', regionId: user.regionId ?? null };
  }

  /** Restrict a Shipment query builder (alias) to the scope. */
  applyScope(qb: SelectQueryBuilder<any>, alias: string, scope: LogisticsScope) {
    switch (scope.kind) {
      case 'ALL':
        return;
      case 'DRIVER':
        if (!scope.driverId) { qb.andWhere('1=0'); return; }
        qb.andWhere(
          `${alias}.id IN (SELECT ts.shipment_id FROM trip_shipments ts JOIN trips t ON t.id = ts.trip_id WHERE t.primary_driver_id = :scopeDriverId)`,
          { scopeDriverId: scope.driverId }
        );
        return;
      case 'WAREHOUSE':
        if (!scope.warehouseId) { qb.andWhere('1=0'); return; }
        qb.andWhere(`(${alias}.originWarehouseId = :scopeWh OR ${alias}.destinationWarehouseId = :scopeWh)`, { scopeWh: scope.warehouseId });
        return;
      case 'REGION':
        if (!scope.regionId) { qb.andWhere('1=0'); return; }
        qb.andWhere(
          `(${alias}.originWarehouseId IN (SELECT w.id FROM warehouses w WHERE w.region_id = :scopeRegion) OR ${alias}.destinationWarehouseId IN (SELECT w.id FROM warehouses w WHERE w.region_id = :scopeRegion))`,
          { scopeRegion: scope.regionId }
        );
    }
  }

  /** 403 unless the shipment is visible to the user. */
  async assertVisible(user: AuthUser, s: Shipment, scope?: LogisticsScope): Promise<void> {
    const sc = scope ?? (await this.scopeFor(user));
    if (sc.kind === 'ALL') return;
    if (sc.kind === 'WAREHOUSE') {
      if (sc.warehouseId && (s.originWarehouseId === sc.warehouseId || s.destinationWarehouseId === sc.warehouseId)) return;
    } else if (sc.kind === 'DRIVER') {
      if (sc.driverId) {
        const n = await this.ds.getRepository(TripShipment).createQueryBuilder('ts')
          .innerJoin(Trip, 't', 't.id = ts.tripId')
          .where('ts.shipmentId = :sid AND t.primaryDriverId = :did', { sid: s.id, did: sc.driverId })
          .getCount();
        if (n > 0) return;
      }
    } else if (sc.regionId) {
      const n = await this.ds.getRepository(Warehouse).count({ where: { id: In([s.originWarehouseId, s.destinationWarehouseId]), regionId: sc.regionId } });
      if (n > 0) return;
    }
    throw Errors.forbidden('This shipment is outside your logistics scope');
  }

  // ------------------------------------------------------------------ frontend shape

  /** Current (latest non-aborted) trip of each shipment. */
  async currentTrips(shipmentIds: string[], manager?: EntityManager) {
    const out = new Map<string, { id: string; tripNumber: string; status: string; truckId: string; primaryDriverId: string } | null>();
    if (!shipmentIds.length) return out;
    const rows = await (manager ?? this.ds.manager).getRepository(TripShipment).createQueryBuilder('ts')
      .innerJoin(Trip, 't', 't.id = ts.tripId')
      .select(['ts.shipmentId AS "shipmentId"', 't.id AS "id"', 't.tripNumber AS "tripNumber"', 't.status AS "status"', 't.truckId AS "truckId"',
        't.primaryDriverId AS "primaryDriverId"', 't.createdAt AS "createdAt"'])
      .where('ts.shipmentId IN (:...ids)', { ids: shipmentIds })
      .andWhere(`t.status <> 'ABORTED'`)
      .orderBy('t.createdAt', 'DESC')
      .getRawMany();
    for (const id of shipmentIds) out.set(id, null);
    for (const r of rows) if (!out.get(r.shipmentId)) out.set(r.shipmentId, { id: r.id, tripNumber: r.tripNumber, status: r.status, truckId: r.truckId, primaryDriverId: r.primaryDriverId });
    return out;
  }

  private async buildCache(list: Shipment[]): Promise<FrontendCache> {
    const whIds = [...new Set(list.flatMap(s => [s.originWarehouseId, s.destinationWarehouseId]))];
    const prodIds = [...new Set(list.map(s => s.productId).filter(Boolean) as string[])];
    const [whs, prods, trips] = await Promise.all([
      whIds.length ? this.ds.getRepository(Warehouse).findBy({ id: In(whIds) }) : Promise.resolve([] as Warehouse[]),
      prodIds.length ? this.ds.getRepository(Product).findBy({ id: In(prodIds) }) : Promise.resolve([] as Product[]),
      this.currentTrips(list.map(s => s.id))
    ]);
    return { warehouses: new Map(whs.map(w => [w.id, w])), products: new Map(prods.map(p => [p.id, p])), trips };
  }

  /** API shape of a shipment (ISO timestamps). */
  async shipmentToFrontend(s: Shipment, cache?: FrontendCache): Promise<any> {
    const c = cache ?? (await this.buildCache([s]));
    const wh = (id: string) => {
      const w = c.warehouses?.get(id);
      return w ? { id: w.id, code: w.code, name: w.name, regionId: w.regionId } : null;
    };
    const p = s.productId ? c.products?.get(s.productId) : null;
    const loaded = s.loadedQuantity;
    const delivered = Number(s.deliveredQuantity) || 0;
    return {
      id: s.id,
      shipmentNumber: s.shipmentNumber,
      waybillNumber: s.waybillNumber,
      customerName: s.customerName,
      originWarehouseId: s.originWarehouseId,
      originWarehouse: wh(s.originWarehouseId),
      destinationWarehouseId: s.destinationWarehouseId,
      destinationWarehouse: wh(s.destinationWarehouseId),
      productId: s.productId,
      product: p ? { id: p.id, sku: p.sku, name: p.name, cargoType: p.cargoType } : null,
      cargoDescription: s.cargoDescription,
      plannedQuantity: s.plannedQuantity,
      quantityUnit: s.quantityUnit,
      priority: s.priority,
      plannedPickupAt: iso(s.plannedPickupAt),
      plannedDeliveryAt: iso(s.plannedDeliveryAt),
      routeId: s.routeId,
      quotaAllocationId: s.quotaAllocationId,
      qrLot: s.qrLot,
      status: s.status,
      statusBeforeHold: s.statusBeforeHold,
      isDelayed: s.isDelayed,
      estimatedArrivalAt: iso(s.estimatedArrivalAt),
      reservedQuantity: s.reservedQuantity,
      loadedQuantity: loaded,
      deliveredQuantity: delivered,
      /** received − loaded once something was received (negative = shortage) */
      discrepancyQuantity: loaded !== null && loaded !== undefined && delivered > 0 ? r3(delivered - loaded) : null,
      holdReason: s.holdReason,
      cancelReason: s.cancelReason,
      currentTrip: c.trips?.get(s.id) ?? null,
      createdBy: s.createdBy,
      createdAt: iso(s.createdAt),
      updatedAt: iso(s.updatedAt)
    };
  }

  async manyToFrontend(list: Shipment[]): Promise<any[]> {
    if (!list.length) return [];
    const cache = await this.buildCache(list);
    return Promise.all(list.map(s => this.shipmentToFrontend(s, cache)));
  }

  // ------------------------------------------------------------------ queries

  async list(user: AuthUser, q: ListShipmentsQueryDto): Promise<Paged<any>> {
    const { page, pageSize, skip, take } = pageParams(q);
    const qb = this.ds.getRepository(Shipment).createQueryBuilder('s');
    this.applyScope(qb, 's', await this.scopeFor(user));
    if (q.status) {
      const statuses = q.status.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
      if (statuses.includes('DELAYED')) {
        const rest = statuses.filter(x => x !== 'DELAYED');
        qb.andWhere(new Brackets(b => {
          b.where('s.isDelayed = true');
          if (rest.length) b.orWhere('s.status IN (:...statuses)', { statuses: rest });
        }));
      } else if (statuses.length) qb.andWhere('s.status IN (:...statuses)', { statuses });
    }
    if (q.delayed !== undefined) qb.andWhere('s.isDelayed = :delayed', { delayed: q.delayed });
    if (q.warehouseId) qb.andWhere('(s.originWarehouseId = :wh OR s.destinationWarehouseId = :wh)', { wh: q.warehouseId });
    applySearch(qb, ['s.shipmentNumber', 's.waybillNumber', 's.customerName', 's.cargoDescription', 's.qrLot'], q.q);
    if (q.from) qb.andWhere('s.plannedPickupAt >= :from', { from: new Date(q.from) });
    if (q.to) qb.andWhere('s.plannedPickupAt <= :to', { to: new Date(q.to) });
    const [rows, total] = await qb.orderBy('s.createdAt', 'DESC').skip(skip).take(take).getManyAndCount();
    return { items: await this.manyToFrontend(rows), total, page, pageSize };
  }

  async getRow(id: string, manager?: EntityManager, lock = false): Promise<Shipment> {
    const repo = (manager ?? this.ds.manager).getRepository(Shipment);
    const qb = repo.createQueryBuilder('s').where('s.id = :id', { id });
    if (lock) qb.setLock('pessimistic_write');
    const s = await qb.getOne();
    if (!s) throw Errors.notFound('Shipment');
    return s;
  }

  async getVisible(user: AuthUser, id: string): Promise<Shipment> {
    const s = await this.getRow(id);
    await this.assertVisible(user, s);
    return s;
  }

  /** Shipment detail: trips, deliveries and a timeline from the audit trail + trip events. */
  async detail(user: AuthUser, id: string) {
    const s = await this.getVisible(user, id);
    const out = await this.shipmentToFrontend(s);
    const links = await this.ds.getRepository(TripShipment).find({ where: { shipmentId: s.id } });
    const tripIds = links.map(l => l.tripId);
    const trips = tripIds.length ? await this.ds.getRepository(Trip).find({ where: { id: In(tripIds) }, order: { createdAt: 'ASC' } }) : [];
    const deliveries = await this.ds.getRepository(Delivery).find({ where: { shipmentId: s.id }, order: { deliveredAt: 'ASC' } });
    const events = tripIds.length ? await this.ds.getRepository(TripEvent).find({ where: { tripId: In(tripIds) }, order: { occurredAt: 'ASC' } }) : [];
    const audits = await this.ds.getRepository(AuditLog).find({ where: { target: s.id }, order: { seq: 'ASC' }, take: 500 });

    const tripNo = new Map(trips.map(t => [t.id, t.tripNumber]));
    const timeline = [
      ...audits.map(a => ({
        at: stampToIso(a.timestamp), source: 'AUDIT', type: a.action, actor: a.userName, role: a.role,
        details: a.details ? safeJson(a.details) : null
      })),
      ...events.map(e => ({
        at: iso(e.occurredAt), source: 'TRIP_EVENT', type: e.type, actor: e.recordedBy, tripId: e.tripId, tripNumber: tripNo.get(e.tripId) ?? null,
        severity: e.severity, description: e.description, details: e.data
      }))
    ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

    return {
      ...out,
      trips: trips.map(t => {
        const l = links.find(x => x.tripId === t.id)!;
        return {
          id: t.id, tripNumber: t.tripNumber, status: t.status, truckId: t.truckId, primaryDriverId: t.primaryDriverId,
          plannedStartAt: iso(t.plannedStartAt), actualStartAt: iso(t.actualStartAt), estimatedArrivalAt: iso(t.estimatedArrivalAt),
          actualArrivalAt: iso(t.actualArrivalAt), completedAt: iso(t.completedAt),
          stopSequence: l.stopSequence, loadedQuantity: l.loadedQuantity, loadingDiscrepancy: l.loadingDiscrepancy, loadedAt: iso(l.loadedAt), loadedBy: l.loadedBy
        };
      }),
      deliveries: deliveries.map(d => deliveryToFrontend(d)),
      timeline
    };
  }

  // ------------------------------------------------------------------ validation helpers

  private async activeWarehouse(id: string, label: string, m: EntityManager): Promise<Warehouse> {
    const w = await m.getRepository(Warehouse).findOne({ where: { id } });
    if (!w) throw Errors.unprocessable(`${label} warehouse not found`, { field: label === 'Origin' ? 'originWarehouseId' : 'destinationWarehouseId' });
    if (w.status !== 'ACTIVE') throw Errors.unprocessable(`${label} warehouse ${w.name} is not ACTIVE (${w.status})`);
    return w;
  }

  private async validateRoute(routeId: string, origin: string, destination: string, m: EntityManager): Promise<Route> {
    const r = await m.getRepository(Route).findOne({ where: { id: routeId } });
    if (!r) throw Errors.unprocessable('Route not found', { field: 'routeId' });
    if (!r.active) throw Errors.unprocessable(`Route ${r.code} is inactive`);
    if (r.originWarehouseId !== origin || r.destinationWarehouseId !== destination) {
      throw Errors.unprocessable(`Route ${r.code} does not connect the shipment origin and destination`, {
        routeOrigin: r.originWarehouseId, routeDestination: r.destinationWarehouseId, origin, destination
      });
    }
    return r;
  }

  private validateWindow(pickup: Date, delivery: Date, checkPast: boolean) {
    if (Number.isNaN(pickup.getTime()) || Number.isNaN(delivery.getTime())) throw Errors.unprocessable('Invalid planned pickup/delivery time');
    if (pickup.getTime() >= delivery.getTime()) throw Errors.unprocessable('plannedPickupAt must be before plannedDeliveryAt');
    if (checkPast && pickup.getTime() < Date.now() - PICKUP_SKEW_MS) throw Errors.unprocessable('plannedPickupAt cannot be in the past');
  }

  /** Normalised waybill number, 409 when another shipment already carries it. */
  private async assertWaybillFree(m: EntityManager, waybill: string | null | undefined, exceptId?: string): Promise<string | null> {
    const v = waybill?.trim().toUpperCase() || null;
    if (!v) return null;
    const qb = m.getRepository(Shipment).createQueryBuilder('s').where('s.waybillNumber = :v', { v });
    if (exceptId) qb.andWhere('s.id <> :id', { id: exceptId });
    const other = await qb.getOne();
    if (other) throw Errors.conflict(`Waybill ${v} is already used by ${other.shipmentNumber}`, { field: 'waybillNumber' });
    return v;
  }

  /** WB-<year>-<6 digits> from a database sequence (gap-tolerant, concurrency-safe). */
  async issueWaybill(m: EntityManager): Promise<string> {
    const [row] = await m.query("SELECT nextval('waybill_number_seq') AS n");
    return `WB-${new Date().getUTCFullYear()}-${String(row.n).padStart(6, '0')}`;
  }

  private async nextShipmentNumber(m: EntityManager): Promise<string> {
    await m.query('SELECT pg_advisory_xact_lock($1)', [SHIPMENT_NUMBER_LOCK]);
    const [row] = await m.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(shipment_number FROM 4) AS INTEGER)), 1000) AS n FROM shipments WHERE shipment_number ~ '^SH-[0-9]+$'`
    );
    return `SH-${Number(row?.n ?? 1000) + 1}`;
  }

  // ------------------------------------------------------------------ commands

  async create(user: AuthUser, dto: CreateShipmentDto, ctx: RequestContext) {
    if (dto.originWarehouseId === dto.destinationWarehouseId) throw Errors.unprocessable('Origin and destination warehouse must differ');
    const pickup = new Date(dto.plannedPickupAt);
    const delivery = new Date(dto.plannedDeliveryAt);
    this.validateWindow(pickup, delivery, true);
    const qty = r3(dto.plannedQuantity);
    if (!(qty > 0)) throw Errors.unprocessable('plannedQuantity must be greater than 0');

    const saved = await this.ds.transaction(async m => {
      await this.activeWarehouse(dto.originWarehouseId, 'Origin', m);
      await this.activeWarehouse(dto.destinationWarehouseId, 'Destination', m);
      if (dto.productId) {
        const p = await m.getRepository(Product).findOne({ where: { id: dto.productId } });
        if (!p) throw Errors.unprocessable('Product not found', { field: 'productId' });
        if (!p.active) throw Errors.unprocessable(`Product ${p.sku} is inactive`);
      }
      if (dto.routeId) await this.validateRoute(dto.routeId, dto.originWarehouseId, dto.destinationWarehouseId, m);

      const shipmentNumber = await this.nextShipmentNumber(m);
      const repo = m.getRepository(Shipment);
      const s = await repo.save(repo.create({
        shipmentNumber,
        customerName: dto.customerName ?? null,
        originWarehouseId: dto.originWarehouseId,
        destinationWarehouseId: dto.destinationWarehouseId,
        productId: dto.productId ?? null,
        cargoDescription: dto.cargoDescription,
        plannedQuantity: qty,
        quantityUnit: 'MT',
        priority: dto.priority ?? 'NORMAL',
        plannedPickupAt: pickup,
        plannedDeliveryAt: delivery,
        routeId: dto.routeId ?? null,
        quotaAllocationId: dto.quotaAllocationId ?? null,
        qrLot: dto.qrLot ?? null,
        waybillNumber: await this.assertWaybillFree(m, dto.waybillNumber),
        status: 'DRAFT',
        reservedQuantity: 0,
        createdBy: user.name
      }));
      if (s.productId && dto.reserveStock !== false) {
        await this.inventory.reserve(s.originWarehouseId, s.productId, qty, { type: 'SHIPMENT', id: s.id }, user.name, m, { preferLotNumber: s.qrLot });
        s.reservedQuantity = qty;
        await repo.update({ id: s.id }, { reservedQuantity: qty });
      }
      await this.audit.record(user, 'SHIPMENT_CREATED', s.id, {
        old: null, new: { status: 'DRAFT' }, shipmentNumber, plannedQuantity: qty, reservedQuantity: s.reservedQuantity,
        originWarehouseId: s.originWarehouseId, destinationWarehouseId: s.destinationWarehouseId
      }, ctx, m);
      return s;
    });
    this.publishShipments([{ shipment: saved, previousStatus: null }]);
    return this.shipmentToFrontend(await this.getRow(saved.id));
  }

  async update(user: AuthUser, id: string, dto: UpdateShipmentDto, ctx: RequestContext) {
    const result = await this.ds.transaction(async m => {
      const s = await this.getRow(id, m, true);
      if (!['DRAFT', 'PLANNED'].includes(s.status)) throw Errors.conflict(`Shipment ${s.shipmentNumber} can only be edited while DRAFT or PLANNED (is ${s.status})`);
      const before = { ...s };

      const origin = dto.originWarehouseId ?? s.originWarehouseId;
      const destination = dto.destinationWarehouseId ?? s.destinationWarehouseId;
      if (origin === destination) throw Errors.unprocessable('Origin and destination warehouse must differ');
      if (dto.originWarehouseId && dto.originWarehouseId !== s.originWarehouseId) await this.activeWarehouse(origin, 'Origin', m);
      if (dto.destinationWarehouseId && dto.destinationWarehouseId !== s.destinationWarehouseId) await this.activeWarehouse(destination, 'Destination', m);
      const pickup = dto.plannedPickupAt ? new Date(dto.plannedPickupAt) : s.plannedPickupAt;
      const delivery = dto.plannedDeliveryAt ? new Date(dto.plannedDeliveryAt) : s.plannedDeliveryAt;
      this.validateWindow(new Date(pickup), new Date(delivery), !!dto.plannedPickupAt);
      const productId = dto.productId ?? s.productId;
      if (dto.productId && dto.productId !== s.productId) {
        const p = await m.getRepository(Product).findOne({ where: { id: dto.productId } });
        if (!p) throw Errors.unprocessable('Product not found', { field: 'productId' });
        if (!p.active) throw Errors.unprocessable(`Product ${p.sku} is inactive`);
      }
      const routeId = dto.routeId ?? s.routeId;
      if (routeId && (dto.routeId || origin !== s.originWarehouseId || destination !== s.destinationWarehouseId)) {
        await this.validateRoute(routeId, origin, destination, m);
      }
      const qty = dto.plannedQuantity !== undefined ? r3(dto.plannedQuantity) : s.plannedQuantity;

      // Re-reserve when quantity / origin / product changed (release the old reservation, reserve the new quantity)
      const stockKeyChanged = qty !== s.plannedQuantity || origin !== s.originWarehouseId || productId !== s.productId;
      let reserved = s.reservedQuantity;
      if (stockKeyChanged || (dto.reserveStock === true && reserved <= 0)) {
        const shouldReserve = !!productId && (reserved > 0 || dto.reserveStock === true) && dto.reserveStock !== false;
        if (reserved > 0 && s.productId) {
          await this.inventory.release(s.originWarehouseId, s.productId, reserved, { type: 'SHIPMENT', id: s.id }, user.name, m);
          reserved = 0;
        }
        if (shouldReserve) {
          await this.inventory.reserve(origin, productId!, qty, { type: 'SHIPMENT', id: s.id }, user.name, m, { preferLotNumber: dto.qrLot ?? s.qrLot });
          reserved = qty;
        }
      } else if (dto.reserveStock === false && reserved > 0 && s.productId) {
        await this.inventory.release(s.originWarehouseId, s.productId, reserved, { type: 'SHIPMENT', id: s.id }, user.name, m);
        reserved = 0;
      }

      const changes: Partial<Shipment> = {
        customerName: dto.customerName !== undefined ? dto.customerName : s.customerName,
        originWarehouseId: origin,
        destinationWarehouseId: destination,
        productId,
        cargoDescription: dto.cargoDescription ?? s.cargoDescription,
        plannedQuantity: qty,
        priority: dto.priority ?? s.priority,
        plannedPickupAt: new Date(pickup),
        plannedDeliveryAt: new Date(delivery),
        routeId,
        quotaAllocationId: dto.quotaAllocationId !== undefined ? dto.quotaAllocationId : s.quotaAllocationId,
        qrLot: dto.qrLot !== undefined ? dto.qrLot : s.qrLot,
        waybillNumber: dto.waybillNumber !== undefined ? await this.assertWaybillFree(m, dto.waybillNumber, s.id) : s.waybillNumber,
        reservedQuantity: reserved
      };
      await m.getRepository(Shipment).update({ id: s.id }, changes);
      const diff: Record<string, { old: unknown; new: unknown }> = {};
      for (const [k, v] of Object.entries(changes)) {
        const old = (before as any)[k];
        const a = old instanceof Date ? old.toISOString() : old;
        const b = v instanceof Date ? v.toISOString() : v;
        if (a !== b) diff[k] = { old: a, new: b };
      }
      await this.audit.record(user, 'SHIPMENT_UPDATED', s.id, { old: { status: s.status }, new: { status: s.status }, changes: diff }, ctx, m);
      return s;
    });
    const fresh = await this.getRow(result.id);
    return this.shipmentToFrontend(fresh);
  }

  /** Apply a validated status change inside a transaction and audit it. */
  async setStatus(m: EntityManager, user: any, s: Shipment, to: string, action: string, ctx: RequestContext, extra: Partial<Shipment> = {}, details: Record<string, unknown> = {}) {
    assertTransition('shipment', SHIPMENT_TRANSITIONS, s.status, to);
    const from = s.status;
    await m.getRepository(Shipment).update({ id: s.id }, { ...extra, status: to });
    Object.assign(s, extra, { status: to });
    await this.audit.record(user, action, s.id, { old: { status: from }, new: { status: to }, shipmentNumber: s.shipmentNumber, ...details }, ctx, m);
    return { shipment: s, previousStatus: from } as ShipmentChange;
  }

  async plan(user: AuthUser, id: string, dto: PlanShipmentDto, ctx: RequestContext) {
    const change = await this.ds.transaction(async m => {
      const s = await this.getRow(id, m, true);
      const routeId = dto.routeId ?? s.routeId;
      if (routeId) await this.validateRoute(routeId, s.originWarehouseId, s.destinationWarehouseId, m);
      return this.setStatus(m, user, s, 'PLANNED', 'SHIPMENT_PLANNED', ctx, { routeId: routeId ?? null }, { routeId: routeId ?? null });
    });
    this.publishShipments([change]);
    return this.shipmentToFrontend(change.shipment);
  }

  async hold(user: AuthUser, id: string, dto: ReasonDto, ctx: RequestContext) {
    const change = await this.ds.transaction(async m => {
      const s = await this.getRow(id, m, true);
      return this.setStatus(m, user, s, 'ON_HOLD', 'SHIPMENT_ON_HOLD', ctx, { statusBeforeHold: s.status, holdReason: dto.reason }, { reason: dto.reason });
    });
    this.publishShipments([change]);
    return this.shipmentToFrontend(change.shipment);
  }

  async releaseHold(user: AuthUser, id: string, ctx: RequestContext) {
    const change = await this.ds.transaction(async m => {
      const s = await this.getRow(id, m, true);
      if (s.status !== 'ON_HOLD') throw Errors.conflict(`Shipment ${s.shipmentNumber} is not ON_HOLD (is ${s.status})`);
      const to = s.statusBeforeHold || 'DRAFT';
      return this.setStatus(m, user, s, to, 'SHIPMENT_HOLD_RELEASED', ctx, { statusBeforeHold: null, holdReason: null }, { previousHoldReason: s.holdReason });
    });
    this.publishShipments([change]);
    return this.shipmentToFrontend(change.shipment);
  }

  async cancel(user: AuthUser, id: string, dto: ReasonDto, ctx: RequestContext) {
    const tripChanges: Array<{ trip: Trip; previousStatus: string }> = [];
    const change = await this.ds.transaction(async m => {
      const s = await this.getRow(id, m, true);
      const effective = s.status === 'ON_HOLD' ? s.statusBeforeHold || 'DRAFT' : s.status;
      if (!PRE_TRANSIT_SHIPMENT_STATES.includes(effective)) {
        throw Errors.conflict(`Shipment ${s.shipmentNumber} can only be cancelled before it is IN_TRANSIT (is ${s.status})`);
      }
      // detach from trips that have not been dispatched yet
      const links = await m.getRepository(TripShipment).find({ where: { shipmentId: s.id } });
      for (const l of links) {
        const trip = await m.getRepository(Trip).createQueryBuilder('t').setLock('pessimistic_write').where('t.id = :id', { id: l.tripId }).getOne();
        if (!trip || !PRE_DISPATCH_TRIP_STATES.includes(trip.status)) continue;
        await m.getRepository(TripShipment).delete({ tripId: l.tripId, shipmentId: s.id });
        await m.getRepository(TripEvent).insert({
          tripId: trip.id, type: 'NOTE', severity: null, description: `Shipment ${s.shipmentNumber} cancelled and detached: ${dto.reason}`,
          latitude: null, longitude: null, data: { shipmentId: s.id, reason: dto.reason }, recordedBy: user.name, occurredAt: new Date()
        });
        const remaining = await m.getRepository(TripShipment).count({ where: { tripId: trip.id } });
        if (remaining === 0) {
          const prev = trip.status;
          await m.getRepository(Trip).update({ id: trip.id }, { status: 'ABORTED', abortReason: `All shipments cancelled: ${dto.reason}` });
          trip.status = 'ABORTED';
          await this.releaseTripResources(m, trip, 'RELEASED');
          await m.getRepository(TripEvent).insert({
            tripId: trip.id, type: 'STATUS_CHANGE', severity: null, description: `${prev} → ABORTED (all shipments cancelled)`,
            latitude: null, longitude: null, data: { from: prev, to: 'ABORTED' }, recordedBy: user.name, occurredAt: new Date()
          });
          await this.audit.record(user, 'TRIP_ABORTED', trip.id, { old: { status: prev }, new: { status: 'ABORTED' }, reason: 'All shipments cancelled' }, ctx, m);
          tripChanges.push({ trip, previousStatus: prev });
        }
      }
      if (s.reservedQuantity > 0 && s.productId) {
        await this.inventory.release(s.originWarehouseId, s.productId, s.reservedQuantity, { type: 'SHIPMENT', id: s.id }, user.name, m);
      }
      return this.setStatus(m, user, s, 'CANCELLED', 'SHIPMENT_CANCELLED', ctx,
        { cancelReason: dto.reason, reservedQuantity: 0, statusBeforeHold: null }, { reason: dto.reason, releasedQuantity: s.reservedQuantity });
    });
    this.publishShipments([change]);
    for (const t of tripChanges) {
      this.realtime.publish('trip.status.updated', { tripId: t.trip.id, truckId: t.trip.truckId, driverId: t.trip.primaryDriverId, shipmentIds: [change.shipment.id] },
        { tripId: t.trip.id, tripNumber: t.trip.tripNumber, status: t.trip.status, previousStatus: t.previousStatus, at: new Date().toISOString() });
      this.realtime.publish('driver.assignment.updated', { tripId: t.trip.id, driverId: t.trip.primaryDriverId, truckId: t.trip.truckId },
        { tripId: t.trip.id, driverId: t.trip.primaryDriverId, status: 'RELEASED' });
    }
    return this.shipmentToFrontend(change.shipment);
  }

  // ------------------------------------------------------------------ shared trip helpers

  /**
   * Release the trip's ACTIVE driver assignment(s) and free truck / driver when they have no other active trip / assignment.
   * Must run inside the transaction (manager) after the trip status was set to a terminal state.
   */
  async releaseTripResources(m: EntityManager, trip: Trip, assignmentStatus: 'RELEASED' | 'REASSIGNED' = 'RELEASED') {
    const now = new Date();
    const active = await m.getRepository(DriverTripAssignment).find({ where: { tripId: trip.id, status: 'ACTIVE' } });
    for (const a of active) {
      await m.getRepository(DriverTripAssignment).update({ id: a.id }, { status: assignmentStatus, releasedAt: now });
    }
    const driverIds = [...new Set([trip.primaryDriverId, ...active.map(a => a.driverId)])];
    for (const d of driverIds) await this.freeDriverIfIdle(m, d);
    await this.freeTruckIfIdle(m, trip.truckId, trip.id);
  }

  async freeDriverIfIdle(m: EntityManager, driverId: string) {
    const others = await m.getRepository(DriverTripAssignment).count({ where: { driverId, status: 'ACTIVE' } });
    if (others === 0) await this.drivers.setAvailability(driverId, 'AVAILABLE', m);
  }

  async freeTruckIfIdle(m: EntityManager, truckId: string, exceptTripId: string) {
    const others = await m.getRepository(Trip).createQueryBuilder('t')
      .where('t.truckId = :truckId AND t.id <> :tripId AND t.status IN (:...states)', { truckId, tripId: exceptTripId, states: ACTIVE_TRIP_STATES })
      .getCount();
    if (others === 0) await this.fleet.setAvailability(truckId, 'AVAILABLE', m);
  }

  // ------------------------------------------------------------------ realtime

  /** Publish shipment.status.updated for each change (after commit). */
  publishShipments(changes: ShipmentChange[], extra: { tripId?: string | null; truckId?: string | null; driverId?: string | null } = {}) {
    for (const c of changes) {
      const s = c.shipment;
      this.realtime.publish('shipment.status.updated', {
        shipmentIds: [s.id], warehouseIds: [s.originWarehouseId, s.destinationWarehouseId], tripId: extra.tripId ?? null,
        truckId: extra.truckId ?? null, driverId: extra.driverId ?? null
      }, {
        shipmentId: s.id, shipmentNumber: s.shipmentNumber, status: s.status, previousStatus: c.previousStatus, isDelayed: s.isDelayed,
        deliveredQuantity: s.deliveredQuantity, loadedQuantity: s.loadedQuantity, at: new Date().toISOString()
      });
    }
  }
}

export function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/** API shape of a delivery confirmation (proof is referenced through the authorised download endpoint only). */
export function deliveryToFrontend(d: Delivery) {
  return {
    id: d.id,
    shipmentId: d.shipmentId,
    tripId: d.tripId,
    deliveredAt: iso(d.deliveredAt),
    receiverName: d.receiverName,
    receiverPhone: d.receiverPhone,
    receivedQuantity: d.receivedQuantity,
    quantityUnit: d.quantityUnit,
    discrepancyQuantity: d.discrepancyQuantity,
    condition: d.condition,
    notes: d.notes,
    status: d.status,
    hasProof: !!d.proofOfDeliveryStorageKey,
    proofMimeType: d.proofMimeType,
    proofSha256: d.proofSha256,
    proofUrl: d.proofOfDeliveryStorageKey ? `/api/v1/deliveries/${d.id}/proof` : null,
    confirmedBy: d.confirmedBy,
    createdAt: iso(d.createdAt),
    withinTolerance: Math.abs(Number(d.discrepancyQuantity) || 0) <= QTY_EPS
  };
}
