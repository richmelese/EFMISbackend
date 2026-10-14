import { Injectable } from '@nestjs/common';
import { RULES } from '../../common/constants/rules';
import { Errors } from '../../common/utils/errors';
import { round } from '../../common/utils/helpers';

export const ALGORITHM_VERSION = 'EFMIS-QA-1.0';

export interface QuotaWeights {
  historical: number;
  soilIndex: number;
  arrearsPenalty: number;
}

/** Factor inputs of one region (Region entity subset). */
export interface QuotaRegionInput {
  id: string;
  name: string;
  code: string;
  historicalUptakeMt: number;
  soilNeedIndex: number;
  creditArrearsEtb: number;
  quotaAllocationMt: number;
}

/**
 * Provisional quota engine "EFMIS-QA-1.0" (documented & transparent, REQ-1.4-001). Pure computation, no I/O.
 *   H_i  historical share         = hist_i / Σ hist
 *   S_i  soil-need share          = hist_i·soil_i / Σ hist·soil          (NSIS deficiency index scales need)
 *   R_i  repayment-adjusted share = hist_i·(1 − 0.9·a_i) / Σ hist·(1 − 0.9·a)   a_i = arrears intensity (ETB/MT) / max intensity
 *   share_i = (w_hist·H_i + w_soil·S_i + w_arrears·R_i) / 100           Σw = 100
 *   quota_i = share_i · NationalTotal, then equity floor / ceiling (min/max % of national), renormalisation and rounding
 *   reconciliation so Σ quota = total exactly.
 */
@Injectable()
export class QuotaEngineService {
  readonly algorithmVersion = ALGORITHM_VERSION;

  validateWeights(w: Partial<QuotaWeights>): void {
    const sum = (w.historical || 0) + (w.soilIndex || 0) + (w.arrearsPenalty || 0);
    if (Math.abs(sum - 100) > 0.01) throw Errors.unprocessable(`Weights must sum to 100% (got ${sum}%)`);
  }

  compute(weights: QuotaWeights, nationalTotalMT: number, regions: QuotaRegionInput[]) {
    this.validateWeights(weights);
    const split = RULES.productSplit;
    const total = nationalTotalMT;
    const sumHist = regions.reduce((s, r) => s + r.historicalUptakeMt, 0);
    const sumSoil = regions.reduce((s, r) => s + r.historicalUptakeMt * r.soilNeedIndex, 0);
    const intensity = regions.map(r => (r.historicalUptakeMt ? r.creditArrearsEtb / r.historicalUptakeMt : 0));
    const maxInt = Math.max(...intensity, 1);
    const repay = regions.map((r, i) => r.historicalUptakeMt * (1 - (intensity[i] / maxInt) * 0.9)); // keep 10% so no region is zeroed
    const sumRepay = repay.reduce((s, v) => s + v, 0);

    const work = regions.map((r, i) => {
      const H = r.historicalUptakeMt / sumHist;
      const S = (r.historicalUptakeMt * r.soilNeedIndex) / sumSoil;
      const R = repay[i] / sumRepay;
      const share = (weights.historical * H + weights.soilIndex * S + weights.arrearsPenalty * R) / 100;
      return {
        regionId: r.id, regionName: r.name, code: r.code,
        inputs: { historicalUptakeMT: r.historicalUptakeMt, soilNeedIndex: r.soilNeedIndex, creditArrearsETB: r.creditArrearsEtb, arrearsIntensityETBperMT: round(intensity[i], 1) },
        factorShares: { historical: round(H * 100, 3), soilNeed: round(S * 100, 3), repaymentAdjusted: round(R * 100, 3) },
        contributionsMT: {
          historical: Math.round((total * weights.historical * H) / 100),
          soilIndex: Math.round((total * weights.soilIndex * S) / 100),
          arrearsAdjusted: Math.round((total * weights.arrearsPenalty * R) / 100)
        },
        share, currentQuotaMT: r.quotaAllocationMt, floorApplied: null as 'MIN' | 'MAX' | null
      };
    });

    // Equity floor / efficiency ceiling, then renormalise the unconstrained rows (iterate until stable)
    const minShare = RULES.minRegionSharePct / 100, maxShare = RULES.maxRegionSharePct / 100;
    for (let iter = 0; iter < 10; iter++) {
      let fixed = 0, freeSum = 0;
      for (const r of work) {
        if (r.share < minShare) { r.share = minShare; r.floorApplied = 'MIN'; }
        if (r.share > maxShare) { r.share = maxShare; r.floorApplied = 'MAX'; }
        if (r.floorApplied) fixed += r.share; else freeSum += r.share;
      }
      const scale = freeSum ? (1 - fixed) / freeSum : 1;
      if (Math.abs(scale - 1) < 1e-9) break;
      for (const r of work) if (!r.floorApplied) r.share *= scale;
    }

    const rows = work.map(({ share, ...r }) => {
      const quota = Math.round(share * total);
      return {
        ...r,
        sharePercent: round(share * 100, 2),
        provisionalQuotaMT: quota,
        npsbMT: Math.round(quota * split.NPSB),
        ureaMT: Math.round(quota * split.UREA),
        changeVsCurrentMT: quota - r.currentQuotaMT
      };
    });
    // Reconcile rounding so Σ quota == total exactly (difference goes to the largest line)
    const diff = total - rows.reduce((s, r) => s + r.provisionalQuotaMT, 0);
    if (diff !== 0 && rows.length) [...rows].sort((a, b) => b.provisionalQuotaMT - a.provisionalQuotaMT)[0].provisionalQuotaMT += diff;
    const sum = rows.reduce((s, r) => s + r.provisionalQuotaMT, 0);

    return {
      algorithmVersion: ALGORITHM_VERSION,
      formula: `share_i = (w_hist·H_i + w_soil·S_i + w_arrears·R_i)/100 ; quota_i = share_i × NationalTotal (equity floor ${RULES.minRegionSharePct}%, ceiling ${RULES.maxRegionSharePct}%)`,
      weights, nationalTotalMT: total,
      validation: {
        sumOfQuotasMT: sum,
        equalsNationalTotal: sum === total,
        minThresholdPct: RULES.minRegionSharePct, maxThresholdPct: RULES.maxRegionSharePct,
        dataAvailability: regions.every(r => r.historicalUptakeMt > 0) ? 'ALL_FACTORS_AVAILABLE' : 'MISSING_HISTORICAL_DATA'
      },
      regions: rows
    };
  }
}
