import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { EFMIS_DATA } from './data/efmis-data';
import * as daily from './data/daily-reports-data';
import { RULES } from '../../common/constants/rules';
import { nowStamp, parseStamp, sha256 } from '../../common/utils/helpers';
import { AuditService } from '../../modules/audit/audit.service';
import { SignaturesService } from '../../modules/signatures/signatures.service';
import { UsersService } from '../../modules/users/users.service';
import { Setting } from '../../modules/settings/entities/setting.entity';
import { Season } from '../../modules/seasons/entities/season.entity';
import { backfillAdminUnits, backfillUserUnits } from '../../modules/admin-units/admin-unit-backfill';
import { seasonFromName, seasonStatusRelativeTo } from '../../modules/seasons/season-calendar';
import { RoleEntity } from '../../modules/users/entities/role.entity';
import { RbacService } from '../../modules/users/rbac.service';
import { backfillOpeningLots } from '../../modules/logistics/warehouses/lot-backfill';
import { User } from '../../modules/users/entities/user.entity';
import { FertilizerType } from '../../modules/hierarchy/entities/fertilizer-type.entity';
import { Region } from '../../modules/hierarchy/entities/region.entity';
import { Zone } from '../../modules/hierarchy/entities/zone.entity';
import { Woreda } from '../../modules/hierarchy/entities/woreda.entity';
import { Kebele } from '../../modules/hierarchy/entities/kebele.entity';
import { NsisSoilProfile } from '../../modules/hierarchy/entities/nsis-soil-profile.entity';
import { Farmer } from '../../modules/farmers/entities/farmer.entity';
import { FarmerDemand } from '../../modules/farmers/entities/farmer-demand.entity';
import { CarryOverFacility, CarryOverStock } from '../../modules/national/entities/carry-over.entities';
import { FtwgSession } from '../../modules/national/entities/ftwg.entities';
import { DemandDocument, DocumentSignature } from '../../modules/national/entities/demand-document.entities';
import { EcxPrice, LogisticsBottleneck, QualityInspection, Tender, Vessel } from '../../modules/integrations/entities/integration.entities';
import { Warehouse } from '../../modules/logistics/warehouses/entities/warehouse.entities';
import { LOGISTICS_ROLES, LOGISTICS_USERS, seedLogistics } from './logistics.seed';
import { Alert } from '../../modules/alerts/entities/alert.entity';
import { DemandAdjustment } from '../../modules/reviews/entities/demand-adjustment.entity';
import { Comment } from '../../modules/comments/entities/comment.entity';
import { QuotaAllocation } from '../../modules/quota/entities/quota.entities';
import { DailySummaryDate, DailySummaryRecord, LotUnion, ReportRegion, UnionDailyLoad, VesselLot } from '../../modules/reports/entities/report.entities';

export const DEMO_PASSWORD = 'Efmis@2026';
export const DEMO_PIN = '1234';

/** Quota factor inputs per region (REQ-1.4-001): historical uptake, NSIS soil need index, credit arrears. */
const REGION_FACTORS: Record<string, { hist: number; soil: number; arrears: number }> = {
  'REG-OROMIA': { hist: 1002000, soil: 1.0, arrears: 1_200_000_000 },
  'REG-AMHARA': { hist: 731500, soil: 1.15, arrears: 900_000_000 },
  'REG-SIDAMA': { hist: 174800, soil: 1.1, arrears: 150_000_000 },
  'REG-SOUTH': { hist: 188600, soil: 1.0, arrears: 400_000_000 },
  'REG-TIGRAY': { hist: 92400, soil: 0.95, arrears: 600_000_000 },
  'REG-SOMALI': { hist: 33900, soil: 0.8, arrears: 50_000_000 },
  'REG-OTHER': { hist: 29100, soil: 0.9, arrears: 80_000_000 }
};

// N, P, S, B, Zn, K deficiency %, acidic area %, pH, OM %, drought risk, rainfall anomaly %, NPSB kg/ha, Urea kg/ha, confidence, verified %, soil cores
const SOIL: Record<string, [number, number, number, number, number, number, number, number, number, string, number, number, number, string, number, number]> = {
  'REG-OROMIA': [72, 81, 64, 38, 29, 6, 31, 5.8, 2.1, 'MODERATE', -8, 100, 120, 'HIGH', 94.2, 6200],
  'REG-AMHARA': [78, 88, 61, 33, 47, 5, 42, 5.5, 1.8, 'MODERATE', -12, 110, 130, 'HIGH', 93.1, 5100],
  'REG-SIDAMA': [55, 74, 69, 22, 18, 9, 64, 5.1, 3.0, 'LOW', -3, 100, 100, 'MEDIUM', 88.7, 1400],
  'REG-SOUTH': [63, 70, 41, 45, 20, 8, 37, 5.6, 2.6, 'LOW', -5, 100, 110, 'MEDIUM', 90.4, 1900],
  'REG-TIGRAY': [69, 66, 35, 18, 24, 4, 12, 6.9, 1.2, 'HIGH', -21, 90, 110, 'MEDIUM', 86.5, 1600],
  'REG-SOMALI': [58, 32, 15, 9, 12, 3, 4, 7.8, 0.8, 'SEVERE', -34, 60, 120, 'LOW', 71.0, 900],
  'REG-OTHER': [52, 49, 28, 31, 16, 7, 48, 5.3, 2.4, 'MODERATE', -10, 90, 100, 'LOW', 76.3, 1300]
};

// [id, name, email, phone, faydaId, role, title, scope]
const USERS: Array<[string, string, string, string, string | null, string, string, { region?: string; zone?: string; woreda?: string; kebele?: string }]> = [
  ['U-ADMIN-01', 'EFMIS System Administrator', 'admin@efmis.gov.et', '0911000001', null, 'ADMIN', 'Super Admin', {}],
  ['U-MOA-01', 'Dr. Melesse Mekonnen', 'melesse.mekonnen@moa.gov.et', '0911000002', 'FAN-1000-2000-3001', 'MOA', 'State Minister, Ministry of Agriculture (FDRE)', {}],
  ['U-MOA-02', 'MoA National Planning Officer', 'admin.moa@efmis.gov.et', '0911234567', 'FAYDA-ETH-8829-4921', 'MOA', 'National Input Planning Directorate', {}],
  ['U-FTWG-01', 'Dr. Kassa Mengistu', 'kassa.mengistu@ftwg.gov.et', '0911000003', null, 'FTWG', 'Chairperson, Fertilizer Technical Working Group', {}],
  ['U-FTWG-02', 'Dr. Tigist Alemu (EIAR)', 'tigist.alemu@ftwg.gov.et', '0911000013', null, 'FTWG', 'FTWG Member, Soil Fertility', {}],
  ['U-ATI-01', 'Dr. Mandefro Nigussie', 'mandefro.nigussie@ati.gov.et', '0911000004', null, 'ATI', 'Director General, Agricultural Transformation Institute', {}],
  ['U-EABC-01', 'EABC Procurement Director', 'procurement@eabc.gov.et', '0911000005', null, 'EABC', 'EABC Procurement Directorate', {}],
  ['U-PMO-01', 'PMO Delivery Unit Analyst', 'delivery@pmo.gov.et', '0911000006', null, 'PMO', "Prime Minister's Office", {}],
  ['U-ECAE-01', 'ECAE Chief Chemist', 'lab@ecae.gov.et', '0911000007', null, 'ECAE', 'ECAE Central Quality Lab', {}],
  ['U-AUD-01', 'Federal Auditor General Office', 'auditor@efmis.gov.et', '0911000008', null, 'AUDITOR', 'Auditor (read-only)', {}],
  ['U-REG-01', 'Oromia BoA Bureau Head', 'boa.oromia@efmis.gov.et', '0911000009', null, 'REGION', 'Head, Oromia Bureau of Agriculture', { region: 'REG-OROMIA' }],
  ['U-REG-02', 'Amhara BoA Bureau Head', 'boa.amhara@efmis.gov.et', '0911000010', null, 'REGION', 'Head, Amhara Bureau of Agriculture', { region: 'REG-AMHARA' }],
  ['U-ZON-01', 'East Shewa Zone Director', 'zone.eshewa@efmis.gov.et', '0911000011', null, 'ZONE', 'East Shewa Zonal Agriculture Bureau', { zone: 'ZONE-OR-ESHEWA' }],
  ['U-WOR-01', 'Adama Woreda Agronomist', 'woreda.adama@efmis.gov.et', '0911000012', null, 'WOREDA', 'Adama Woreda Agriculture Office', { woreda: 'WOR-OR-ADAMA' }],
  ['U-WOR-02', 'Lume Woreda Agronomist', 'woreda.lume@efmis.gov.et', '0911000014', null, 'WOREDA', 'Lume Woreda Agriculture Office', { woreda: 'WOR-OR-LUME' }],
  ['U-KEB-01', 'Wonji Gefersa Kebele Officer', 'kebele.wonji@efmis.gov.et', '0911000015', null, 'KEBELE', 'Kebele Agricultural Officer', { kebele: 'KEB-01' }],
  ['U-KEB-04', 'Koka Negewo Kebele Officer', 'kebele.koka@efmis.gov.et', '0911000016', null, 'KEBELE', 'Kebele Agricultural Officer', { kebele: 'KEB-04' }],
  ['U-DA-01', 'Bekele Tadesse', 'da.bekele@efmis.gov.et', '0911000017', null, 'DA', 'Development Agent (DA-OR-01)', { kebele: 'KEB-01' }],
  ['U-DA-04', 'Derese Gudeta', 'da.derese@efmis.gov.et', '0911000018', null, 'DA', 'Development Agent (DA-OR-04)', { kebele: 'KEB-04' }]
];

const STATUS_TO_UNIT: Record<string, string> = { 'Submitted to MoA': 'SUBMITTED', 'Approved by BoA': 'APPROVED', 'Pending Regional Signoff': 'PENDING' };

/**
 * Seeds master/demo data from the frontend's own data files so API responses match what the UI renders today.
 */
@Injectable()
export class SeedService {
  private readonly logger = new Logger('Seed');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly audit: AuditService,
    private readonly signatures: SignaturesService,
    private readonly users: UsersService,
    private readonly config: ConfigService,
    private readonly rbac: RbacService
  ) {}

  async isEmpty(): Promise<boolean> {
    return (await this.ds.getRepository(Region).count()) === 0;
  }

  async seedIfEmpty(): Promise<boolean> {
    if (!(await this.isEmpty())) return false;
    await this.seed();
    return true;
  }

  /** Drop everything and rebuild the schema from migrations. */
  async reset(): Promise<void> {
    await this.ds.dropDatabase();
    await this.ds.runMigrations();
  }

  async seed(): Promise<void> {
    this.logger.log('Seeding EFMIS master data...');
    await this.ds.transaction(async m => {
      await this.seedReference(m);
      const units = await this.seedHierarchy(m);
      await backfillAdminUnits(m);
      await this.seedUsers(m, units);
      await backfillUserUnits(m);
      await this.seedFarmers(m, units);
      await this.seedNational(m);
      await this.seedIntegrations(m);
      await this.seedReviews(m);
      await this.seedQuota(m);
      await seedLogistics(m);
      await backfillOpeningLots(m);
      for (const [id, , , , , , whCode] of LOGISTICS_USERS) {
        if (whCode) await m.getRepository(User).update({ id }, { warehouseId: (await m.getRepository(Warehouse).findOneByOrFail({ code: whCode })).id });
      }
      await this.seedReports(m);
      await this.seedAuditHistory(m);
      await this.seedDemandDocument(m);
    });
    // Permission catalogue + default role grants (the database is the source of truth for authorisation).
    await this.rbac.syncCatalog();
    this.logger.log(`Seed complete. Demo password: ${DEMO_PASSWORD} | e-signature PIN: ${DEMO_PIN}`);
  }

  // ---------------------------------------------------------------------------
  private async seedReference(m: EntityManager) {
    const meta = EFMIS_DATA.systemMetadata;
    const settings: Record<string, unknown> = {
      systemMetadata: { version: meta.version, releaseDate: meta.releaseDate, proclamationRef: meta.proclamationRef, currentSeason: meta.currentSeason, seasons: meta.seasons, nationalTargetMT: meta.nationalTargetMT },
      quotaWeights: RULES.defaultQuotaWeights,
      financialSummary: {
        totalSalesETB: EFMIS_DATA.financials.totalSalesETB, telebirrCollectionETB: EFMIS_DATA.financials.telebirrCollectionETB,
        cbeBankVoucherETB: EFMIS_DATA.financials.cbeBankVoucherETB, cashCollectionETB: EFMIS_DATA.financials.cashCollectionETB,
        nationalRepaymentRate: EFMIS_DATA.financials.nationalRepaymentRate
      },
      qualitySummary: { overallPassRate: EFMIS_DATA.qualityControl.overallPassRate, testedBatchesCount: EFMIS_DATA.qualityControl.testedBatchesCount },
      logisticsSummary: {
        activeTrucksInTransit: EFMIS_DATA.logistics.activeTrucksInTransit, totalDispatchedMT: EFMIS_DATA.logistics.totalDispatchedMT,
        dailyDeliveryRateMT: EFMIS_DATA.logistics.dailyDeliveryRateMT
      },
      anomalyThresholdPct: RULES.anomalyThresholdPct,
      kebeleEscalationDays: this.config.get<number>('kebeleEscalationDays') ?? 7
    };
    await m.getRepository(Setting).save(Object.entries(settings).map(([key, value]) => ({ key, value, updatedBy: 'seed' })));
    const current = seasonFromName(meta.currentSeason);
    for (const name of new Set([meta.currentSeason, ...meta.seasons])) {
      const s = seasonFromName(name);
      if (s) await m.getRepository(Season).insert({ ...s, status: seasonStatusRelativeTo(s, current), isCurrent: s.id === current?.id });
    }

    const extraRoles = [
      { id: 'ATI', name: 'Agricultural Transformation Institute', level: 'National', desc: 'Demand document co-signatory, farmer registry custodian' },
      { id: 'ECAE', name: 'Ethiopian Conformity Assessment Enterprise', level: 'Enterprise', desc: 'Quality lab results, Certificates of Conformity' },
      { id: 'ADMIN', name: 'Super Admin', level: 'System', desc: 'System administration and user management' },
      { id: 'AUDITOR', name: 'Auditor', level: 'System', desc: 'Read-only access to audit trail and compliance reports' }
    ];
    await m.getRepository(RoleEntity).save([...EFMIS_DATA.roles, ...extraRoles, ...LOGISTICS_ROLES].map((r: any) => ({ id: r.id, name: r.name, level: r.level, description: r.desc, baseRole: r.id, isSystem: true, active: true })));
    await m.getRepository(FertilizerType).save(EFMIS_DATA.fertilizerTypes.map((f: any) => ({ code: f.code, name: f.name, unit: f.unit, color: f.color, description: f.desc })));
  }

  private async seedHierarchy(m: EntityManager) {
    const units = { kebele: {} as Record<string, { regionId: string; zoneId: string; woredaId: string }>, woreda: {} as Record<string, { regionId: string; zoneId: string }>, zone: {} as Record<string, { regionId: string }>, kebeleByName: {} as Record<string, string>, regionByName: {} as Record<string, string> };
    let zs = 0, ws = 0, ks = 0;
    for (const [i, r] of (EFMIS_DATA.regions as any[]).entries()) {
      const f = REGION_FACTORS[r.id] || { hist: r.grossDemandMT * 0.95, soil: 1, arrears: 0 };
      await m.getRepository(Region).insert({
        id: r.id, name: r.name, code: r.code, sharePercent: r.sharePercent, grossDemandMt: r.grossDemandMT, quotaAllocationMt: r.quotaAllocationMT,
        registeredFarmers: r.registeredFarmers, approvalStatus: r.approvalStatus, soilDeficiency: r.soilDeficiency,
        historicalUptakeMt: f.hist, soilNeedIndex: f.soil, creditArrearsEtb: f.arrears, maxFarmSizeHa: r.id === 'REG-SOMALI' ? 80 : RULES.defaultMaxFarmSizeHa, sort: i
      });
      units.regionByName[r.name] = r.id;
      const s = SOIL[r.id];
      if (s) {
        await m.getRepository(NsisSoilProfile).insert({
          regionId: r.id, nDeficiencyPct: s[0], pDeficiencyPct: s[1], sDeficiencyPct: s[2], bDeficiencyPct: s[3], znDeficiencyPct: s[4], kDeficiencyPct: s[5],
          acidicAreaPct: s[6], avgPh: s[7], organicMatterPct: s[8], droughtRisk: s[9], rainfallAnomalyPct: s[10], recommendedNpsbKgHa: s[11],
          recommendedUreaKgHa: s[12], confidence: s[13], verifiedPct: s[14], soilCores: s[15], dataVersion: 'NSIS-2026.2'
        });
      }
      for (const z of r.zones) {
        await m.getRepository(Zone).insert({ id: z.id, regionId: r.id, name: z.name, status: STATUS_TO_UNIT[r.approvalStatus] || 'PENDING', sort: zs++ });
        units.zone[z.id] = { regionId: r.id };
        for (const w of z.woredas) {
          await m.getRepository(Woreda).insert({ id: w.id, zoneId: z.id, name: w.name, status: 'PENDING', sort: ws++ });
          units.woreda[w.id] = { regionId: r.id, zoneId: z.id };
          for (const k of w.kebeles) {
            await m.getRepository(Kebele).insert({ id: k.id, woredaId: w.id, name: k.name, daName: k.da, farmers: k.farmers, demandMt: k.demandMT, status: 'APPROVED', sort: ks++ });
            units.kebele[k.id] = { regionId: r.id, zoneId: z.id, woredaId: w.id };
            units.kebeleByName[k.name] = k.id;
          }
        }
      }
    }
    return units;
  }

  private async seedUsers(m: EntityManager, units: Awaited<ReturnType<SeedService['seedHierarchy']>>) {
    const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 10);
    const pinHash = bcrypt.hashSync(DEMO_PIN, 10);
    for (const [id, fullName, email, phone, faydaId, role, title, scope] of USERS) {
      let regionId = scope.region || null, zoneId = scope.zone || null, woredaId = scope.woreda || null;
      const kebeleId = scope.kebele || null;
      if (kebeleId) ({ regionId, zoneId, woredaId } = units.kebele[kebeleId]);
      else if (woredaId) ({ regionId, zoneId } = units.woreda[woredaId]);
      else if (zoneId) ({ regionId } = units.zone[zoneId]);
      await m.getRepository(User).insert({ id, fullName, email, phone, faydaId, passwordHash, pinHash, role, title, regionId, zoneId, woredaId, kebeleId });
    }
    for (const [id, fullName, email, phone, role, title] of LOGISTICS_USERS) {
      await m.getRepository(User).insert({ id, fullName, email, phone, passwordHash, pinHash, role, title });
    }
  }

  private async seedFarmers(m: EntityManager, units: Awaited<ReturnType<SeedService['seedHierarchy']>>) {
    const season = EFMIS_DATA.systemMetadata.currentSeason;
    for (const f of EFMIS_DATA.farmerRegistry as any[]) {
      const kebeleId = units.kebeleByName[f.kebele];
      const chain = units.kebele[kebeleId];
      const [first, middle, ...rest] = String(f.name).split(' ');
      const da = await m.getRepository(User).findOne({ where: { fullName: f.daName, role: 'DA' } });
      const created = parseStamp(`${f.submissionDate} 09:00:00`);
      await m.getRepository(Farmer).insert({
        id: f.id, firstName: first, middleName: middle, lastName: rest.join(' '), name: f.name, faydaId: f.faydaId, faydaStatus: f.faydaStatus,
        nationalIdNumber: f.nationalIdNumber, phone: f.phone, gender: f.gender, ageGroup: f.ageGroup, householdSize: f.householdSize,
        educationLevel: f.educationLevel, primaryOccupation: f.primaryOccupation, regionId: chain.regionId, zoneId: chain.zoneId, woredaId: chain.woredaId,
        kebeleId, region: f.region, zone: f.zone, woreda: f.woreda, kebele: f.kebele, cooperative: f.cooperative, landCertNumber: f.landCertNumber,
        landCertVerified: true, farmSizeHa: f.farmSizeHa, irrigationAccess: f.irrigationAccess, landTenure: f.landTenure, crops: f.crops, season,
        submissionDate: f.submissionDate, daUserId: da?.id ?? null, daName: f.daName, creditScore: f.creditScore, creditArrearsEtb: f.creditArrearsETB,
        telebirrPhone: f.telebirrPhone, cbeAccount: f.cbeAccount, photoUrl: f.photoUrl, approvalLevel: f.approvalLevel, notes: f.notes, consentGiven: true,
        createdAt: created, updatedAt: created
      });
      await m.getRepository(FarmerDemand).insert(f.demands.map((d: any) => ({
        farmerId: f.id, type: d.type, requestedQtl: d.requestedQtl, recommendedQtl: d.recommendedQtl, approvedQtl: d.approvedQtl, status: d.status
      })));
    }
  }

  private async seedNational(m: EntityManager) {
    const co = EFMIS_DATA.carryOverStocks;
    await m.getRepository(CarryOverFacility).insert(co.byFacilityType.map((c: any, i: number) => ({ facility: c.facility, usableMt: c.usableMT, unverifiedMt: c.unverifiedMT, qcPassPercent: c.qcPassPercent, sort: i })));
    await m.getRepository(CarryOverStock).insert(co.byFertilizer.map((c: any, i: number) => ({ type: c.type, stockMt: c.stockMT, usableMt: c.usableMT, expiredMt: c.expiredMT, qcStatus: c.qcStatus, sort: i, updatedBy: 'seed' })));
    await m.getRepository(FtwgSession).insert({
      id: 'FTWG-SESSION-MEHER-26', title: 'FTWG Consensus Session - Meher 2026 National Demand',
      agenda: 'Validate gross national demand, carry-over deduction and net import requirement', status: 'OPEN', baseInFavor: 9, baseOpposed: 0
    });
  }

  private async seedIntegrations(m: EntityManager) {
    await m.getRepository(Tender).insert(EFMIS_DATA.procurement.activeTenders.map((t: any) => ({
      tenderNo: t.tenderNo, description: t.description, stage: t.stage, deadline: t.deadline, budgetAllocatedEtb: t.budgetAllocatedETB, forexRequiredUsd: t.forexRequiredUSD,
      forexStatus: t.forexStatus, lcIssuingBank: t.lcIssuingBank, lcStatus: t.lcStatus, lowestBidder: t.lowestBidder, complianceStatus: t.complianceStatus
    })));
    await m.getRepository(Vessel).insert(EFMIS_DATA.procurement.vessels.map((v: any) => ({
      imo: v.imo, name: v.name, cargo: v.cargo, origin: v.origin, laycan: v.laycan, etaDjibouti: v.etaDjibouti, berthingStatus: v.berthingStatus,
      unloadingRateTpd: v.unloadingRateTPD, demurrageRisk: v.demurrageRisk, destinationDepots: v.destinationDepots
    })));
    await m.getRepository(QualityInspection).insert(EFMIS_DATA.qualityControl.inspections.map((q: any) => ({ sampleId: q.sampleId, data: q, verdict: q.verdict, inspectionDate: q.inspectionDate })));
    await m.getRepository(LogisticsBottleneck).insert(EFMIS_DATA.logistics.bottlenecks.map((b: any) => ({ location: b.location, delayHours: b.delayHours, cause: b.cause })));
    await m.getRepository(EcxPrice).insert(EFMIS_DATA.financials.ecxMarketPrices.map((p: any, i: number) => ({ commodity: p.commodity, priceEtbPerQtl: p.priceETBPerQtl, trend: p.trend, sort: i })));
    for (const a of EFMIS_DATA.criticalAlerts as any[]) {
      await m.getRepository(Alert).insert({
        id: a.id, severity: a.severity, title: a.title, category: a.category, triggerText: a.trigger, affectedArea: a.affectedArea,
        slaDeadline: new Date(Date.now() + a.slaHoursRemaining * 36e5), pmoNotificationStatus: a.pmoNotificationStatus, actionRequired: a.actionRequired,
        timestamp: a.timestamp, status: a.resolved ? 'RESOLVED' : 'OPEN', resolved: a.resolved,
        resolvedBy: a.resolved ? 'Ethio Telecom NOC' : null, resolvedAt: a.resolved ? parseStamp(a.timestamp) : null
      });
    }
  }

  /** WoredaZoneReview screen data: 7 kebele adjustments + 2 collaboration notes */
  private async seedReviews(m: EntityManager) {
    const day = nowStamp().slice(0, 10);
    const rows: Array<[string, number, number, string]> = [
      ['Wonji Gefersa', 1820, -5, 'Canal maintenance & high baseline soil P'],
      ['Dungugi Boro', 1450, 0, 'Aligned with 5-year historical average'],
      ['Boku Shenen', 1310, 8, 'New 400 Ha irrigated cluster expansion'],
      ['Koka Negewo', 1600, -5, 'Hydro-basin soil sensor saturation recalibration'],
      ['Sire Robi', 1150, 10, 'Second-cycle seed multiplication plot allocation'],
      ['Merti Jeju', 2100, -2, 'Drying cycle delayed by 2 weeks'],
      ['Tibe Haro', 1380, 0, 'Fully validated by Woreda agronomist']
    ];
    for (const [name, raw, pct, reason] of rows) {
      const k = await m.getRepository(Kebele).findOne({ where: { name } });
      await m.getRepository(DemandAdjustment).insert({
        level: 'WOREDA', unitType: 'KEBELE', unitId: k?.id ?? null, unitName: name, rawMt: raw, adjustedMt: Math.round(raw * (1 + pct / 100)), changePct: pct,
        justification: reason, userId: 'U-WOR-01', authorName: 'Adama Woreda Agronomist', createdAt: parseStamp(`${day} 14:20:00`)
      });
    }
    await m.getRepository(Comment).insert([
      { scopeType: 'ZONE', scopeId: 'ZONE-OR-ESHEWA', authorName: 'Adama Woreda Agronomist', userId: 'U-WOR-01', text: 'Wonji Gefersa adjusted by -5% due to irrigation canal schedule.', mentions: [], createdAt: parseStamp(`${day} 14:20:00`) },
      { scopeType: 'ZONE', scopeId: 'ZONE-OR-ESHEWA', authorName: 'East Shewa Zone Director', userId: 'U-ZON-01', text: 'Approved adjustment. NPSB confirmed with NSIS map.', mentions: [], createdAt: parseStamp(`${day} 16:10:00`) }
    ]);
  }

  /** Regional quota lines + East Shewa downward cascade (QuotaAllocation screen) */
  private async seedQuota(m: EntityManager) {
    const season = EFMIS_DATA.systemMetadata.currentSeason;
    for (const [i, r] of (EFMIS_DATA.regions as any[]).entries()) {
      const q = r.quotaAllocationMT, npsb = Math.round(q * RULES.productSplit.NPSB), urea = Math.round(q * RULES.productSplit.UREA);
      await m.getRepository(QuotaAllocation).insert({
        id: `QA-${r.code}-REGION`, level: 'REGION', regionId: r.id, unitId: r.id, recipientName: r.name, season, npsbMt: npsb, ureaMt: urea, otherMt: q - npsb - urea,
        allocationSource: 'National Import Programme', deliveryWindow: 'Aug 15 - Oct 30', status: 'Planned', approvalStatus: 'APPROVED', createdBy: 'Dr. Melesse Mekonnen', sort: i
      });
    }
    const cascade: Array<[string, string, string, string, string, string, number, number, string, string, string, number]> = [
      ['QA-OR-ESHEWA', 'ZONE', 'QA-OR-REGION', 'ZONE-OR-ESHEWA', 'East Shewa Zonal Bureau', 'የምስራቅ ሸዋ ዞን ግብርና ቢሮ', 18400, 12200, 'MV Abbay II (Lot 01)', 'Sep 01 - Sep 15', 'Zone Signed', 0],
      ['QA-OR-ADAMA', 'WOREDA', 'QA-OR-ESHEWA', 'WOR-OR-ADAMA', 'Adama Woreda Agriculture Office', 'የአዳማ ወረዳ ግብርና ጽ/ቤት', 4200, 2800, 'Mojo Central Hub', 'Sep 05 - Sep 20', 'Woreda Signed', 0],
      ['QA-OR-PC882', 'PC', 'QA-OR-ADAMA', 'PC-882', 'Wonji Primary Cooperative (PC-882)', 'የወንጂ መሠረታዊ ህብረት ሥራ (PC-882)', 980, 640, 'Adama Union Direct', 'Sep 15 - Sep 30', 'Scheduled Dispatch', 0.63],
      ['QA-OR-LUME', 'WOREDA', 'QA-OR-ESHEWA', 'WOR-OR-LUME', 'Lume Woreda Office (Mojo)', 'የሉሜ ወረዳ ግብርና ጽ/ቤት (ሞጆ)', 3800, 2400, 'Mojo Railway Dry Port', 'Sep 02 - Sep 18', 'Woreda Signed', 0],
      ['QA-OR-DUGDA', 'WOREDA', 'QA-OR-ESHEWA', 'WOR-OR-DUGDA', 'Dugda Woreda Agriculture (Meki)', 'የዱግዳ ወረዳ ግብርና (መቂ)', 3100, 2100, 'Adama Union Direct', 'Sep 10 - Sep 25', 'In Transit', 0],
      ['QA-OR-BORA', 'WOREDA', 'QA-OR-ESHEWA', 'WOR-OR-BORA', 'Bora Woreda Office', 'የቦራ ወረዳ ግብርና ጽ/ቤት', 2600, 1750, 'Mojo Central Hub', 'Sep 12 - Sep 28', 'Woreda Signed', 0],
      ['QA-OR-GIMBICHU', 'WOREDA', 'QA-OR-ESHEWA', 'WOR-OR-GIMBICHU', 'Gimbichu Woreda (Chefe)', 'የጊምቢቹ ወረዳ (ጨፌ)', 4500, 3000, 'Dire Dawa Corridor', 'Sep 05 - Sep 22', 'Scheduled Dispatch', 0]
    ];
    for (const [i, [id, level, parentId, unitId, name, nameAm, npsb, urea, source, window, status, deliveredPct]] of cascade.entries()) {
      await m.getRepository(QuotaAllocation).insert({
        id, level, parentId, regionId: 'REG-OROMIA', unitId, recipientName: name, recipientNameAm: nameAm, season, npsbMt: npsb, ureaMt: urea, otherMt: 0,
        allocationSource: source, deliveryWindow: window, status, receivedMt: Math.round((npsb + urea) * deliveredPct),
        approvalStatus: /Signed/.test(status) ? 'APPROVED' : 'PENDING', createdBy: 'Oromia BoA Bureau Head', sort: 100 + i
      });
    }
  }

  private async seedReports(m: EntityManager) {
    await m.getRepository(DailySummaryDate).insert(daily.DAILY_SUMMARY_DATES.map((d: any, i: number) => ({ id: d.id, label: d.label, sort: i })));
    for (const [dateId, records] of Object.entries<any[]>(daily.INITIAL_DAILY_SUMMARY_RECORDS)) {
      await m.getRepository(DailySummaryRecord).insert(records.map((r, i) => ({
        dateId, regionId: r.regionId, regionName: r.regionName, fertilizerType: r.fertilizerType, procuredMt: r.procuredMT, regionalStockMt: r.regionalStockMT,
        dispatchedMt: r.dispatchedMT, portCumulativeMt: r.portCumulativeMT, portDailyMt: r.portDailyMT, currentRegionStockMt: r.currentRegionStockMT,
        deliveredToRegionMt: r.deliveredToRegionMT, queueMt: r.queueMT, hubThisWeekMt: r.hubThisWeekMT, hubCumulativeMt: r.hubCumulativeMT, sort: i
      })));
    }
    await m.getRepository(ReportRegion).insert(daily.REGIONAL_REPORT_REGIONS.map((r: any, i: number) => ({ id: r.id, name: r.name, amharic: r.amharic, color: r.color, sort: i })));
    for (const [regionId, lots] of Object.entries<any[]>(daily.INITIAL_REGIONAL_VESSEL_LOTS)) {
      for (const [li, lot] of lots.entries()) {
        await m.getRepository(VesselLot).insert({ lotId: lot.lotId, regionId, vesselName: lot.vesselName, fertilizerType: lot.fertilizerType, status: lot.status, lotCode: lot.lotCode, dateColumns: lot.dateColumns, sort: li });
        for (const [ui, u] of (lot.unions as any[]).entries()) {
          const unionId = `${lot.lotId}:${u.id}`;
          await m.getRepository(LotUnion).insert({ id: unionId, lotId: lot.lotId, unionName: u.unionName, destination: u.destination, shareMt: u.shareMT, sort: ui });
          const loads = Object.entries<number>(u.dailyLoadedMT || {}).map(([date, mt]) => ({ unionId, date, mt }));
          if (loads.length) await m.getRepository(UnionDailyLoad).insert(loads);
        }
      }
    }
  }

  private async seedAuditHistory(m: EntityManager) {
    const roleUser: Record<string, string> = { MOA: 'U-MOA-01', ATI: 'U-ATI-01', FTWG: 'U-FTWG-01', DA: 'U-DA-01', ECAE: 'U-ECAE-01' };
    for (const a of [...EFMIS_DATA.auditTrail].reverse() as any[]) {
      await this.audit.record({ id: roleUser[a.role] || null, name: a.user, role: a.role }, a.action, a.target, null, { timestamp: a.timestamp, ip: a.ip, source: 'SEED' }, m);
    }
  }

  /** Final national demand document signed FTWG Chair -> ATI DG -> MoA State Minister (NationalValidation screen). */
  private async seedDemandDocument(m: EntityManager) {
    const meta = EFMIS_DATA.systemMetadata;
    const gross = meta.nationalTargetMT;
    const usable = EFMIS_DATA.carryOverStocks.totalUsableMT;
    const content = {
      title: `Formal National Fertilizer Demand Approval - ${meta.currentSeason}`,
      letterhead: 'Federal Democratic Republic of Ethiopia - Ministry of Agriculture',
      nationalDemand: { grossMT: gross, byFertilizer: { NPSB: Math.round(gross * 0.58), UREA: Math.round(gross * 0.38), OTHER: Math.round(gross * 0.04) } },
      regionalBreakdown: (EFMIS_DATA.regions as any[]).map(r => ({ id: r.id, name: r.name, demandMT: r.grossDemandMT, approvalStatus: r.approvalStatus })),
      netImportRequirement: { grossNationalDemandMT: gross, usableCarryOverMT: usable, netImportRequirementMT: gross - usable },
      supportingEvidence: ['NSIS soil overlay analysis', '5-year uptake trend analysis', 'FTWG consensus session minutes'],
      proclamation: meta.proclamationRef
    };
    const contentHash = 'sha256:' + sha256(content);
    await m.getRepository(DemandDocument).insert({ id: 'DOC-DEMAND-2026-FINAL', docNo: 'MOA/DEMAND/2026/0001', season: meta.currentSeason, version: 1, status: 'SIGNING', content: content as any, contentHash, createdBy: 'U-MOA-02' });
    const signers: Array<[string, string]> = [['U-FTWG-01', '2026-08-23 10:15'], ['U-ATI-01', '2026-08-23 14:30'], ['U-MOA-01', '2026-08-24 09:00']];
    for (const [i, step] of RULES.demandDocumentSigningOrder.entries()) {
      const [userId, at] = signers[i];
      const user = this.users.toAuthUser((await m.getRepository(User).findOneByOrFail({ id: userId })));
      const sig = await this.signatures.sign(user, { pin: DEMO_PIN }, 'DEMAND_DOCUMENT', 'DOC-DEMAND-2026-FINAL', { contentHash, step: step.step }, m, `${at}:00`);
      await m.getRepository(DocumentSignature).insert({ documentId: 'DOC-DEMAND-2026-FINAL', step: step.step, role: step.role, title: step.title, signerName: user.name, userId, status: 'SIGNED', signatureId: sig.id, signedAt: at });
      await this.audit.record(user, i === 2 ? 'DIGITAL_SIGNATURE_APPLIED' : 'DOC_CO_SIGNATURE', 'DOC-DEMAND-2026-FINAL', { step: step.step, signatureId: sig.id }, { timestamp: `${at}:00`, source: 'SEED' }, m);
    }
    await m.getRepository(DemandDocument).update({ id: 'DOC-DEMAND-2026-FINAL' }, { status: 'FINAL', finalizedAt: signers[2][1] });
  }
}
