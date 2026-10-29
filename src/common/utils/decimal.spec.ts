import { MONEY, NUMERIC, QTY, numericTransformer, round3 } from './decimal';

describe('exact numeric columns', () => {
  it('rounds to the column scale on write and returns JS numbers on read', () => {
    const t = numericTransformer(2);
    expect(t.to(12.345678)).toBe(12.35);
    expect(t.from('1234.50')).toBe(1234.5);
    expect(t.to(null)).toBeNull();
    expect(t.from(null)).toBeNull();
  });

  it('keeps the stock-ledger rounding rule for quantities', () => {
    expect(round3(1.23456)).toBe(1.235);
    expect(round3('2.0004')).toBe(2);
  });

  it('builds numeric column options', () => {
    expect(QTY()).toMatchObject({ type: 'numeric', precision: 14, scale: 3 });
    expect(MONEY({ nullable: true })).toMatchObject({ type: 'numeric', precision: 16, scale: 2, nullable: true });
    expect(NUMERIC(10, 2).transformer).toBeDefined();
  });
});
