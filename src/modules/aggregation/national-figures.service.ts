import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { CarryOverFacility, CarryOverStock } from '../national/entities/carry-over.entities';
import { AuthUser } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { round, stamp } from '../../common/utils/helpers';
import { AggregationService } from './aggregation.service';

export interface CarryOverUpdate {
  stockMT?: number;
  usableMT?: number;
  expiredMT?: number;
  qcStatus?: string;
  justification?: string;
}

/**
 * Carry-over stock and net import requirement (REQ-1.3-004):
 *   Net Import Requirement = Gross National Demand – Usable Carry-Over Stock
 * Usable = not expired and QC-passed; damaged/substandard stock is excluded.
 */
@Injectable()
export class NationalFiguresService {
  constructor(
    @InjectRepository(CarryOverFacility) private readonly facilities: Repository<CarryOverFacility>,
    @InjectRepository(CarryOverStock) private readonly stocks: Repository<CarryOverStock>,
    private readonly aggregation: AggregationService
  ) {}

  /** EFMIS_DATA.carryOverStocks shape */
  async carryOver() {
    const facilities = await this.facilities.find({ order: { sort: 'ASC' } });
    const fert = await this.stocks.find({ order: { sort: 'ASC' } });
    return {
      totalUsableMT: fert.reduce((s, f) => s + f.usableMt, 0),
      totalExpiredSubstandardMT: fert.reduce((s, f) => s + f.expiredMt, 0),
      byFacilityType: facilities.map(f => ({ id: f.id, facility: f.facility, usableMT: f.usableMt, unverifiedMT: f.unverifiedMt, qcPassPercent: f.qcPassPercent })),
      byFertilizer: fert.map(f => ({ type: f.type, stockMT: f.stockMt, usableMT: f.usableMt, expiredMT: f.expiredMt, qcStatus: f.qcStatus, updatedAt: stamp(f.updatedAt) }))
    };
  }

  async netImport() {
    const summary = await this.aggregation.nationalSummary();
    const co = await this.carryOver();
    const gross = summary.grossNationalDemandMT;
    const usable = Object.fromEntries(co.byFertilizer.map(f => [f.type, f.usableMT])) as Record<string, number>;
    // Stock types mapped onto the demand basket used in the UI (NPS/NPSB -> NPSB, UREA, others)
    const usableNpsb = (usable.NPSB || 0) + (usable.NPS || 0);
    const usableUrea = usable.UREA || 0;
    const usableOther = co.totalUsableMT - usableNpsb - usableUrea;
    const net = Math.max(gross - co.totalUsableMT, 0);
    const g = summary.byFertilizer;
    return {
      season: summary.season,
      formula: 'Net Import Requirement = Gross National Demand - Usable Carry-Over Stock',
      grossNationalDemandMT: gross,
      usableCarryOverMT: co.totalUsableMT,
      excludedExpiredSubstandardMT: co.totalExpiredSubstandardMT,
      netImportRequirementMT: net,
      byFertilizer: {
        NPSB: { grossMT: g.NPSB, usableCarryOverMT: usableNpsb, netImportMT: Math.max(g.NPSB - usableNpsb, 0) },
        UREA: { grossMT: g.UREA, usableCarryOverMT: usableUrea, netImportMT: Math.max(g.UREA - usableUrea, 0) },
        OTHER: { grossMT: g.OTHER, usableCarryOverMT: usableOther, netImportMT: Math.max(g.OTHER - usableOther, 0) }
      },
      suggestedProcurementSchedule: [
        { window: 'Month 1 (urgent, Meher top-dressing)', sharePct: 40, mt: Math.round(net * 0.4) },
        { window: 'Month 2', sharePct: 35, mt: Math.round(net * 0.35) },
        { window: 'Month 3', sharePct: 25, mt: Math.round(net * 0.25) }
      ],
      reconciliation: summary.reconciliation
    };
  }

  /** Adjust a carry-over line. >10% change of usable stock requires justification. Returns before/after for auditing. */
  async updateCarryOver(user: AuthUser, type: string, changes: CarryOverUpdate, manager?: EntityManager) {
    const repo = manager ? manager.getRepository(CarryOverStock) : this.stocks;
    const before = await repo.findOneBy({ type });
    if (!before) throw Errors.notFound('Carry-over fertilizer line');
    const next = {
      stockMt: changes.stockMT ?? before.stockMt, usableMt: changes.usableMT ?? before.usableMt,
      expiredMt: changes.expiredMT ?? before.expiredMt, qcStatus: changes.qcStatus ?? before.qcStatus
    };
    if (next.usableMt + next.expiredMt > next.stockMt + 0.001) throw Errors.unprocessable('usableMT + expiredMT cannot exceed stockMT');
    const changePct = before.usableMt ? (Math.abs(next.usableMt - before.usableMt) / before.usableMt) * 100 : 100;
    if (changePct > 10 && !changes.justification) throw Errors.unprocessable('Justification is required for significant carry-over adjustments (>10%)');
    await repo.update({ type }, { ...next, updatedBy: user.name });
    return { before: { stockMT: before.stockMt, usableMT: before.usableMt, expiredMT: before.expiredMt, qcStatus: before.qcStatus }, after: { stockMT: next.stockMt, usableMT: next.usableMt, expiredMT: next.expiredMt, qcStatus: next.qcStatus }, changePct: round(changePct, 1) };
  }
}
