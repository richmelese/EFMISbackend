import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { EcxPrice, LogisticsBottleneck, QualityInspection, Tender, Vessel } from './entities/integration.entities';
import { PurchaseOrder } from '../quota/entities/quota.entities';
import { Farmer } from '../farmers/entities/farmer.entity';
import { Region } from '../hierarchy/entities/region.entity';
import { Truck } from '../logistics/fleet/entities/fleet.entities';
import { InventoryBalance, Product, Warehouse } from '../logistics/warehouses/entities/warehouse.entities';
import { RULES } from '../../common/constants/rules';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { nowStamp, round, stamp } from '../../common/utils/helpers';
import { AuditService } from '../audit/audit.service';
import { AlertsService } from '../alerts/alerts.service';
import { SettingsService } from '../settings/settings.service';
import { TrackingService } from '../logistics/tracking/tracking.service';
import { InventoryService } from '../logistics/warehouses/inventory.service';
import { LogisticsViewService } from '../logistics/dashboard/logistics-view.service';
import { RealtimeService } from '../logistics/realtime/realtime.service';
import { EcxPriceDto, QualityInspectionDto, TenderFeedDto, TruckPingDto, VesselFeedDto, WarehouseFeedDto } from './dto/integrations.dto';

const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * Integration framework (Section 3): read-only partner dashboards (REQ-INT-001..004) and the inbound feed endpoints
 * used by the source institutions (EABC, ECAE, ESLSE, GPS platforms, ECX). Feeds that cross a threshold raise alerts.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Tender) readonly tenders: Repository<Tender>,
    @InjectRepository(Vessel) readonly vessels: Repository<Vessel>,
    @InjectRepository(QualityInspection) readonly inspections: Repository<QualityInspection>,
    @InjectRepository(LogisticsBottleneck) readonly bottlenecks: Repository<LogisticsBottleneck>,
    @InjectRepository(EcxPrice) readonly ecxPrices: Repository<EcxPrice>,
    @InjectRepository(PurchaseOrder) private readonly purchaseOrders: Repository<PurchaseOrder>,
    @InjectRepository(Farmer) private readonly farmers: Repository<Farmer>,
    @InjectRepository(Region) private readonly regions: Repository<Region>,
    @InjectRepository(Truck) private readonly trucks: Repository<Truck>,
    @InjectRepository(Warehouse) private readonly warehouses: Repository<Warehouse>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly alerts: AlertsService,
    private readonly tracking: TrackingService,
    private readonly inventory: InventoryService,
    readonly logisticsView: LogisticsViewService,
    private readonly realtime: RealtimeService
  ) {}

  // ---------------- Mappers (frontend EFMIS_DATA shapes; withMeta adds updatedAt) ----------------
  tenderOut(t: Tender, withMeta = true) {
    return {
      tenderNo: t.tenderNo, description: t.description, stage: t.stage, deadline: t.deadline, budgetAllocatedETB: t.budgetAllocatedEtb,
      forexRequiredUSD: t.forexRequiredUsd, forexStatus: t.forexStatus, lcIssuingBank: t.lcIssuingBank, lcStatus: t.lcStatus,
      lowestBidder: t.lowestBidder, complianceStatus: t.complianceStatus, ...(withMeta ? { updatedAt: stamp(t.updatedAt) } : {})
    };
  }

  vesselOut(v: Vessel, withMeta = true) {
    return {
      name: v.name, imo: v.imo, cargo: v.cargo, origin: v.origin, laycan: v.laycan, etaDjibouti: v.etaDjibouti, berthingStatus: v.berthingStatus,
      unloadingRateTPD: v.unloadingRateTpd, demurrageRisk: v.demurrageRisk, destinationDepots: v.destinationDepots || [],
      ...(withMeta ? { updatedAt: stamp(v.updatedAt) } : {})
    };
  }

  /** gpsFleet item from LogisticsViewService (+ updatedAt "YYYY-MM-DD HH:mm:ss" for the unversioned EFMIS API). */
  private fleetItemOut(item: any) {
    return { ...item, updatedAt: item.lastUpdate ? stamp(new Date(item.lastUpdate)) : null };
  }

  private warehouseItemOut(item: any) {
    return { ...item, updatedAt: item.lastUpdate ? stamp(new Date(item.lastUpdate)) : null };
  }

  async ecxOut() {
    return (await this.ecxPrices.find({ order: { sort: 'ASC' } })).map(p => ({ commodity: p.commodity, priceETBPerQtl: p.priceEtbPerQtl, trend: p.trend }));
  }

  async inspectionsData() {
    return (await this.inspections.find({ order: { inspectionDate: 'DESC' } })).map(r => r.data);
  }

  // ---------------- REQ-INT-001 Procurement ----------------
  async procurement() {
    const pos = await this.purchaseOrders.find({ order: { createdAt: 'DESC' } });
    const tenders = await this.tenders.find({ order: { deadline: 'ASC' } });
    const vessels = await this.vessels.find({ order: { etaDjibouti: 'ASC' } });
    const awarded = tenders.filter(t => t.stage === 'Contract Awarded').length;
    return {
      activeTenders: tenders.map(t => this.tenderOut(t)),
      vessels: vessels.map(v => this.vesselOut(v)),
      purchaseOrders: pos.map(p => ({ id: p.id, controlNo: p.controlNo, status: p.status, priority: p.priority, createdAt: stamp(p.createdAt) })),
      summary: {
        totalTenders: tenders.length,
        contractsAwarded: awarded,
        pendingTenders: tenders.filter(t => t.stage !== null && t.stage !== 'Contract Awarded').length,
        vesselsEnRoute: vessels.length
      },
      lastUpdated: nowStamp()
    };
  }

  async upsertTender(user: AuthUser, tenderNo: string, b: TenderFeedDto, ctx: RequestContext) {
    return this.ds.transaction(async m => {
      const repo = m.getRepository(Tender);
      const old = await repo.findOneBy({ tenderNo });
      const changes = defined({
        description: b.description, stage: b.stage, deadline: b.deadline, budgetAllocatedEtb: b.budgetAllocatedETB, forexRequiredUsd: b.forexRequiredUSD,
        forexStatus: b.forexStatus, lcIssuingBank: b.lcIssuingBank, lcStatus: b.lcStatus, lowestBidder: b.lowestBidder, complianceStatus: b.complianceStatus
      });
      await repo.save(repo.merge(old ?? repo.create({ tenderNo }), changes, { updatedAt: new Date() }));
      await this.audit.record(user, 'PROCUREMENT_FEED_UPDATE', tenderNo, { old: old ? this.tenderOut(old) : null, new: b }, ctx, m);
      if (b.deadline && b.stage !== 'Contract Awarded' && b.deadline < nowStamp().slice(0, 10)) {
        await this.alerts.raise({
          severity: 'HIGH_ORANGE', title: `Tender evaluation overdue: ${tenderNo}`, category: 'Procurement', trigger: `Deadline ${b.deadline} passed at stage ${b.stage}`,
          affectedArea: 'National procurement', actionRequired: 'EABC to expedite evaluation', sourceType: 'TENDER', sourceId: tenderNo, dedupeKey: `TENDER-OVERDUE-${tenderNo}`
        }, m);
      }
      return this.tenderOut((await repo.findOneBy({ tenderNo }))!);
    });
  }

  async upsertVessel(user: AuthUser, imo: string, b: VesselFeedDto, ctx: RequestContext) {
    return this.ds.transaction(async m => {
      const repo = m.getRepository(Vessel);
      const old = await repo.findOneBy({ imo });
      const changes = defined({
        name: b.name, cargo: b.cargo, origin: b.origin, laycan: b.laycan, etaDjibouti: b.etaDjibouti, berthingStatus: b.berthingStatus,
        unloadingRateTpd: b.unloadingRateTPD, demurrageRisk: b.demurrageRisk
      });
      await repo.save(repo.merge(old ?? repo.create({ imo }), changes, { destinationDepots: b.destinationDepots || [], updatedAt: new Date() }));
      await this.audit.record(user, 'VESSEL_FEED_UPDATE', imo, b, ctx, m);
      if (b.demurrageRisk && /HIGH/i.test(b.demurrageRisk)) {
        await this.alerts.raise({
          severity: 'HIGH_ORANGE', title: `Demurrage risk: ${b.name}`, category: 'Logistics Delays', trigger: b.demurrageRisk, affectedArea: 'Port of Djibouti',
          actionRequired: 'Coordinate berthing with ESLSE / Port Authority', sourceType: 'VESSEL', sourceId: imo, dedupeKey: `DEMURRAGE-${imo}-${b.demurrageRisk}`
        }, m);
      }
      return this.vesselOut((await repo.findOneBy({ imo }))!);
    });
  }

  // ---------------- REQ-INT-002 Quality ----------------
  async quality() {
    const inspections = await this.inspectionsData();
    const summary = await this.settings.get<any>('qualitySummary', {});
    const rejected = inspections.filter((i: any) => /REJECT/.test(i.verdict));
    return {
      overallPassRate: summary?.overallPassRate,
      testedBatchesCount: summary?.testedBatchesCount,
      inspections,
      nonConformanceIncidents: rejected.map((i: any) => ({ sampleId: i.sampleId, vessel: i.vessel, product: i.product, supplier: i.supplier, incidentReport: i.incidentReport, notice: i.cocNumber })),
      supplierBlacklist: rejected.map((i: any) => ({ supplier: i.supplier, reason: i.incidentReport || 'Non-conformance', date: i.inspectionDate })),
      pendingInspections: await this.inspections.countBy({ verdict: 'PENDING' })
    };
  }

  /** Returns null when no certificate matches (controller answers 404 { valid:false, message }). */
  async verifyCoc(code: string) {
    const row = (await this.inspections.find()).map(r => r.data).find((i: any) => i.cocNumber === code || i.qrVerificationCode === code);
    if (!row) return null;
    return { valid: row.verdict === 'PASSED_CONFORMITY', verdict: row.verdict, cocNumber: row.cocNumber, product: row.product, supplier: row.supplier, inspectionDate: row.inspectionDate, labLocation: row.labLocation };
  }

  /** ECAE lab result feed; a REJECTED_IMPOUNDED verdict raises a CRITICAL alert (PMO 4-hour SLA). `data` is the full payload incl. extra lab fields. */
  async recordInspection(user: AuthUser, data: QualityInspectionDto & Record<string, unknown>, ctx: RequestContext) {
    return this.ds.transaction(async m => {
      const repo = m.getRepository(QualityInspection);
      await repo.save(repo.create({ sampleId: data.sampleId, data, verdict: data.verdict, inspectionDate: data.inspectionDate, updatedAt: new Date() }));
      const all = await repo.find({ select: { sampleId: true, verdict: true } });
      const summary = await this.settings.get<any>('qualitySummary', {}, m) || {};
      await this.settings.set('qualitySummary', {
        ...summary,
        testedBatchesCount: (summary.testedBatchesCount || 0) + 1,
        overallPassRate: summary.overallPassRate ?? round((all.filter(a => a.verdict === 'PASSED_CONFORMITY').length / all.length) * 100, 1)
      }, user.name, m);
      await this.audit.record(user, data.verdict === 'PASSED_CONFORMITY' ? 'LAB_TEST_COC_ISSUED' : 'LAB_TEST_NON_CONFORMANCE', data.cocNumber || data.sampleId, { verdict: data.verdict }, ctx, m);
      let alert: any = null;
      if (data.verdict === 'REJECTED_IMPOUNDED') {
        alert = await this.alerts.raise({
          severity: 'CRITICAL_RED', title: 'Substandard Fertilizer Lot Detected & Barred', category: 'Quality Compliance',
          trigger: `ECAE test failed on ${data.sampleId} (${data.product}, ${data.vessel})`, affectedArea: data.labLocation || 'Port of Djibouti',
          actionRequired: 'Confirm supplier debarment and execute LC performance guarantee bond draw.', sourceType: 'QUALITY', sourceId: data.sampleId,
          dedupeKey: `QC-REJECT-${data.sampleId}`
        }, m);
      }
      return { inspection: data, alert };
    });
  }

  // ---------------- REQ-INT-003 Logistics ----------------
  /** EFMIS gpsFleet items built from the logistics tables (trucks, active trips, drivers, shipments). */
  async fleet() {
    return (await this.logisticsView.gpsFleet()).map(i => this.fleetItemOut(i));
  }

  async warehouseUtilization() {
    return (await this.logisticsView.warehouseUtilization()).map(w => this.warehouseItemOut(w));
  }

  async logistics(paginateFleet: <T>(items: T[]) => T[]) {
    const summary = await this.settings.get<any>('logisticsSummary', {});
    const fleet = await this.fleet();
    const lastIso = fleet.reduce((mx: string, t: any) => (t.lastUpdate && t.lastUpdate > mx ? t.lastUpdate : mx), '');
    return {
      activeTrucksInTransit: summary?.activeTrucksInTransit,
      totalDispatchedMT: summary?.totalDispatchedMT,
      dailyDeliveryRateMT: summary?.dailyDeliveryRateMT,
      bottlenecks: (await this.bottlenecks.find({ order: { delayHours: 'DESC' } })).map(b => ({ location: b.location, delayHours: b.delayHours, cause: b.cause })),
      gpsFleet: paginateFleet(fleet),
      warehouseUtilization: await this.warehouseUtilization(),
      lastGpsRefresh: lastIso ? stamp(new Date(lastIso)) : ''
    };
  }

  /**
   * Partner GPS platform ping (~every 5 minutes). The truck is resolved by fleet code and the position goes through the
   * logistics tracking pipeline (source PARTNER_FEED). stationaryHours >= 3 raises a theft/diversion alert (once per truck per hour).
   */
  async truckPing(truckId: string, b: TruckPingDto) {
    const truck = await this.trucks.findOneBy({ fleetCode: truckId });
    if (!truck) throw Errors.notFound(`Truck ${truckId}`);
    const [result] = await this.tracking.ingest([
      { truckId: truck.id, latitude: b.lat, longitude: b.lng, speedKmh: b.speedKmH, heading: b.heading ?? null, recordedAt: new Date() }
    ], 'PARTNER_FEED');
    if (result?.status === 'REJECTED') throw Errors.unprocessable(`GPS position rejected: ${result.reason || 'invalid position'}`, result);

    let [item] = await this.logisticsView.gpsFleet({ truckIds: [truck.id] });
    const stationaryAlert = (b.stationaryHours ?? 0) >= 3;
    if (stationaryAlert) {
      const dedupeKey = `TRUCK-STOP-${truck.fleetCode}-${nowStamp().slice(0, 13)}`;
      const existed = await this.alerts.repo.exists({ where: { dedupeKey } });
      const alert = await this.ds.transaction(m => this.alerts.raise({
        severity: 'HIGH_ORANGE', title: `Truck ${truck.fleetCode} stationary beyond threshold`, category: 'Theft/Diversion Risk',
        trigger: `Stationary ${b.stationaryHours} hrs at ${b.lat},${b.lng}`,
        affectedArea: item?.route && item.route !== '-' ? item.route : 'Transport corridor',
        actionRequired: 'Contact driver / transporter and verify cargo seal via QR scan', sourceType: 'TRUCK', sourceId: truck.fleetCode, dedupeKey
      }, m));
      if (!existed) this.realtime.publish('alert.created', { alertId: alert.id, truckId: truck.id, tripId: item?.tripId ?? null }, alert);
      if (item && item.status !== 'STOPPED_ALERT') {
        item = { ...item, status: 'STOPPED_ALERT', alertReason: b.alertReason || `Stationary for ${b.stationaryHours} hrs outside designated rest stop` };
      }
    }
    return this.fleetItemOut({ ...item, ingest: result ?? null });
  }

  /** Product used to reconcile a partner stock figure: explicit SKU, else the largest balance in the warehouse, else NPSB. */
  private async feedProduct(m: EntityManager, warehouseId: string, sku?: string): Promise<Product> {
    const products = m.getRepository(Product);
    if (sku) {
      const p = await products.findOneBy({ sku: sku.trim().toUpperCase() });
      if (!p) throw Errors.notFound(`Product ${sku}`);
      return p;
    }
    const top = await m.getRepository(InventoryBalance).findOne({ where: { warehouseId }, order: { onHandQuantity: 'DESC' } });
    const p = (top && (await products.findOneBy({ id: top.productId }))) || (await products.findOneBy({ sku: 'NPSB' }));
    if (!p) throw Errors.unprocessable('No product to reconcile against — pass productSku');
    return p;
  }

  /**
   * Partner warehouse stock feed for a registered logistics warehouse (resolved by name): updates capacity, reconciles
   * currentStockMT through an ADJUSTMENT on the inventory ledger, audited; utilisation >= 80% raises a HIGH alert
   * (once per warehouse per day).
   */
  async warehouseFeed(user: AuthUser, name: string, b: WarehouseFeedDto, ctx: RequestContext) {
    if (b.capacityMT === undefined && b.currentStockMT === undefined) throw Errors.unprocessable('capacityMT or currentStockMT is required');
    const warehouseId = await this.ds.transaction(async m => {
      const repo = m.getRepository(Warehouse);
      const w = await repo.createQueryBuilder('w').setLock('pessimistic_write').where('w.name = :name', { name }).getOne();
      if (!w) throw Errors.notFound(`Warehouse "${name}"`);
      const oldCapacity = w.capacityMt;
      if (b.capacityMT !== undefined && b.capacityMT !== w.capacityMt) {
        await repo.update({ id: w.id }, { capacityMt: b.capacityMT });
        w.capacityMt = b.capacityMT;
      }
      const before = await this.inventory.totals(w.id, m);
      let adjustment: Record<string, unknown> | null = null;
      if (b.currentStockMT !== undefined) {
        const diff = round(b.currentStockMT - before.onHand, 3);
        if (Math.abs(diff) >= 0.001) {
          const product = await this.feedProduct(m, w.id, b.productSku);
          // lot-tracked: increases go to the feed's lot, decreases come out first-expiry-first-out
          const ref = { type: 'FEED', id: w.code };
          const notes = 'Partner warehouse feed reconciliation';
          const moved = diff > 0
            ? [await this.inventory.deposit(w.id, product.id, diff, 'ADJUSTMENT', ref, user.name, { lotNumber: `FEED-${w.code}-${product.sku}` }, m, notes)]
            : await this.inventory.withdraw(w.id, product.id, -diff, 'ADJUSTMENT', ref, user.name, {}, m, notes);
          const bal = await this.inventory.totals(w.id, m);
          adjustment = { transactionIds: moved.map(x => x.txId), lots: moved.map(x => ({ lotNumber: x.lotNumber, quantity: x.quantity })), productSku: product.sku, onHandDelta: diff, onHandAfter: bal.onHand };
        }
      }
      const after = await this.inventory.totals(w.id, m);
      await this.audit.record(user, 'WAREHOUSE_STOCK_FEED_UPDATE', w.name, {
        old: { capacityMT: oldCapacity, currentStockMT: before.onHand }, new: { capacityMT: w.capacityMt, currentStockMT: after.onHand }, adjustment
      }, ctx, m);
      await this.inventory.checkCapacity(w.id, m);
      return w.id;
    });
    const [item] = await this.logisticsView.warehouseUtilization({ warehouseIds: [warehouseId] });
    return this.warehouseItemOut(item);
  }

  // ---------------- REQ-INT-004 Financials ----------------
  async financials() {
    const s = await this.settings.get<any>('financialSummary', {});
    const regions = await this.regions.find({ order: { creditArrearsEtb: 'DESC' } });
    const farmersWithArrears = await this.farmers.createQueryBuilder('f').where('f.creditArrearsEtb > 0').andWhere('f.deleted = false').getCount();
    return {
      ...(s || {}),
      ecxMarketPrices: await this.ecxOut(),
      creditArrearsByRegion: regions.map(r => ({ regionId: r.id, region: r.name, arrearsETB: r.creditArrearsEtb })),
      farmersWithArrears
    };
  }

  async ecxPrice(user: AuthUser, commodity: string, b: EcxPriceDto, ctx: RequestContext) {
    return this.ds.transaction(async m => {
      const repo = m.getRepository(EcxPrice);
      const old = await repo.findOneBy({ commodity });
      const price = b.priceETBPerQtl;
      const trend = old ? `${price >= old.priceEtbPerQtl ? '+' : ''}${round(((price - old.priceEtbPerQtl) / old.priceEtbPerQtl) * 100, 1)}%` : 'new';
      const sort = old ? old.sort : await repo.count();
      await repo.save({ commodity, priceEtbPerQtl: price, trend, sort });
      await this.audit.record(user, 'ECX_PRICE_FEED_UPDATE', commodity, { old: old ? old.priceEtbPerQtl : null, new: price, trend }, ctx, m);
      if (old && Math.abs((price - old.priceEtbPerQtl) / old.priceEtbPerQtl) >= 0.1) {
        await this.alerts.raise({
          severity: 'MEDIUM_YELLOW', title: `Significant ECX price change: ${commodity}`, category: 'Financial Issues', trigger: `Price moved ${trend}`,
          affectedArea: 'National markets', sourceType: 'ECX', sourceId: commodity
        }, m);
      }
      return { commodity, priceETBPerQtl: price, trend };
    });
  }
}
