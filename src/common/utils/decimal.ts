import { ColumnOptions, ValueTransformer } from 'typeorm';

/**
 * Exact numbers (architecture rule 6): quantities and money are PostgreSQL `numeric`, never `double precision`, so
 * totals never drift. Values are rounded to the column scale on write and returned as JS numbers.
 * Note: raw SQL aggregates over these columns come back as strings — wrap them in Number().
 *
 *   @Column(QTY())                     metric tonnes, numeric(14,3) — to the kilogram
 *   @Column(NUMERIC(12, 2))            quintals, hectares, …
 *   @Column(MONEY({ nullable: true })) Ethiopian birr, numeric(16,2)
 */
export const QTY_SCALE = 3;

/** Round to `scale` decimals (same rule as the stock ledger has always used: Math.round on the scaled value). */
export function roundTo(n: unknown, scale: number): number {
  const f = 10 ** scale;
  return Math.round((Number(n) || 0) * f) / f;
}

export const round3 = (n: unknown): number => roundTo(n, 3);

/** Transformer for a numeric column with `scale` decimals. */
export function numericTransformer(scale: number): ValueTransformer {
  return {
    to: (v: number | null | undefined) => (v === null || v === undefined ? v : roundTo(v, scale)),
    from: (v: string | number | null) => (v === null || v === undefined ? null : Number(v))
  };
}

export const decimalTransformer: ValueTransformer = numericTransformer(QTY_SCALE);

/** Column options for an exact `numeric(precision, scale)` value read and written as a JS number. */
export const NUMERIC = (precision: number, scale: number, opts: Partial<ColumnOptions> = {}): ColumnOptions => ({
  type: 'numeric', precision, scale, transformer: numericTransformer(scale), ...opts
});

/** Column options for a ledger quantity (MT). */
export const QTY = (opts: Partial<ColumnOptions> = {}): ColumnOptions => NUMERIC(14, QTY_SCALE, opts);

/** Column options for an amount of money (ETB). */
export const MONEY = (opts: Partial<ColumnOptions> = {}): ColumnOptions => NUMERIC(16, 2, opts);
