import { ColumnOptions, ValueTransformer } from 'typeorm';

/**
 * Exact quantities for the stock ledger. PostgreSQL `numeric(14,3)` (to the kilogram for metric tonnes) instead of
 * floating point, so balances never drift; values are rounded to 3 decimals on write and returned as JS numbers.
 * Note: raw SQL aggregates over these columns come back as strings — wrap them in Number().
 */
export const QTY_SCALE = 3;

export const round3 = (n: unknown): number => Math.round((Number(n) || 0) * 1000) / 1000;

export const decimalTransformer: ValueTransformer = {
  to: (v: number | null | undefined) => (v === null || v === undefined ? v : round3(v)),
  from: (v: string | number | null) => (v === null || v === undefined ? null : Number(v))
};

/** Column options for a ledger quantity (MT). */
export const QTY = (opts: Partial<ColumnOptions> = {}): ColumnOptions => ({
  type: 'numeric', precision: 14, scale: QTY_SCALE, transformer: decimalTransformer, ...opts
});
