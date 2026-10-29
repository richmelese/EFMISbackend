import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, Repository } from 'typeorm';
import { RegionalSubmission } from './entities/regional-submission.entity';
import { Farmer } from '../farmers/entities/farmer.entity';
import { Region } from '../hierarchy/entities/region.entity';
import { Zone } from '../hierarchy/entities/zone.entity';
import { RULES } from '../../common/constants/rules';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { nowStamp, round, sha256, stamp } from '../../common/utils/helpers';
import { assertInScope, assertUnitVisible, isNational } from '../../common/utils/scope';
import { HierarchyService } from '../hierarchy/hierarchy.service';
import { AggregationService } from '../aggregation/aggregation.service';
import { ExternalService, NSIS_LAYERS } from '../external/external.service';
import { AuditService } from '../audit/audit.service';
import { SignaturesService } from '../signatures/signatures.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { SettingsService } from '../settings/settings.service';
import { SubmitRegionDto } from './dto/regional.dto';

type NsisProfile = NonNullable<Awaited<ReturnType<ExternalService['nsisProfile']>>>;

export interface DataQualityIssue {
  severity: 'BLOCKING' | 'WARNING';
  check: string;
  message: string;
}

/** Region hierarchy, NSIS soil analysis (REQ-1.2-005, REQ-1.3-002) and final regional approval / MoA submission (REQ-1.2-007). */
@Injectable()
export class RegionalService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(RegionalSubmission) private readonly submissions: Repository<RegionalSubmission>,
    @InjectRepository(Farmer) private readonly farmers: Repository<Farmer>,
    private readonly hierarchy: HierarchyService,
    private readonly aggregation: AggregationService,
    private readonly external: ExternalService,
    private readonly audit: AuditService,
    private readonly signatures: SignaturesService,
    private readonly notifications: NotificationsService,
    private readonly approvals: ApprovalsService,
    private readonly settings: SettingsService
  ) {}

  /** Reads: the region contains (or is inside) the user's unit. `act`: the region must be inside the user's unit. */
  private async regionRow(id: string, user: AuthUser, act = false): Promise<Region> {
    const r = await this.hierarchy.regions.findOne({ where: { id } });
    if (!r) throw Errors.notFound('Region');
    const unit = await this.hierarchy.unitRef('REGION', r.id);
    if (act) assertInScope(user, unit, 'region');
    else assertUnitVisible(user, unit, 'region');
    return r;
  }

  // ---------------- Hierarchy ----------------
  async list(user: AuthUser) {
    if (isNational(user)) return this.hierarchy.nestedRegions();
    if (!user.regionId) return [];
    return this.hierarchy.nestedRegions(user.regionId);
  }

  async get(id: string, user: AuthUser) {
    const r = await this.regionRow(id, user);
    const [nested] = await this.hierarchy.nestedRegions(r.id);
    return nested ?? this.hierarchy.regionToFrontend(r, []);
  }

  // ---------------- Soil analysis ----------------
  /** HaFAS-style recommendation from the NSIS profile */
  private recommendation(profile: NsisProfile, region: Region) {
    const d = profile.deficiencies;
    const fortify = d.B >= 30 ? 'Boron-fortified NPSB' : 'NPS';
    const acid = profile.acidity.acidicAreaPct >= 40;
    return {
      engine: 'HaFAS Agronomic Engine (rule-based v1)',
      confidence: profile.confidence,
      verifiedPct: profile.verifiedPct,
      prescription: `Allocate 70% ${fortify} and 30% Granular Urea.${d.P >= 70 ? ' Substitute straight DAP with Boron-fortified blends in high-P sorption vertisols.' : ''}${d.Zn >= 40 ? ' Add Zn-containing blends (NPSZn) where zinc deficiency exceeds 40%.' : ''}${acid ? ' Pair with agricultural lime on acidic soils (pH < 5.5).' : ''}`,
      recommendedRatesKgHa: profile.recommendedRatesKgHa,
      rationale: [`P deficiency ${d.P}% of sampled area`, `N deficiency ${d.N}%`, `B deficiency ${d.B}%`, `Acidic area ${profile.acidity.acidicAreaPct}% (avg pH ${profile.acidity.averagePh})`],
      soilDeficiencySummary: region.soilDeficiency
    };
  }

  async soil(id: string, layerQ: string | undefined, user: AuthUser) {
    const r = await this.regionRow(id, user);
    const profile = await this.external.nsisProfile(r.id);
    if (!profile) throw Errors.notFound('NSIS soil profile');
    const layer = String(layerQ || 'P_DEFICIENCY').toUpperCase();
    if (!NSIS_LAYERS[layer]) throw Errors.badRequest(`layer must be one of ${Object.keys(NSIS_LAYERS).join(', ')}`);
    const raw = await this.external.nsisRaw(r.id);
    const layerValue = raw ? raw[NSIS_LAYERS[layer]] : null;

    // Demand vs soil-need scientific validation (>30% discrepancy flagged)
    const farmers = r.registeredFarmers || 1;
    const demandPerFarmerQtl = (r.grossDemandMt * 10) / farmers;
    const soilNeedQtl = ((profile.recommendedRatesKgHa.NPSB + profile.recommendedRatesKgHa.UREA) / 100) * 1.1; // avg 1.1 ha holding
    const discrepancyPct = round(((demandPerFarmerQtl - soilNeedQtl) / soilNeedQtl) * 100, 1);
    const flagged = Math.abs(discrepancyPct) > RULES.anomalyThresholdPct;
    return {
      region: { id: r.id, name: r.name },
      layer, layerValue, layerUnit: layer === 'DROUGHT_RISK' ? '% rainfall anomaly' : '% of sampled area',
      profile,
      hafas: this.recommendation(profile, r),
      scientificValidation: {
        demandPerFarmerQtl: round(demandPerFarmerQtl, 2), soilBasedNeedPerFarmerQtl: round(soilNeedQtl, 2), discrepancyPct,
        flagged,
        suggestion: !flagged ? 'Demand is consistent with soil fertility needs'
          : discrepancyPct > 0 ? 'Demand may be over-estimated relative to soil needs - review hotspot woredas' : 'Demand may be under-estimated relative to soil needs - consider an increase',
        confidence: profile.confidence
      },
      disclaimer: profile.source === 'NSIS_CACHE' ? `Served from cached NSIS data (version ${profile.dataVersion}, updated ${profile.lastUpdated})` : undefined
    };
  }

  /** Historical trends and zone-level hotspot analysis */
  async analysis(id: string, user: AuthUser) {
    const r = await this.regionRow(id, user);
    const growth = [0.86, 0.9, 0.93, 0.96, 1];
    const years = [2022, 2023, 2024, 2025, 2026];
    const profile = await this.external.nsisProfile(r.id);
    const drill = await this.aggregation.drilldown('REGION', r.id);
    const zones: any[] = drill.children;
    return {
      region: { id: r.id, name: r.name },
      trend: years.map((y, i) => ({
        year: y,
        demandMT: Math.round(r.grossDemandMt * growth[i]),
        uptakeMT: i < 4 ? Math.round((r.historicalUptakeMt * growth[i]) / growth[3]) : null,
        repaymentRatePct: round(90 + i * 1.2, 1)
      })),
      hotspots: zones.map(z => ({
        zoneId: z.id, zone: z.name, demandMT: z.demandMT, pDeficiencyPct: profile?.deficiencies.P,
        concern: z.demandMT > 0 && profile && profile.deficiencies.P > 70 ? 'HIGH demand / LOW soil P' : 'NORMAL'
      })),
      riskAssessment: { drought: profile?.climate.droughtRisk, rainfallAnomalyPct: profile?.climate.rainfallAnomalyPct, priceShock: 'MODERATE' }
    };
  }

  // ---------------- Final regional approval & submission to MoA ----------------
  private async dataQuality(r: Region) {
    const drill = await this.aggregation.drilldown('REGION', r.id);
    const zoneSum = (drill.children as any[]).reduce((s, z) => s + (Number(z.demandMT) || 0), 0);
    const issues: DataQualityIssue[] = [];
    if (r.grossDemandMt <= 0) issues.push({ severity: 'BLOCKING', check: 'COMPLETENESS', message: 'Regional demand total is zero' });
    if (zoneSum > r.grossDemandMt) issues.push({ severity: 'BLOCKING', check: 'CONSISTENCY', message: 'Sum of zone demand exceeds regional total' });
    const notApproved = await this.hierarchy.zones.find({ where: { regionId: r.id, status: Not(In(['APPROVED', 'SUBMITTED'])) }, order: { sort: 'ASC' } });
    if (notApproved.length) issues.push({ severity: 'WARNING', check: 'COMPLETENESS', message: `${notApproved.length} zone(s) not yet approved: ${notApproved.map(z => z.name).join(', ')}` });
    const pendingFarmers = await this.farmers.count({ where: { regionId: r.id, deleted: false, approvalLevel: 'Pending Kebele Review' } });
    if (pendingFarmers) issues.push({ severity: 'WARNING', check: 'COMPLETENESS', message: `${pendingFarmers} farmer record(s) still pending kebele review (excluded from totals)` });
    return { passed: !issues.some(i => i.severity === 'BLOCKING'), checkedAt: nowStamp(), sumOfZonesMT: zoneSum, regionalTotalMT: r.grossDemandMt, issues };
  }

  async preSubmissionCheck(id: string, user: AuthUser) {
    return this.dataQuality(await this.regionRow(id, user));
  }

  private async approvalHistory(regionId: string) {
    const rows = await this.approvals.repository.createQueryBuilder('a')
      .where('a.entityId IN (SELECT z.id FROM zones z WHERE z.region_id = :rid)', { rid: regionId })
      .orderBy('a.id', 'ASC').getMany();
    return rows.map(a => ({ entity_type: a.entityType, entity_id: a.entityId, action: a.action, user_name: a.userName, created_at: stamp(a.createdAt) }));
  }

  async submit(id: string, dto: SubmitRegionDto, user: AuthUser, ctx: RequestContext) {
    const r0 = await this.regionRow(id, user, true);
    const dq = await this.dataQuality(r0);
    if (!dq.passed) throw Errors.unprocessable('Pre-submission validation failed', dq.issues);
    const season = (await this.settings.get<any>('systemMetadata', {}))?.currentSeason;
    const zones = (await this.hierarchy.nestedRegions(r0.id))[0]?.zones ?? [];
    const nsis = await this.external.nsisProfile(r0.id);
    const history = await this.approvalHistory(r0.id);

    const out = await this.ds.transaction(async m => {
      // Lock the region row so concurrent submissions get sequential version numbers
      const r = await m.getRepository(Region).findOne({ where: { id: r0.id }, lock: { mode: 'pessimistic_write' } });
      if (!r) throw Errors.notFound('Region');
      const subs = m.getRepository(RegionalSubmission);
      const version = (await subs.count({ where: { regionId: r.id } })) + 1;
      const payload = {
        metadata: { regionId: r.id, regionName: r.name, version, submittedAt: nowStamp(), submittedBy: user.name, season },
        summary: { grossDemandMT: r.grossDemandMt, byFertilizer: this.aggregation.byType(r.grossDemandMt), registeredFarmers: r.registeredFarmers },
        disaggregated: zones,
        supportingEvidence: { nsis },
        approvalHistory: history,
        finalComments: dto.finalComments || null
      };
      const signature = await this.signatures.sign(user, dto, 'REGIONAL_SUBMISSION', r.id, { payloadHash: sha256(payload), version }, m);
      const subId = `SUB-${r.code}-${String(version).padStart(3, '0')}`;
      const receipt = `RCPT-MOA-${r.code}-${nowStamp().slice(0, 10).replace(/-/g, '')}-${version}`;
      await subs.insert({
        id: subId, regionId: r.id, version, status: 'SUBMITTED', receiptNo: receipt, payload: payload as any, dataQuality: dq as any,
        finalComments: dto.finalComments || null, signatureId: signature.id, submittedBy: user.id
      });
      await m.getRepository(Region).update({ id: r.id }, { approvalStatus: 'Submitted to MoA' });
      await m.getRepository(Zone).update({ regionId: r.id, status: 'APPROVED' }, { status: 'SUBMITTED' });
      await m.getRepository(Farmer).update({ regionId: r.id, approvalLevel: 'Zone Approved' }, { approvalLevel: 'Region Approved' });
      await this.audit.record(user, 'REGIONAL_DEMAND_SUBMITTED_TO_MOA', r.id, { submissionId: subId, receipt, version, signatureId: signature.id }, ctx, m);
      await this.notifications.notify({
        role: 'MOA', title: `${r.name} regional demand submitted`, message: `Version ${version}, receipt ${receipt}`,
        link: `/regions/${r.id}/submissions/${subId}`, channels: ['IN_APP', 'EMAIL']
      }, m);
      await this.notifications.notify({ role: 'REGION', unitId: r.id, title: 'Submission confirmed', message: `MoA received ${r.name} demand (receipt ${receipt})` }, m);
      return { id: subId, version, receipt, signature, name: r.name };
    });

    return {
      id: out.id, regionId: r0.id, version: out.version, status: 'SUBMITTED', receiptNo: out.receipt, dataQuality: dq, signature: out.signature,
      message: `Regional demand payload for ${out.name} signed & transmitted to MoA!`
    };
  }

  async listSubmissions(id: string, full: boolean, user: AuthUser) {
    const r = await this.regionRow(id, user);
    const rows = await this.submissions.find({ where: { regionId: r.id }, order: { version: 'DESC' } });
    return rows.map(s => ({
      id: s.id, version: s.version, status: s.status, receiptNo: s.receiptNo, createdAt: stamp(s.createdAt), acknowledgedAt: stamp(s.acknowledgedAt),
      finalComments: s.finalComments, dataQuality: s.dataQuality, summary: s.payload?.summary,
      ...(full ? { payload: s.payload } : {})
    }));
  }

  /** Compare two submission versions (changes highlighted) */
  async compareSubmissions(id: string, from: number, to: number, user: AuthUser) {
    const r = await this.regionRow(id, user);
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw Errors.notFound('Submission version');
    const a = await this.submissions.findOne({ where: { regionId: r.id, version: from } });
    const b = await this.submissions.findOne({ where: { regionId: r.id, version: to } });
    if (!a || !b) throw Errors.notFound('Submission version');
    const sa = a.payload.summary, sb = b.payload.summary;
    const changes: Array<{ field: string; from: number; to: number; delta: number }> = Object.keys(sb.byFertilizer).map(k => ({
      field: `byFertilizer.${k}`, from: sa.byFertilizer[k], to: sb.byFertilizer[k], delta: sb.byFertilizer[k] - sa.byFertilizer[k]
    }));
    changes.push({ field: 'grossDemandMT', from: sa.grossDemandMT, to: sb.grossDemandMT, delta: sb.grossDemandMT - sa.grossDemandMT });
    return { from: a.version, to: b.version, changes };
  }

  async acknowledge(id: string, sid: string, user: AuthUser, ctx: RequestContext) {
    const s = await this.submissions.findOne({ where: { id: sid, regionId: id } });
    if (!s) throw Errors.notFound('Submission');
    await this.ds.transaction(async m => {
      await m.getRepository(RegionalSubmission).update({ id: s.id }, { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() });
      await this.audit.record(user, 'REGIONAL_SUBMISSION_ACKNOWLEDGED', s.id, null, ctx, m);
      await this.notifications.notify({ role: 'REGION', unitId: s.regionId, title: 'MoA acknowledged your submission', message: `Receipt ${s.receiptNo} acknowledged` }, m);
    });
    return { id: s.id, status: 'ACKNOWLEDGED' };
  }
}
