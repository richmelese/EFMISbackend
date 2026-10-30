/** One bucket per kind of file (MINIO_STORAGE_PLAN.md §2.1). Names come from configuration. */
export const STORAGE_BUCKETS = ['FARMER_DOCUMENTS', 'DRIVER_DOCUMENTS', 'DELIVERY_PROOFS'] as const;
export type StorageBucket = (typeof STORAGE_BUCKETS)[number];

export interface StoredObject {
  bucket: StorageBucket;
  key: string;
  /** Version created by the upload (buckets are versioned): rollback and retention target exactly this version */
  versionId: string | null;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
}

/** A key segment is an id or a generated file name — never user input with slashes or dots that climb up. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Object key from generated parts, e.g. objectKey('FARM-2026-00012', 'DOC-AB12.jpg') → "FARM-2026-00012/DOC-AB12.jpg".
 * Throws on anything that could escape its folder ("..", "/", empty parts).
 */
export function objectKey(...parts: string[]): string {
  if (!parts.length) throw new Error('objectKey needs at least one part');
  for (const p of parts) {
    if (!SEGMENT.test(p) || p.includes('..')) throw new Error(`Invalid object key segment "${p}"`);
  }
  return parts.join('/');
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

/**
 * How long an object is kept write-once (GOVERNANCE mode, MINIO_STORAGE_PLAN.md §2.5):
 * farmer documents and delivery proofs 7 years; driver documents until their expiry + 2 years (7 years if no expiry).
 */
export function retentionUntil(bucket: StorageBucket, from: Date, documentExpiresAt?: string | Date | null): Date {
  if (bucket === 'DRIVER_DOCUMENTS' && documentExpiresAt) {
    const exp = new Date(documentExpiresAt);
    if (!Number.isNaN(exp.getTime())) return new Date(Math.max(exp.getTime(), from.getTime()) + 2 * YEAR_MS);
  }
  return new Date(from.getTime() + 7 * YEAR_MS);
}
