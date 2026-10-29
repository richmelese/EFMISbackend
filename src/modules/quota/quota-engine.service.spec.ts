import { RULES } from '../../common/constants/rules';
import { QuotaEngineService, QuotaRegionInput } from './quota-engine.service';

const region = (id: string, historicalUptakeMt: number, soilNeedIndex = 1, creditArrearsEtb = 0): QuotaRegionInput => ({
  id, name: id, code: id, historicalUptakeMt, soilNeedIndex, creditArrearsEtb, quotaAllocationMt: 0
});

const quotaOf = (result: ReturnType<QuotaEngineService['compute']>, id: string) => result.regions.find(r => r.regionId === id)!.provisionalQuotaMT;

describe('QuotaEngineService (EFMIS-QA-1.0, REQ-1.4-001)', () => {
  const engine = new QuotaEngineService();
  const HIST_ONLY = { historical: 100, soilIndex: 0, arrearsPenalty: 0 };

  it('rejects weights that do not sum to 100%', () => {
    expect(() => engine.validateWeights({ historical: 60, soilIndex: 25, arrearsPenalty: 10 })).toThrow(/sum to 100%/);
    expect(() => engine.validateWeights(RULES.defaultQuotaWeights)).not.toThrow();
  });

  it('allocates exactly the national total, even when rounding does not divide evenly', () => {
    const regions = [region('A', 333), region('B', 333), region('C', 334)];
    const r = engine.compute(RULES.defaultQuotaWeights, 1_000_001, regions);
    expect(r.validation.sumOfQuotasMT).toBe(1_000_001);
    expect(r.validation.equalsNationalTotal).toBe(true);
  });

  it('with 100% historical weight, quotas are proportional to historical uptake', () => {
    const r = engine.compute(HIST_ONLY, 1_000_000, [region('A', 300_000), region('B', 200_000), region('C', 500_000)]);
    expect(quotaOf(r, 'A')).toBe(300_000);
    expect(quotaOf(r, 'B')).toBe(200_000);
    expect(quotaOf(r, 'C')).toBe(500_000);
  });

  it('gives more to the region with the higher soil-need index when uptake is equal', () => {
    const r = engine.compute({ historical: 0, soilIndex: 100, arrearsPenalty: 0 }, 1_000_000, [
      region('A', 400_000, 1.2), region('B', 400_000, 0.8), region('C', 200_000, 1)
    ]);
    expect(quotaOf(r, 'A')).toBeGreaterThan(quotaOf(r, 'B'));
  });

  it('reduces the share of a region with higher credit arrears per MT', () => {
    const regions = [region('A', 400_000, 1, 0), region('B', 400_000, 1, 80_000_000), region('C', 200_000, 1, 0)];
    const r = engine.compute({ historical: 0, soilIndex: 0, arrearsPenalty: 100 }, 1_000_000, regions);
    expect(quotaOf(r, 'B')).toBeLessThan(quotaOf(r, 'A'));
    expect(quotaOf(r, 'B')).toBeGreaterThan(0); // 10% of the share is always kept: no region is zeroed
  });

  it('applies the equity floor to a very small region and the efficiency ceiling to a dominant one', () => {
    const r = engine.compute(HIST_ONLY, 1_000_000, [region('BIG', 900_000), region('MID', 99_000), region('TINY', 1_000)]);
    const total = 1_000_000;
    const tiny = r.regions.find(x => x.regionId === 'TINY')!;
    const big = r.regions.find(x => x.regionId === 'BIG')!;
    expect(tiny.floorApplied).toBe('MIN');
    expect(tiny.provisionalQuotaMT).toBeGreaterThanOrEqual(Math.floor((RULES.minRegionSharePct / 100) * total));
    expect(big.floorApplied).toBe('MAX');
    expect(big.provisionalQuotaMT).toBeLessThanOrEqual(Math.ceil((RULES.maxRegionSharePct / 100) * total) + 1);
    expect(r.validation.sumOfQuotasMT).toBe(total);
  });

  it('flags missing historical data', () => {
    const r = engine.compute(RULES.defaultQuotaWeights, 1_000, [region('A', 0), region('B', 500), region('C', 500)]);
    expect(r.validation.dataAvailability).toBe('MISSING_HISTORICAL_DATA');
  });
});
