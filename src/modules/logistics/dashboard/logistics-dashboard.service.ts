import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { Errors } from '../../../common/utils/errors';
import { round } from '../../../common/utils/helpers';
import { ACTIVE_TRIP_STATES } from '../../../common/utils/state-machine';
import { Alert } from '../../alerts/entities/alert.entity';
import { Driver, DriverDocument } from '../drivers/entities/driver.entities';
import { GpsDevice, Truck, TruckLocation } from '../fleet/entities/fleet.entities';
import { Delivery, Shipment, Trip, TripShipment } from '../shipments/entities/shipment.entities';
import { InventoryTransaction, Product, Warehouse } from '../warehouses/entities/warehouse.entities';
import { connectivityOf, LogisticsViewService } from './logistics-view.service';

/** Alert categories counted as "logistics" on the control tower. */
export const LOGISTICS_ALERT_PREFIXES = ['Logistics', 'Fleet & GPS', 'Driver Compliance', 'Inventory', 'Theft/Diversion Risk'];
const OPEN_SHIPMENT_STATES = ['DRAFT', 'PLANNED', 'ASSIGNED', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'ARRIVED', 'ON_HOLD', 'DELIVERY_FAILED'];
const DISCREPANCY_TYPES = ['LOADING_DISCREPANCY', 'DAMAGE', 'ADJUSTMENT'];
const MAX_PERIOD_DAYS = 366;

// type alias (not interface) so it can be passed directly as query parameters
export type Period = {
  from: Date;
  to: Date;
};

export type Granularity = 'day' | 'week' | 'month';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const pct = (num: number, den: number) => (den > 0 ? round((num / den) * 100, 1) : null);
const countBy = (rows: Array<{ k: string; c: string }>) => Object.fromEntries(rows.map(r => [r.k, Number(r.c)]));

/** Bucket key of a date (UTC). */
function bucketOf(d: Date, g: Granularity): string {
  const x = new Date(d);
  if (g === 'month') return x.toISOString().slice(0, 7);
  if (g === 'week') {
    const day = (x.getUTCDay() + 6) % 7; // Monday = 0
    x.setUTCDate(x.getUTCDate() - day);
  }
  return x.toISOString().slice(0, 10);
}

/** Operations Control Tower KPIs and logistics reports (Logistics doc §15 Dashboard summary, §17 Reports). */
@Injectable()
export class LogisticsDashboardService {
  constructor(
    @InjectRepository(Truck) private readonly trucks: Repository<Truck>,
    @InjectRepository(GpsDevice) private readonly devices: Repository<GpsDevice>,
    @InjectRepository(TruckLocation) private readonly locations: Repository<TruckLocation>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(TripShipment) private readonly tripShipments: Repository<TripShipment>,
    @InjectRepository(Shipment) private readonly shipments: Repository<Shipment>,
    @InjectRepository(Delivery) private readonly deliveries: Repository<Delivery>,
    @InjectRepository(Driver) private readonly drivers: Repository<Driver>,
    @InjectRepository(DriverDocument) private readonly driverDocuments: Repository<DriverDocument>,
    @InjectRepository(InventoryTransaction) private readonly ledger: Repository<InventoryTransaction>,
    @InjectRepository(Warehouse) private readonly warehouses: Repository<Warehouse>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Alert) private readonly alerts: Repository<Alert>,
    private readonly view: LogisticsViewService
  ) {}

  /** Parse ?from&to (ISO); default = last 30 days. */
  period(from?: string, to?: string): Period {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 30 * 864e5);
    if (Number.isNaN(end.getTime()) || Number.isNaN(start.getTime())) throw Errors.unprocessable('from/to must be ISO 8601 dates');
    if (start >= end) throw Errors.unprocessable('from must be before to');
    if (end.getTime() - start.getTime() > MAX_PERIOD_DAYS * 864e5) throw Errors.unprocessable(`The report period is limited to ${MAX_PERIOD_DAYS} days`);
    return { from: start, to: end };
  }

  // ---------------- GET /dashboard/summary ----------------
  async summary() {
    const th = await this.view.thresholds();
    const now = new Date();

    const truckOps = countBy(await this.trucks.createQueryBuilder('t').select('t.operationalStatus', 'k').addSelect('COUNT(*)', 'c').groupBy('t.operationalStatus').getRawMany());
    const truckAvail = countBy(await this.trucks.createQueryBuilder('t').select('t.availabilityStatus', 'k').addSelect('COUNT(*)', 'c').groupBy('t.availabilityStatus').getRawMany());
    const trucksTotal = Object.values(truckOps).reduce((s, n) => s + n, 0);

    const devices = await this.devices.find({ where: { deviceStatus: In(['REGISTERED', 'ACTIVE']) }, select: { id: true, lastSeenAt: true, truckId: true } });
    const byConnectivity: Record<string, number> = { ONLINE: 0, STALE: 0, OFFLINE: 0, NEVER_SEEN: 0 };
    for (const d of devices) byConnectivity[connectivityOf(d.lastSeenAt, th, now.getTime())]++;

    const tripsByStatus = countBy(await this.trips.createQueryBuilder('t').select('t.status', 'k').addSelect('COUNT(*)', 'c')
      .where('t.status IN (:...s)', { s: ACTIVE_TRIP_STATES }).groupBy('t.status').getRawMany());
    const shipmentsByStatus = countBy(await this.shipments.createQueryBuilder('s').select('s.status', 'k').addSelect('COUNT(*)', 'c').groupBy('s.status').getRawMany());
    const delayed = await this.shipments.createQueryBuilder('s').where('s.isDelayed = true').andWhere('s.status IN (:...s)', { s: OPEN_SHIPMENT_STATES }).getCount();
    const inTransit = await this.shipments.createQueryBuilder('s').select('COALESCE(SUM(COALESCE(s.loadedQuantity, s.plannedQuantity)), 0)', 'mt')
      .where(`s.status = 'IN_TRANSIT'`).getRawOne<{ mt: string }>();

    const onTime = await this.onTimeDelivery({ from: new Date(now.getTime() - 30 * 864e5), to: now }, th.delayToleranceMinutes);

    const warnDate = new Date(now.getTime() + th.documentExpiryWarningDays * 864e5).toISOString().slice(0, 10);
    const driversAvailable = await this.drivers.countBy({ availabilityStatus: 'AVAILABLE', employmentStatus: 'ACTIVE' });
    const driversOnTrip = await this.drivers.countBy({ availabilityStatus: 'ON_TRIP' });
    const licencesExpiring = await this.drivers.createQueryBuilder('d').where(`d.employmentStatus <> 'INACTIVE'`).andWhere('d.licenceExpiryDate <= :w', { w: warnDate }).getCount();
    const docDrivers = await this.driverDocuments.createQueryBuilder('doc').select('COUNT(DISTINCT doc.driverId)', 'c')
      .where('doc.expiresAt IS NOT NULL').andWhere('doc.expiresAt <= :w', { w: warnDate }).andWhere(`doc.verificationStatus <> 'REJECTED'`).getRawOne<{ c: string }>();
    const expiringDriverIds = await this.drivers.createQueryBuilder('d').select('d.id', 'id')
      .where(`d.employmentStatus <> 'INACTIVE'`)
      .andWhere(new Brackets(b => b.where('d.licenceExpiryDate <= :w', { w: warnDate })
        .orWhere(`EXISTS (SELECT 1 FROM driver_documents doc WHERE doc.driver_id = d.id AND doc.expires_at IS NOT NULL AND doc.expires_at <= :w AND doc.verification_status <> 'REJECTED')`, { w: warnDate })))
      .getRawMany();

    const alertsQb = this.alerts.createQueryBuilder('a').where('a.resolved = false').andWhere(`a.status NOT IN ('RESOLVED', 'CLOSED')`)
      .andWhere(new Brackets(b => LOGISTICS_ALERT_PREFIXES.forEach((p, i) => b.orWhere(`a.category LIKE :p${i}`, { [`p${i}`]: `${p}%` }))));
    const openAlerts = await alertsQb.clone().orderBy('a.timestamp', 'DESC').take(500).getMany();
    const bySeverity: Record<string, number> = { CRITICAL_RED: 0, HIGH_ORANGE: 0, MEDIUM_YELLOW: 0, LOW_BLUE: 0 };
    const byCategory: Record<string, number> = {};
    for (const a of openAlerts) {
      bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
      byCategory[a.category] = (byCategory[a.category] || 0) + 1;
    }

    const warehouses = await this.view.warehouseUtilization();
    const totalCap = warehouses.reduce((s, w) => s + (w.capacityMT || 0), 0);
    const totalStock = warehouses.reduce((s, w) => s + (w.currentStockMT || 0), 0);

    return {
      generatedAt: now.toISOString(),
      trucks: { total: trucksTotal, byOperationalStatus: truckOps, byAvailability: truckAvail },
      devices: { total: devices.length, byConnectivity },
      trips: { active: Object.values(tripsByStatus).reduce((s, n) => s + n, 0), byStatus: tripsByStatus },
      shipments: { byStatus: shipmentsByStatus, delayed, inTransitMt: round(Number(inTransit?.mt) || 0, 1) },
      onTimeDelivery: { periodDays: 30, ...onTime },
      drivers: {
        available: driversAvailable, onTrip: driversOnTrip, documentsExpiring: expiringDriverIds.length,
        licencesExpiring, otherDocumentsExpiring: Number(docDrivers?.c) || 0, warningDays: th.documentExpiryWarningDays
      },
      alerts: { open: openAlerts.length, bySeverity, byCategory, latest: openAlerts.slice(0, 5).map(a => ({ id: a.id, severity: a.severity, title: a.title, category: a.category, timestamp: a.timestamp })) },
      warehouses: {
        totalCapacityMT: round(totalCap, 1), totalStockMT: round(totalStock, 1), utilPercent: pct(totalStock, totalCap) ?? 0,
        atCapacityAlert: warehouses.filter(w => w.status === 'CAPACITY_ALERT_80').length, items: warehouses
      }
    };
  }

  /** Delivered shipments in the period (last delivery confirmation) and how many met plannedDeliveryAt (+ tolerance). */
  private async onTimeDelivery(p: Period, toleranceMin: number) {
    const rows = await this.deliveries.createQueryBuilder('d')
      .innerJoin(Shipment, 's', 's.id = d.shipmentId')
      .select('d.shipmentId', 'shipmentId').addSelect('MAX(d.deliveredAt)', 'deliveredAt').addSelect('MAX(s.plannedDeliveryAt)', 'plannedAt')
      .where(`d.status <> 'REJECTED'`).andWhere(`s.status IN ('DELIVERED', 'CLOSED')`)
      .groupBy('d.shipmentId')
      .having('MAX(d.deliveredAt) >= :from AND MAX(d.deliveredAt) <= :to', { from: p.from, to: p.to })
      .getRawMany<{ shipmentId: string; deliveredAt: Date | string; plannedAt: Date | string }>();
    const tol = toleranceMin * 60000;
    const onTime = rows.filter(r => new Date(r.deliveredAt).getTime() <= new Date(r.plannedAt).getTime() + tol).length;
    return { delivered: rows.length, onTime, late: rows.length - onTime, ratePercent: pct(onTime, rows.length) };
  }

  // ---------------- GET /reports/trips ----------------
  /** Trip completion & delivery timeliness per period bucket (by planned start). */
  async tripsReport(p: Period, granularity: Granularity = 'day') {
    const th = await this.view.thresholds();
    const trips = await this.trips.createQueryBuilder('t').where('t.plannedStartAt >= :from AND t.plannedStartAt <= :to', p).orderBy('t.plannedStartAt', 'ASC').getMany();
    const links = trips.length ? await this.tripShipments.find({ where: { tripId: In(trips.map(t => t.id)) } }) : [];
    const shipments = links.length ? await this.shipments.findBy({ id: In([...new Set(links.map(l => l.shipmentId))]) }) : [];
    const sById = new Map(shipments.map(s => [s.id, s] as const));
    const deadlineOf = (tripId: string) => {
      const ds = links.filter(l => l.tripId === tripId).map(l => sById.get(l.shipmentId)?.plannedDeliveryAt).filter(Boolean) as Date[];
      return ds.length ? Math.max(...ds.map(d => new Date(d).getTime())) : null;
    };
    const tol = th.delayToleranceMinutes * 60000;

    type B = { period: string; planned: number; completed: number; aborted: number; inProgress: number; arrivedOnTime: number; arrivedLate: number; durations: number[] };
    const buckets = new Map<string, B>();
    const total: B = { period: 'TOTAL', planned: 0, completed: 0, aborted: 0, inProgress: 0, arrivedOnTime: 0, arrivedLate: 0, durations: [] };
    for (const t of trips) {
      const key = bucketOf(t.plannedStartAt, granularity);
      if (!buckets.has(key)) buckets.set(key, { period: key, planned: 0, completed: 0, aborted: 0, inProgress: 0, arrivedOnTime: 0, arrivedLate: 0, durations: [] });
      for (const b of [buckets.get(key)!, total]) {
        b.planned++;
        if (t.status === 'COMPLETED') b.completed++;
        else if (t.status === 'ABORTED') b.aborted++;
        else b.inProgress++;
        if (t.actualArrivalAt) {
          const deadline = deadlineOf(t.id) ?? (t.estimatedArrivalAt ? new Date(t.estimatedArrivalAt).getTime() : null);
          if (deadline !== null) {
            if (new Date(t.actualArrivalAt).getTime() <= deadline + tol) b.arrivedOnTime++;
            else b.arrivedLate++;
          }
          if (t.actualStartAt) b.durations.push((new Date(t.actualArrivalAt).getTime() - new Date(t.actualStartAt).getTime()) / 36e5);
        }
      }
    }
    const out = (b: B) => ({
      period: b.period, planned: b.planned, completed: b.completed, aborted: b.aborted, inProgress: b.inProgress,
      completionRatePercent: pct(b.completed, b.completed + b.aborted), completedOfPlannedPercent: pct(b.completed, b.planned),
      arrivedOnTime: b.arrivedOnTime, arrivedLate: b.arrivedLate, onTimeRatePercent: pct(b.arrivedOnTime, b.arrivedOnTime + b.arrivedLate),
      avgTransitHours: b.durations.length ? round(b.durations.reduce((s, x) => s + x, 0) / b.durations.length, 1) : null
    });
    return {
      from: iso(p.from), to: iso(p.to), granularity, toleranceMinutes: th.delayToleranceMinutes,
      totals: out(total), periods: [...buckets.values()].map(out)
    };
  }

  // ---------------- GET /reports/utilization ----------------
  /** Truck utilisation % = time on trip (dispatch → arrival/completion, clipped to the period) / period length. */
  async utilizationReport(p: Period) {
    const trucks = await this.trucks.find({ order: { fleetCode: 'ASC' } });
    const trips = await this.trips.createQueryBuilder('t')
      .where('t.actualStartAt IS NOT NULL').andWhere('t.actualStartAt <= :to', p)
      .andWhere(`(t.completedAt IS NULL OR t.completedAt >= :from)`, p)
      .getMany();
    const periodMs = p.to.getTime() - p.from.getTime();
    const now = Date.now();
    const byTruck = new Map<string, { ms: number; trips: number }>();
    for (const t of trips) {
      const start = Math.max(new Date(t.actualStartAt!).getTime(), p.from.getTime());
      const endRaw = t.completedAt ?? (t.status === 'ABORTED' ? t.updatedAt : null) ?? (t.status === 'COMPLETED' ? t.actualArrivalAt : null);
      const end = Math.min(endRaw ? new Date(endRaw).getTime() : now, p.to.getTime());
      if (end <= start) continue;
      const cur = byTruck.get(t.truckId) || { ms: 0, trips: 0 };
      cur.ms += end - start;
      cur.trips++;
      byTruck.set(t.truckId, cur);
    }
    const items = trucks.map(t => {
      const u = byTruck.get(t.id) || { ms: 0, trips: 0 };
      const ms = Math.min(u.ms, periodMs);
      return {
        truckId: t.id, fleetCode: t.fleetCode, plateNumber: t.plateNumber, operationalStatus: t.operationalStatus,
        trips: u.trips, hoursOnTrip: round(ms / 36e5, 1), utilizationPercent: round((ms / periodMs) * 100, 1)
      };
    });
    const active = items.filter(i => i.operationalStatus !== 'OUT_OF_SERVICE');
    return {
      from: iso(p.from), to: iso(p.to), periodHours: round(periodMs / 36e5, 1),
      fleetUtilizationPercent: active.length ? round(active.reduce((s, i) => s + i.utilizationPercent, 0) / active.length, 1) : null,
      items
    };
  }

  // ---------------- GET /reports/gps-uptime ----------------
  /** Per device: % of hours in the period with at least one position. */
  async gpsUptimeReport(p: Period) {
    const devices = await this.devices.find({ where: { deviceStatus: In(['REGISTERED', 'ACTIVE']) } });
    const hours = Math.max(1, Math.ceil((p.to.getTime() - p.from.getTime()) / 36e5));
    const rows = devices.length
      ? await this.locations.createQueryBuilder('l')
        .select('l.deviceId', 'deviceId').addSelect(`COUNT(DISTINCT date_trunc('hour', l.recordedAt))`, 'hours').addSelect('COUNT(*)', 'positions')
        .where('l.deviceId IN (:...ids)', { ids: devices.map(d => d.id) })
        .andWhere('l.recordedAt >= :from AND l.recordedAt < :to', p)
        .groupBy('l.deviceId').getRawMany<{ deviceId: string; hours: string; positions: string }>()
      : [];
    const byDevice = new Map(rows.map(r => [r.deviceId, r] as const));
    const truckIds = devices.map(d => d.truckId).filter((x): x is string => !!x);
    const trucks = truckIds.length ? await this.trucks.findBy({ id: In(truckIds) }) : [];
    const tById = new Map(trucks.map(t => [t.id, t] as const));
    const items = devices.map(d => {
      const r = byDevice.get(d.id);
      const h = Number(r?.hours) || 0;
      return {
        deviceId: d.id, provider: d.provider, providerDeviceId: d.providerDeviceId, model: d.model,
        truckId: d.truckId, fleetCode: d.truckId ? tById.get(d.truckId)?.fleetCode ?? null : null,
        hoursWithPositions: h, periodHours: hours, uptimePercent: round((h / hours) * 100, 1), positions: Number(r?.positions) || 0,
        lastSeenAt: iso(d.lastSeenAt)
      };
    }).sort((a, b) => String(a.fleetCode ?? '~').localeCompare(String(b.fleetCode ?? '~')));
    return {
      from: iso(p.from), to: iso(p.to), periodHours: hours,
      averageUptimePercent: items.length ? round(items.reduce((s, i) => s + i.uptimePercent, 0) / items.length, 1) : null,
      items
    };
  }

  // ---------------- GET /reports/stock-discrepancies ----------------
  async stockDiscrepancyReport(p: Period, warehouseId?: string) {
    const qb = this.ledger.createQueryBuilder('t').where('t.type IN (:...types)', { types: DISCREPANCY_TYPES })
      .andWhere('t.createdAt >= :from AND t.createdAt <= :to', p);
    if (warehouseId) qb.andWhere('t.warehouseId = :warehouseId', { warehouseId });
    const ledger = await qb.orderBy('t.createdAt', 'DESC').take(5000).getMany();

    const dq = this.deliveries.createQueryBuilder('d').where('d.discrepancyQuantity <> 0').andWhere('d.deliveredAt >= :from AND d.deliveredAt <= :to', p);
    if (warehouseId) dq.andWhere('EXISTS (SELECT 1 FROM shipments s WHERE s.id = d.shipment_id AND s.destination_warehouse_id = :warehouseId)', { warehouseId });
    const deliveries = await dq.orderBy('d.deliveredAt', 'DESC').take(5000).getMany();
    const shipments = deliveries.length ? await this.shipments.findBy({ id: In([...new Set(deliveries.map(d => d.shipmentId))]) }) : [];
    const sById = new Map(shipments.map(s => [s.id, s] as const));

    const whIds = [...new Set([...ledger.map(l => l.warehouseId), ...shipments.map(s => s.destinationWarehouseId)])];
    const pIds = [...new Set([...ledger.map(l => l.productId), ...shipments.map(s => s.productId).filter((x): x is string => !!x)])];
    const whById = new Map((whIds.length ? await this.warehouses.findBy({ id: In(whIds) }) : []).map(w => [w.id, w] as const));
    const pById = new Map((pIds.length ? await this.products.findBy({ id: In(pIds) }) : []).map(x => [x.id, x] as const));

    const byType: Record<string, { count: number; quantityMt: number; netOnHandDeltaMt: number }> = {};
    for (const t of DISCREPANCY_TYPES) byType[t] = { count: 0, quantityMt: 0, netOnHandDeltaMt: 0 };
    for (const l of ledger) {
      byType[l.type].count++;
      byType[l.type].quantityMt = round(byType[l.type].quantityMt + l.quantity, 3);
      byType[l.type].netOnHandDeltaMt = round(byType[l.type].netOnHandDeltaMt + l.onHandDelta, 3);
    }
    const shortage = deliveries.filter(d => d.discrepancyQuantity < 0).reduce((s, d) => s + d.discrepancyQuantity, 0);
    const excess = deliveries.filter(d => d.discrepancyQuantity > 0).reduce((s, d) => s + d.discrepancyQuantity, 0);

    return {
      from: iso(p.from), to: iso(p.to), warehouseId: warehouseId ?? null,
      totals: {
        ledger: byType,
        deliveries: { count: deliveries.length, shortageMt: round(shortage, 3), excessMt: round(excess, 3), netMt: round(shortage + excess, 3) }
      },
      ledger: ledger.map(l => ({
        id: l.id, type: l.type, warehouseId: l.warehouseId, warehouseName: whById.get(l.warehouseId)?.name ?? null,
        productId: l.productId, productSku: pById.get(l.productId)?.sku ?? null, quantity: l.quantity, onHandDelta: l.onHandDelta,
        referenceType: l.referenceType, referenceId: l.referenceId, notes: l.notes, createdBy: l.createdBy, createdAt: iso(l.createdAt)
      })),
      deliveries: deliveries.map(d => {
        const s = sById.get(d.shipmentId);
        return {
          deliveryId: d.id, shipmentId: d.shipmentId, shipmentNumber: s?.shipmentNumber ?? null, tripId: d.tripId,
          destinationWarehouse: s ? whById.get(s.destinationWarehouseId)?.name ?? null : null,
          productSku: s?.productId ? pById.get(s.productId)?.sku ?? null : null,
          receivedQuantity: d.receivedQuantity, discrepancyQuantity: d.discrepancyQuantity, condition: d.condition, status: d.status,
          notes: d.notes, deliveredAt: iso(d.deliveredAt)
        };
      })
    };
  }
}
