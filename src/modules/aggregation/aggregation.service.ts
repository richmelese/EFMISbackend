import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Region } from '../admin-units/entities/region.entity';
import { Zone } from '../admin-units/entities/zone.entity';
import { Woreda } from '../admin-units/entities/woreda.entity';
import { Kebele } from '../admin-units/entities/kebele.entity';
import { Farmer } from '../farmers/entities/farmer.entity';
import { FarmerDemand } from '../farmers/entities/farmer-demand.entity';
import { RULES } from '../../common/constants/rules';
import { Errors } from '../../common/utils/errors';
import { round } from '../../common/utils/helpers';
import { SettingsService } from '../settings/settings.service';

export type DrillLevel = 'NATIONAL' | 'REGION' | 'ZONE' | 'WOREDA' | 'KEBELE';

export interface ProductSplit {
  NPSB: number;
  UREA: number;
  OTHER: number;
}

/**
 * Hierarchical aggregation Kebele -> Woreda -> Zone -> Region -> National (REQ-1.2-001/002, REQ-1.3-001, REQ-INT-006).
 * Kebele-and-above totals are the approved demand rolled up into each unit; the farmer level comes from approved
 * farmer demand lines. Pending/rejected records are excluded from official totals.
 */
@Injectable()
export class AggregationService {
  constructor(
    @InjectRepository(Region) private readonly regions: Repository<Region>,
    @InjectRepository(Zone) private readonly zones: Repository<Zone>,
    @InjectRepository(Woreda) private readonly woredas: Repository<Woreda>,
    @InjectRepository(Kebele) private readonly kebeles: Repository<Kebele>,
    @InjectRepository(Farmer) private readonly farmers: Repository<Farmer>,
    @InjectRepository(FarmerDemand) private readonly demands: Repository<FarmerDemand>,
    private readonly settings: SettingsService
  ) {}

  /** Split a total into the NPSB / Urea / other basket used across the UI (58% / 38% / 4%). */
  byType(mt: number): ProductSplit {
    const s = RULES.productSplit;
    return { NPSB: Math.round(mt * s.NPSB), UREA: Math.round(mt * s.UREA), OTHER: Math.round(mt * s.OTHER) };
  }

  private async kebeleSum(where: { zoneId?: string; woredaId?: string }) {
    const qb = this.kebeles.createQueryBuilder('k').innerJoin('k.woreda', 'w')
      .select('COALESCE(SUM(k.demandMt),0)', 'demand').addSelect('COALESCE(SUM(k.farmers),0)', 'farmers').addSelect('COUNT(*)', 'kebeles');
    if (where.zoneId) qb.where('w.zoneId = :z', { z: where.zoneId });
    if (where.woredaId) qb.where('w.id = :w', { w: where.woredaId });
    const r = await qb.getRawOne();
    return { demand: Number(r.demand), farmers: Number(r.farmers), kebeles: Number(r.kebeles) };
  }

  /** Approved farmer-level demand by fertilizer (quintals -> MT) within a unit */
  async approvedFarmerDemand(column: 'woredaId' | 'kebeleId' | 'regionId' | null, id?: string) {
    const qb = this.demands.createQueryBuilder('d').innerJoin('d.farmer', 'f').where('f.deleted = false')
      .select('d.type', 'type').addSelect('SUM(COALESCE(d.approvedQtl,0))', 'approved').addSelect('SUM(d.requestedQtl)', 'requested').groupBy('d.type');
    if (column) qb.andWhere(`f.${column} = :id`, { id });
    const rows = await qb.getRawMany();
    return rows.map(r => ({ type: r.type, approvedMT: round(Number(r.approved) / 10, 2), requestedMT: round(Number(r.requested) / 10, 2) }));
  }

  async breadcrumb(level: DrillLevel, id: string | null) {
    const out: Array<{ level: DrillLevel; id: string | null; name: string }> = [{ level: 'NATIONAL', id: null, name: 'National (Ethiopia)' }];
    let k: Kebele | null = null, w: Woreda | null = null, z: Zone | null = null, r: Region | null = null;
    let cur: string | null = id;
    if (level === 'KEBELE') { k = await this.kebeles.findOneBy({ id: cur! }); cur = k?.woredaId ?? null; level = 'WOREDA'; }
    if (level === 'WOREDA') { w = await this.woredas.findOneBy({ id: cur! }); cur = w?.zoneId ?? null; level = 'ZONE'; }
    if (level === 'ZONE') { z = await this.zones.findOneBy({ id: cur! }); cur = z?.regionId ?? null; level = 'REGION'; }
    if (level === 'REGION') r = await this.regions.findOneBy({ id: cur! });
    if (r) out.push({ level: 'REGION', id: r.id, name: r.name });
    if (z) out.push({ level: 'ZONE', id: z.id, name: z.name });
    if (w) out.push({ level: 'WOREDA', id: w.id, name: w.name });
    if (k) out.push({ level: 'KEBELE', id: k.id, name: k.name });
    return out;
  }

  /** Drill-down: { level, unit, breadcrumb, totals, byFertilizer, children[] } — children are the next level down. */
  async drilldown(levelIn: string = 'NATIONAL', id: string | null = null): Promise<any> {
    const level = levelIn.toUpperCase() as DrillLevel;
    const S = RULES.productSplit;
    if (level === 'NATIONAL') {
      const regs = await this.regions.find({ order: { sort: 'ASC' } });
      const gross = regs.reduce((s, r) => s + r.grossDemandMt, 0);
      return {
        level, unit: { id: 'ETH', name: 'National (Ethiopia)' }, breadcrumb: await this.breadcrumb('NATIONAL', null),
        totals: { demandMT: gross, quotaMT: regs.reduce((s, r) => s + r.quotaAllocationMt, 0), registeredFarmers: regs.reduce((s, r) => s + r.registeredFarmers, 0) },
        byFertilizer: this.byType(gross),
        children: regs.map(r => ({
          level: 'REGION', id: r.id, name: r.name, sharePercent: r.sharePercent, demandMT: r.grossDemandMt,
          npsbMT: Math.round(r.grossDemandMt * S.NPSB), ureaMT: Math.round(r.grossDemandMt * S.UREA),
          quotaMT: r.quotaAllocationMt, registeredFarmers: r.registeredFarmers, approvalStatus: r.approvalStatus
        }))
      };
    }
    if (!id) throw Errors.badRequest('id is required below NATIONAL level');
    if (level === 'REGION') {
      const r = await this.regions.findOneBy({ id });
      if (!r) throw Errors.notFound('Region');
      const zones = await this.zones.find({ where: { regionId: id }, order: { sort: 'ASC' } });
      const children: any[] = [];
      for (const z of zones) {
        const s = await this.kebeleSum({ zoneId: z.id });
        children.push({ level: 'ZONE', id: z.id, name: z.name, woredas: await this.woredas.countBy({ zoneId: z.id }), demandMT: s.demand, farmers: s.farmers, status: z.status, byFertilizer: this.byType(s.demand) });
      }
      return {
        level, unit: { id: r.id, name: r.name }, breadcrumb: await this.breadcrumb('REGION', id),
        totals: { demandMT: r.grossDemandMt, quotaMT: r.quotaAllocationMt, registeredFarmers: r.registeredFarmers, approvalStatus: r.approvalStatus },
        byFertilizer: this.byType(r.grossDemandMt), children
      };
    }
    if (level === 'ZONE') {
      const z = await this.zones.findOneBy({ id });
      if (!z) throw Errors.notFound('Zone');
      const s = await this.kebeleSum({ zoneId: id });
      const children: any[] = [];
      for (const w of await this.woredas.find({ where: { zoneId: id }, order: { sort: 'ASC' } })) {
        const ws = await this.kebeleSum({ woredaId: w.id });
        children.push({ level: 'WOREDA', id: w.id, name: w.name, kebeles: ws.kebeles, demandMT: ws.demand, farmers: ws.farmers, status: w.status, byFertilizer: this.byType(ws.demand) });
      }
      return {
        level, unit: { id: z.id, name: z.name, status: z.status }, breadcrumb: await this.breadcrumb('ZONE', id),
        totals: { demandMT: s.demand, registeredFarmers: s.farmers, kebeles: s.kebeles }, byFertilizer: this.byType(s.demand), children
      };
    }
    if (level === 'WOREDA') {
      const w = await this.woredas.findOneBy({ id });
      if (!w) throw Errors.notFound('Woreda');
      const s = await this.kebeleSum({ woredaId: id });
      const children: any[] = [];
      for (const k of await this.kebeles.find({ where: { woredaId: id }, order: { sort: 'ASC' } })) {
        const pending = await this.farmers.countBy({ kebeleId: k.id, deleted: false, approvalLevel: 'Pending Kebele Review' });
        children.push({ level: 'KEBELE', id: k.id, name: k.name, da: k.daName, farmers: k.farmers, demandMT: k.demandMt, status: k.status, byFertilizer: this.byType(k.demandMt), pendingApprovals: pending });
      }
      return {
        level, unit: { id: w.id, name: w.name, status: w.status }, breadcrumb: await this.breadcrumb('WOREDA', id),
        totals: { demandMT: s.demand, registeredFarmers: s.farmers, kebeles: s.kebeles }, byFertilizer: this.byType(s.demand),
        approvedFarmerDemand: await this.approvedFarmerDemand('woredaId', id), children
      };
    }
    if (level === 'KEBELE') {
      const k = await this.kebeles.findOneBy({ id });
      if (!k) throw Errors.notFound('Kebele');
      const farmers = await this.farmers.find({ where: { kebeleId: id, deleted: false }, relations: { demands: true }, order: { id: 'ASC' } });
      return {
        level, unit: { id: k.id, name: k.name, da: k.daName, status: k.status }, breadcrumb: await this.breadcrumb('KEBELE', id),
        totals: { demandMT: k.demandMt, registeredFarmers: k.farmers, recordsInSystem: farmers.length },
        byFertilizer: this.byType(k.demandMt),
        approvedFarmerDemand: await this.approvedFarmerDemand('kebeleId', id),
        children: farmers.map(f => ({
          level: 'FARMER', id: f.id, name: f.name, farmSizeHa: f.farmSizeHa, approvalLevel: f.approvalLevel,
          demands: f.demands.map(d => ({ type: d.type, requestedQtl: d.requestedQtl, approvedQtl: d.approvedQtl, status: d.status })),
          approvedMT: round(f.demands.reduce((s, d) => s + (d.approvedQtl || 0), 0) / 10, 2)
        }))
      };
    }
    throw Errors.badRequest('level must be NATIONAL, REGION, ZONE, WOREDA or KEBELE');
  }

  /** Gross national demand with reconciliation against the sum of regional approvals (REQ-1.3-001). */
  async nationalSummary() {
    const meta = await this.settings.get<any>('systemMetadata', {});
    const regs = await this.regions.find({ order: { sort: 'ASC' } });
    const sumRegions = regs.reduce((s, r) => s + r.grossDemandMt, 0);
    const gross: number = meta.nationalTargetMT || sumRegions;
    const diffPct = gross ? round((Math.abs(gross - sumRegions) / gross) * 100, 2) : 0;
    const within = diffPct <= RULES.reconciliationTolerancePct;
    return {
      season: meta.currentSeason as string,
      grossNationalDemandMT: gross,
      sumOfRegionalApprovalsMT: sumRegions,
      reconciliation: {
        differencePct: diffPct, tolerancePct: RULES.reconciliationTolerancePct, withinTolerance: within,
        note: within ? 'Sum of regional approvals reconciles with national total'
          : 'National target differs from the sum of regional approvals by more than the tolerance; review weighted estimates for regions with partial data'
      },
      byFertilizer: this.byType(gross),
      bySeason: { Meher: Math.round(gross * 0.82), Belg: Math.round(gross * 0.11), Irrigation: Math.round(gross * 0.07) },
      regions: regs.map(r => ({ id: r.id, name: r.name, demandMT: r.grossDemandMt, sharePercent: gross ? round((r.grossDemandMt / gross) * 100, 1) : 0, approvalStatus: r.approvalStatus })),
      regionsWithPartialData: regs.filter(r => !['Submitted to MoA', 'Approved by BoA'].includes(r.approvalStatus)).map(r => ({ id: r.id, name: r.name, approvalStatus: r.approvalStatus })),
      excludedRecords: 'Pending and rejected farmer records are excluded from official totals'
    };
  }
}
