import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { RULES } from '../../../common/constants/rules';
import { MOVING_TRIP_STATES } from '../../../common/utils/state-machine';
import { round } from '../../../common/utils/helpers';
import { SettingsService } from '../../settings/settings.service';
import { Driver } from '../drivers/entities/driver.entities';
import { GpsDevice, Truck } from '../fleet/entities/fleet.entities';
import { LogisticsThresholds, logisticsThresholds } from '../logistics.constants';
import { Shipment, Trip, TripShipment } from '../shipments/entities/shipment.entities';
import { InventoryBalance, Product, Warehouse } from '../warehouses/entities/warehouse.entities';

export type Connectivity = 'ONLINE' | 'STALE' | 'OFFLINE' | 'NEVER_SEEN';
export type FleetStatus = 'NORMAL_MOVING' | 'UNLOADING' | 'STOPPED' | 'STOPPED_ALERT' | 'IDLE';

const TERMINAL_TRIP = ['COMPLETED', 'ABORTED'];
const MOVING_SPEED_KMH = 3;

/** "16h 20m" */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, '0')}m`;
}

export function connectivityOf(lastSeenAt: Date | null | undefined, t: LogisticsThresholds, now = Date.now()): Connectivity {
  if (!lastSeenAt) return 'NEVER_SEEN';
  const ageMin = (now - new Date(lastSeenAt).getTime()) / 60000;
  if (ageMin <= t.gpsStaleMinutes) return 'ONLINE';
  if (ageMin <= t.gpsOfflineMinutes) return 'STALE';
  return 'OFFLINE';
}

/**
 * Read models that feed the EFMIS frontend (EFMIS_DATA.logistics.gpsFleet / warehouseUtilization) from the logistics
 * tables. Shapes are the frontend contract (LOGISTICS.md); extra fields are additive.
 */
@Injectable()
export class LogisticsViewService {
  constructor(
    @InjectRepository(Truck) private readonly trucks: Repository<Truck>,
    @InjectRepository(GpsDevice) private readonly devices: Repository<GpsDevice>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(TripShipment) private readonly tripShipments: Repository<TripShipment>,
    @InjectRepository(Shipment) private readonly shipments: Repository<Shipment>,
    @InjectRepository(Driver) private readonly drivers: Repository<Driver>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Warehouse) private readonly warehouses: Repository<Warehouse>,
    @InjectRepository(InventoryBalance) private readonly balances: Repository<InventoryBalance>,
    private readonly settings: SettingsService
  ) {}

  thresholds(): Promise<LogisticsThresholds> {
    return logisticsThresholds(this.settings);
  }

  /**
   * gpsFleet items (EXACT frontend shape) ordered by fleetCode:
   * { truckId, driver, vehicleNo, cargo, lat, lng, speedKmH, route, eta, status, qrLot, alertReason? } + extras.
   * `filter.truckIds` (UUIDs) restricts the list (used by the partner GPS feed response).
   */
  async gpsFleet(filter: { truckIds?: string[] } = {}): Promise<any[]> {
    const where = filter.truckIds ? { id: In(filter.truckIds.length ? filter.truckIds : ['00000000-0000-0000-0000-000000000000']) } : {};
    const trucks = await this.trucks.find({ where, order: { fleetCode: 'ASC' } });
    if (!trucks.length) return [];
    const truckIds = trucks.map(t => t.id);
    const th = await this.thresholds();
    const now = Date.now();

    const [devices, trips] = await Promise.all([
      this.devices.find({ where: { truckId: In(truckIds) } }),
      this.trips.find({ where: { truckId: In(truckIds), status: Not(In(TERMINAL_TRIP)) } })
    ]);
    const deviceByTruck = new Map(devices.map(d => [d.truckId!, d] as const));
    const tripByTruck = new Map(trips.map(t => [t.truckId, t] as const));

    const tripIds = trips.map(t => t.id);
    const links = tripIds.length ? await this.tripShipments.find({ where: { tripId: In(tripIds) }, order: { stopSequence: 'ASC' } }) : [];
    const shipmentIds = [...new Set(links.map(l => l.shipmentId))];
    const shipments = shipmentIds.length ? await this.shipments.findBy({ id: In(shipmentIds) }) : [];
    const shipmentById = new Map(shipments.map(s => [s.id, s] as const));
    const driverIds = [...new Set(trips.map(t => t.primaryDriverId))];
    const drivers = driverIds.length ? await this.drivers.findBy({ id: In(driverIds) }) : [];
    const driverById = new Map(drivers.map(d => [d.id, d] as const));
    const productIds = [...new Set(shipments.map(s => s.productId).filter((x): x is string => !!x))];
    const products = productIds.length ? await this.products.findBy({ id: In(productIds) }) : [];
    const productById = new Map(products.map(p => [p.id, p] as const));
    const whIds = [...new Set(shipments.flatMap(s => [s.originWarehouseId, s.destinationWarehouseId]))];
    const whs = whIds.length ? await this.warehouses.findBy({ id: In(whIds) }) : [];
    const whById = new Map(whs.map(w => [w.id, w] as const));

    return trucks.map(t => {
      const trip = tripByTruck.get(t.id) || null;
      const device = deviceByTruck.get(t.id) || null;
      const tripShipments = trip
        ? links.filter(l => l.tripId === trip.id).map(l => ({ link: l, s: shipmentById.get(l.shipmentId) })).filter(x => !!x.s) as Array<{ link: TripShipment; s: Shipment }>
        : [];
      const first = tripShipments[0]?.s;
      const last = tripShipments[tripShipments.length - 1]?.s;
      const driver = trip ? driverById.get(trip.primaryDriverId) : undefined;

      // cargo: "40 MT NPSB"
      let cargo = '-';
      if (tripShipments.length) {
        const qty = round(tripShipments.reduce((sum, x) => sum + (x.link.loadedQuantity ?? x.s.loadedQuantity ?? x.s.plannedQuantity), 0), 1);
        const skus = [...new Set(tripShipments.map(x => (x.s.productId && productById.get(x.s.productId)?.sku) || null).filter(Boolean))];
        cargo = skus.length ? `${qty} MT ${skus.join(' / ')}` : `${qty} MT ${first!.cargoDescription}`;
      }
      const route = first && last
        ? `${whById.get(first.originWarehouseId)?.name ?? 'Origin'} -> ${whById.get(last.destinationWarehouseId)?.name ?? 'Destination'}`
        : '-';

      const speed = t.lastSpeedKmh ?? 0;
      const moving = speed > MOVING_SPEED_KMH;
      let status: FleetStatus;
      let alertReason: string | undefined;
      if (!trip) status = 'IDLE';
      else if (trip.status === 'ARRIVED' || trip.status === 'UNLOADING') status = 'UNLOADING';
      else if (moving) status = 'NORMAL_MOVING';
      else {
        const stationaryMin = t.stationarySince ? (now - new Date(t.stationarySince).getTime()) / 60000 : 0;
        if (MOVING_TRIP_STATES.includes(trip.status) && stationaryMin > th.stationaryAlertMinutes) {
          status = 'STOPPED_ALERT';
          const hrs = round(th.stationaryAlertMinutes / 60, 1);
          const where = t.lastLat !== null && t.lastLng !== null ? ` at ${t.lastLat.toFixed(3)}, ${t.lastLng.toFixed(3)}` : '';
          alertReason = `Stationary for > ${hrs} hrs${where} (${round(stationaryMin / 60, 1)} hrs on trip ${trip.tripNumber})`;
        } else status = 'STOPPED';
      }

      let eta = '-';
      if (trip) {
        if (trip.status === 'ARRIVED' || trip.status === 'UNLOADING') eta = 'ARRIVED';
        else if (tripShipments.some(x => x.s.isDelayed)) eta = 'DELAYED';
        else {
          const etaAt = trip.estimatedArrivalAt ?? last?.estimatedArrivalAt ?? null;
          if (etaAt) eta = formatDuration(new Date(etaAt).getTime() - now);
        }
      }

      const lastSeen = device?.lastSeenAt ?? null;
      return {
        truckId: t.fleetCode,
        driver: driver ? `${driver.firstName} ${driver.lastName}` : '-',
        vehicleNo: t.plateNumber,
        cargo,
        lat: t.lastLat,
        lng: t.lastLng,
        speedKmH: round(speed, 0),
        route,
        eta,
        status,
        qrLot: first?.qrLot ?? tripShipments.find(x => x.s.qrLot)?.s.qrLot ?? null,
        ...(alertReason ? { alertReason } : {}),
        // extras
        id: t.id,
        tripId: trip?.id ?? null,
        tripNumber: trip?.tripNumber ?? null,
        tripStatus: trip?.status ?? null,
        shipmentNumbers: tripShipments.map(x => x.s.shipmentNumber),
        operationalStatus: t.operationalStatus,
        availabilityStatus: t.availabilityStatus,
        connectivity: device ? connectivityOf(lastSeen, th, now) : connectivityOf(t.lastPositionAt, th, now),
        heading: t.lastHeading,
        lastUpdate: t.lastPositionAt ? new Date(t.lastPositionAt).toISOString() : null,
        estimatedArrivalAt: trip?.estimatedArrivalAt ? new Date(trip.estimatedArrivalAt).toISOString() : null
      };
    });
  }

  /**
   * warehouseUtilization items (EXACT frontend shape) ordered by sort:
   * { name, capacityMT, currentStockMT (= Σ onHand), utilPercent, status: 'CAPACITY_ALERT_80' | 'OPTIMAL' } + extras.
   */
  async warehouseUtilization(filter: { warehouseIds?: string[] } = {}): Promise<any[]> {
    const where = filter.warehouseIds ? { id: In(filter.warehouseIds.length ? filter.warehouseIds : ['00000000-0000-0000-0000-000000000000']) } : {};
    const whs = await this.warehouses.find({ where, order: { sort: 'ASC', name: 'ASC' } });
    if (!whs.length) return [];
    const rows = await this.balances.createQueryBuilder('b')
      .select('b.warehouseId', 'warehouseId')
      .addSelect('COALESCE(SUM(b.onHandQuantity), 0)', 'onHand')
      .addSelect('COALESCE(SUM(b.reservedQuantity), 0)', 'reserved')
      .addSelect('MAX(b.updatedAt)', 'updatedAt')
      .where('b.warehouseId IN (:...ids)', { ids: whs.map(w => w.id) })
      .groupBy('b.warehouseId')
      .getRawMany<{ warehouseId: string; onHand: string; reserved: string; updatedAt: Date | string | null }>();
    const sums = new Map(rows.map(r => [r.warehouseId, r] as const));
    return whs.map(w => {
      const s = sums.get(w.id);
      const onHand = round(Number(s?.onHand) || 0, 1);
      const reserved = round(Number(s?.reserved) || 0, 1);
      const util = w.capacityMt > 0 ? round((onHand / w.capacityMt) * 100, 1) : 0;
      const balUpdated = s?.updatedAt ? new Date(s.updatedAt) : null;
      const last = balUpdated && balUpdated > w.updatedAt ? balUpdated : w.updatedAt;
      return {
        name: w.name,
        capacityMT: w.capacityMt,
        currentStockMT: onHand,
        utilPercent: util,
        status: util >= RULES.warehouseCapacityAlertPct ? 'CAPACITY_ALERT_80' : 'OPTIMAL',
        // extras
        id: w.id,
        code: w.code,
        kind: w.kind,
        warehouseStatus: w.status,
        reservedMT: reserved,
        availableMT: round(onHand - reserved, 1),
        lastUpdate: last ? new Date(last).toISOString() : null
      };
    });
  }
}
