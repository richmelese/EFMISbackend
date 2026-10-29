import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Farmer } from '../farmers/entities/farmer.entity';
import { Region } from '../admin-units/entities/region.entity';
import { DemandDocument } from '../national/entities/demand-document.entities';
import { PurchaseOrder, QuotaAdjustmentRequest, QuotaAllocation, QuotaLetter } from '../quota/entities/quota.entities';
import { can } from '../../common/constants/permissions';
import { AuthUser } from '../../common/types/auth-user';
import { isNational, scopeCondition } from '../../common/utils/scope';
import { nowStamp, stamp } from '../../common/utils/helpers';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { HierarchyService } from '../admin-units/hierarchy.service';
import { AggregationService } from '../aggregation/aggregation.service';
import { NationalFiguresService } from '../aggregation/national-figures.service';
import { AlertsService } from '../alerts/alerts.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ExternalService } from '../external/external.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { FarmersService } from '../farmers/farmers.service';
import { LogisticsViewService } from '../logistics/dashboard/logistics-view.service';
import { CopilotAskDto } from './dto/copilot.dto';

const OPEN_REQUEST_STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'APPEALED'];

/** Bootstrap payload (EFMIS_DATA shape), landing KPIs, role dashboards (REQ-1.6-001) and the EFMIS Copilot. */
@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Farmer) private readonly farmers: Repository<Farmer>,
    @InjectRepository(Region) private readonly regions: Repository<Region>,
    @InjectRepository(DemandDocument) private readonly documents: Repository<DemandDocument>,
    @InjectRepository(QuotaAllocation) private readonly allocations: Repository<QuotaAllocation>,
    @InjectRepository(QuotaLetter) private readonly letters: Repository<QuotaLetter>,
    @InjectRepository(QuotaAdjustmentRequest) private readonly adjustmentRequests: Repository<QuotaAdjustmentRequest>,
    @InjectRepository(PurchaseOrder) private readonly purchaseOrders: Repository<PurchaseOrder>,
    private readonly settings: SettingsService,
    private readonly users: UsersService,
    private readonly hierarchy: HierarchyService,
    private readonly aggregation: AggregationService,
    private readonly nationalFigures: NationalFiguresService,
    private readonly alerts: AlertsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly external: ExternalService,
    private readonly integrations: IntegrationsService,
    private readonly farmersService: FarmersService,
    private readonly logisticsView: LogisticsViewService
  ) {}

  // ---------------- shared pieces ----------------
  private async systemMetadata() {
    return { ...((await this.settings.get<any>('systemMetadata', {})) || {}), lastRefresh: new Date().toISOString() };
  }

  private async rolesOut() {
    return (await this.users.roles.find()).map(r => ({ id: r.id, name: r.name, level: r.level, desc: r.description }));
  }

  private async fertilizerTypesOut() {
    return (await this.hierarchy.fertilizerTypes.find()).map(f => ({ code: f.code, name: f.name, unit: f.unit, color: f.color, desc: f.description }));
  }

  private async openAlerts() {
    const rows = await this.alerts.repo.find({ where: { resolved: false }, order: { timestamp: 'DESC' } });
    return rows.map(a => this.alerts.toFrontend(a));
  }

  private async latestDocument() {
    return (await this.documents.find({ order: { createdAt: 'DESC' }, take: 1 }))[0] || null;
  }

  private regionsSubmitted() {
    return this.regions.countBy({ approvalStatus: 'Submitted to MoA' });
  }

  // ---------------- GET /meta ----------------
  async meta() {
    return {
      systemMetadata: await this.systemMetadata(),
      roles: await this.rolesOut(),
      fertilizerTypes: await this.fertilizerTypesOut(),
      languages: ['en', 'am', 'om']
    };
  }

  // ---------------- GET /bootstrap ----------------
  async bootstrap(u: AuthUser) {
    const canFarmers = can(u, 'farmers:read');
    const canIntegrations = can(u, 'integrations:read');
    const canAudit = can(u, 'audit:read');
    const fin = (await this.settings.get<any>('financialSummary', {})) || {};
    const qs = (await this.settings.get<any>('qualitySummary', {})) || {};
    const ls = (await this.settings.get<any>('logisticsSummary', {})) || {};
    const i = this.integrations;

    let farmerRegistry: any[] = [];
    if (canFarmers) {
      const s = scopeCondition(u, 'f', 'kebeleId');
      const farmers = await this.farmers.createQueryBuilder('f').leftJoinAndSelect('f.demands', 'd')
        .where('f.deleted = false').andWhere(s.sql, s.params).orderBy('f.id', 'ASC').addOrderBy('d.id', 'ASC').getMany();
      farmerRegistry = [];
      for (const f of farmers) farmerRegistry.push(await this.farmersService.toFrontend(f));
    }

    return {
      systemMetadata: await this.systemMetadata(),
      roles: await this.rolesOut(),
      fertilizerTypes: await this.fertilizerTypesOut(),
      regions: await this.hierarchy.nestedRegions(isNational(u) ? null : u.regionId),
      farmerRegistry,
      carryOverStocks: await this.nationalFigures.carryOver(),
      procurement: canIntegrations ? {
        activeTenders: (await i.tenders.find({ order: { deadline: 'ASC' } })).map(t => i.tenderOut(t, false)),
        vessels: (await i.vessels.find({ order: { etaDjibouti: 'ASC' } })).map(v => i.vesselOut(v, false))
      } : null,
      logistics: canIntegrations ? {
        ...ls,
        bottlenecks: (await i.bottlenecks.find({ order: { id: 'ASC' } })).map(b => ({ location: b.location, delayHours: b.delayHours, cause: b.cause })),
        gpsFleet: await this.logisticsView.gpsFleet(),
        warehouseUtilization: await this.logisticsView.warehouseUtilization()
      } : null,
      qualityControl: canIntegrations ? { ...qs, inspections: await i.inspectionsData() } : null,
      financials: { ...fin, ecxMarketPrices: await i.ecxOut() },
      criticalAlerts: (await this.alerts.repo.find({ order: { resolved: 'ASC', timestamp: 'DESC' } })).map(a => this.alerts.toFrontend(a)),
      auditTrail: canAudit ? await this.audit.list({ limit: 200 }) : []
    };
  }

  // ---------------- GET /dashboard/overview ----------------
  async overview() {
    const net = await this.nationalFigures.netImport();
    const fin = (await this.settings.get<any>('financialSummary', {})) || {};
    const qs = (await this.settings.get<any>('qualitySummary', {})) || {};
    const ls = (await this.settings.get<any>('logisticsSummary', {})) || {};
    const open = await this.openAlerts();
    const regs = await this.regions.find();
    const doc = await this.latestDocument();
    const poCount = await this.purchaseOrders.count();
    return {
      season: net.season,
      grossNationalDemandMT: net.grossNationalDemandMT,
      usableCarryOverMT: net.usableCarryOverMT,
      netImportRequirementMT: net.netImportRequirementMT,
      demandGrowthYoYPct: 4.2,
      validatedPct: 100,
      registeredFarmers: regs.reduce((s, r) => s + (r.registeredFarmers || 0), 0),
      faydaVerifiedFarmers: 9250000,
      qualityPassRate: qs.overallPassRate, testedBatchesCount: qs.testedBatchesCount,
      dailyDeliveryRateMT: ls.dailyDeliveryRateMT, activeTrucksInTransit: ls.activeTrucksInTransit,
      nationalRepaymentRate: fin.nationalRepaymentRate,
      collectionChannels: { telebirr: fin.telebirrCollectionETB, cbeVouchers: fin.cbeBankVoucherETB, cash: fin.cashCollectionETB },
      ecxMarketPrices: await this.integrations.ecxOut(),
      alerts: { open: open.length, critical: open.filter(a => a.severity === 'CRITICAL_RED').length, latest: open[0] || null },
      pipeline: [
        { stage: 1, name: 'Farmer Registration & Demand', status: 'ACTIVE', metric: `${await this.farmers.countBy({ deleted: false })} records in registry` },
        { stage: 2, name: 'Kebele → Region Aggregation', status: 'ACTIVE', metric: `${await this.regionsSubmitted()} regions submitted` },
        { stage: 3, name: 'National Validation', status: doc?.status === 'FINAL' ? 'COMPLETED' : 'IN_PROGRESS', metric: doc?.docNo || '-' },
        { stage: 4, name: 'Quota Allocation', status: 'ACTIVE', metric: `${await this.allocations.count()} quota lines` },
        { stage: 5, name: 'Procurement (EABC)', status: poCount ? 'ACTIVE' : 'PENDING', metric: `${await this.integrations.tenders.count()} tenders` }
      ]
    };
  }

  // ---------------- GET /dashboard (role widgets) ----------------
  async dashboard(u: AuthUser) {
    const s = scopeCondition(u, 'f', 'kebeleId');
    const count = (extra?: string) => {
      const qb = this.farmers.createQueryBuilder('f').where('f.deleted = false').andWhere(s.sql, s.params);
      if (extra) qb.andWhere(extra);
      return qb.getCount();
    };
    const widgets: Record<string, any> = {};
    if (['DA', 'KEBELE', 'WOREDA', 'ZONE', 'REGION'].includes(u.role)) {
      widgets.farmers = {
        total: await count(),
        pendingKebeleReview: await count(`f.approvalLevel = 'Pending Kebele Review'`),
        flaggedAnomalies: await count(`EXISTS (SELECT 1 FROM farmer_demands d WHERE d.farmer_id = f.id AND d.status = 'FLAGGED_ANOMALY')`),
        returnedForRevision: await count(`f.approvalLevel = 'Returned for Revision'`)
      };
    }
    if (u.role === 'DA') {
      const r = await this.farmers.createQueryBuilder('f').select('MAX(f.updatedAt)', 'm')
        .where('f.daUserId = :uid', { uid: u.id }).andWhere(`f.source = 'OFFLINE_SYNC'`).getRawOne();
      widgets.offline = { lastSync: r?.m ? stamp(r.m) : null };
    }
    if (u.role === 'WOREDA' && u.woredaId) widgets.unit = (await this.aggregation.drilldown('WOREDA', u.woredaId)).totals;
    if (u.role === 'ZONE' && u.zoneId) widgets.unit = (await this.aggregation.drilldown('ZONE', u.zoneId)).totals;
    if (u.role === 'REGION' && u.regionId) {
      widgets.unit = (await this.aggregation.drilldown('REGION', u.regionId)).totals;
      widgets.quota = {
        letters: (await this.letters.find({ where: { regionId: u.regionId }, order: { createdAt: 'ASC' } })).map(l => ({ controlNo: l.controlNo, status: l.status })),
        pendingRequests: await this.adjustmentRequests.countBy({ regionId: u.regionId, status: In(OPEN_REQUEST_STATUSES) })
      };
    }
    if (['MOA', 'FTWG', 'ATI', 'PMO', 'ADMIN', 'AUDITOR'].includes(u.role)) {
      const net = await this.nationalFigures.netImport();
      const doc = await this.latestDocument();
      widgets.national = {
        grossMT: net.grossNationalDemandMT, carryOverMT: net.usableCarryOverMT, netImportMT: net.netImportRequirementMT,
        document: doc ? { status: doc.status, documentNo: doc.docNo } : null
      };
      widgets.regionsSubmitted = await this.regionsSubmitted();
      widgets.pendingAdjustmentRequests = await this.adjustmentRequests.countBy({ status: In(OPEN_REQUEST_STATUSES) });
    }
    if (['EABC', 'MOA', 'PMO'].includes(u.role)) {
      widgets.procurement = {
        tenders: await this.integrations.tenders.count(),
        purchaseOrders: (await this.purchaseOrders.find({ order: { createdAt: 'DESC' }, take: 5 })).map(p => ({ controlNo: p.controlNo, status: p.status }))
      };
    }
    const open = await this.openAlerts();
    widgets.alerts = {
      critical: open.filter(a => a.severity === 'CRITICAL_RED').length, high: open.filter(a => a.severity === 'HIGH_ORANGE').length,
      medium: open.filter(a => a.severity === 'MEDIUM_YELLOW').length, low: open.filter(a => a.severity === 'LOW_BLUE').length
    };
    widgets.notificationsUnread = (await this.notifications.forUser(u, { unreadOnly: true })).length;
    return { role: u.role, user: { name: u.name, title: u.title }, generatedAt: nowStamp(), refreshSeconds: 300, widgets };
  }

  // ---------------- POST /copilot/ask (rule-based, answers from live data) ----------------
  async ask(dto: CopilotAskDto) {
    const text = dto.message.toLowerCase();
    const am = (dto.lang || 'en') === 'am';
    const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
    let reply: string;
    let action: { label: string; module: string } | null = null;
    if (/net import|demand|target|ግዥ|ፍላጎት/.test(text)) {
      const n = await this.nationalFigures.netImport();
      reply = `**${am ? 'የሀገራዊ ፍላጎት ውሳኔ' : 'National Demand Determination'} (${n.season}):**\n• Gross Demand: **${fmt(n.grossNationalDemandMT)} MT**\n• Usable Carry-Over Stock: **${fmt(n.usableCarryOverMT)} MT** (ECAE certified)\n• **Net Import Requirement: ${fmt(n.netImportRequirementMT)} MT**`;
      action = { label: am ? 'የሚኒስቴሩን ሰነድ ክፈት' : 'Open MoA Demand Document', module: 'nationalValidation' };
    } else if (/vessel|ship|abbay|port|መርከብ|ጅቡቲ/.test(text)) {
      const vs = await this.integrations.vessels.find({ order: { etaDjibouti: 'ASC' } });
      reply = `**${am ? 'የጅቡቲ ወደብ መረጃ' : 'Port Djibouti Vessel Status'}:**\n` + vs.map(v => `• **${v.name}** (${v.cargo}) — ${v.berthingStatus}; ETA ${v.etaDjibouti}; demurrage risk ${v.demurrageRisk}`).join('\n');
      action = { label: am ? 'የሎጅስቲክስ ክትትልን እይ' : 'View Logistics Fleet Telemetry', module: 'logistics' };
    } else if (/soil|nsis|oromia|hafas|አፈር|ኦሮሚያ/.test(text)) {
      const p = await this.external.nsisProfile('REG-OROMIA');
      reply = p
        ? `**HaFAS ${am ? 'ምክረ-ሃሳብ ለኦሮሚያ' : 'Recommendation for Oromia'}:**\n• P deficiency ${p.deficiencies.P}%, B deficiency ${p.deficiencies.B}%, acidic area ${p.acidity.acidicAreaPct}%\n• Prescribed: **70% Fortified NPSB + 30% Granular Urea** (NPSB ${p.recommendedRatesKgHa.NPSB} kg/ha, Urea ${p.recommendedRatesKgHa.UREA} kg/ha)\n• Confidence: ${p.confidence} (${p.verifiedPct}% verified)`
        : (am ? 'የNSIS የአፈር መረጃ ለኦሮሚያ አልተገኘም።' : 'NSIS soil profile for Oromia is not available.');
      action = { label: am ? 'የNSIS የአፈር ካርታን መርምር' : 'Inspect NSIS Geospatial Map', module: 'regionalSoil' };
    } else if (/telebirr|collection|payment|credit|repay|ቴሌብር|ሽያጭ/.test(text)) {
      const f = (await this.settings.get<any>('financialSummary', {})) || {};
      reply = `**${am ? 'የዲጂታል ፋይናንስና የብድር ሁኔታ' : 'Digital Fertilizer Finance & Credit Status'}:**\n• Total sales: **${f.totalSalesETB}**\n• TeleBirr: **${f.telebirrCollectionETB}**\n• CBE vouchers: ${f.cbeBankVoucherETB}\n• Repayment rate: **${f.nationalRepaymentRate}%**`;
      action = { label: am ? 'የሽያጭና ፋይናንስ ዳሽቦርድ ክፈት' : 'Open Sales & Financial Dashboard', module: 'farmerSales' };
    } else if (/alert|critical|sla|ማስጠንቀቂያ/.test(text)) {
      const open = await this.openAlerts();
      reply = `**${open.length} open alerts**\n` + open.slice(0, 5).map(a => `• [${a.severity}] ${a.title} — SLA ${a.slaHoursRemaining}h remaining`).join('\n');
      action = { label: am ? 'የማስጠንቀቂያ ማዕከል' : 'Open Critical Alert Center', module: 'criticalAlerts' };
    } else if (/quota|allocation|ኮታ/.test(text)) {
      const regs = await this.regions.find({ order: { quotaAllocationMt: 'DESC' }, take: 5 });
      reply = `**${am ? 'የክልል ኮታ' : 'Regional quotas'}:**\n` + regs.map(r => `• ${r.name}: ${fmt(r.quotaAllocationMt)} MT`).join('\n');
      action = { label: am ? 'የኮታ ድልድል ክፈት' : 'Open Quota Allocation', module: 'quotaAllocation' };
    } else {
      reply = am
        ? `ስለ "${dto.message}" የEFMIS መረጃ ማዕከልን ፈትሼያለሁ። ስለ ፍላጎት፣ መርከብ፣ አፈር፣ ኮታ፣ ማስጠንቀቂያ ወይም ቴሌብር ይጠይቁ።`
        : `I searched EFMIS data for "${dto.message}". Try asking about national demand, vessels, soil/NSIS, quotas, alerts or TeleBirr collections.`;
    }
    return { reply, action, time: nowStamp().slice(11, 16), sources: 'Live EFMIS database' };
  }
}

