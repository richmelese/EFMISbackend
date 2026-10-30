// Copies files from the retired local storage folders into MinIO (MINIO_STORAGE_PLAN.md §4). Run once per
// environment after the MinioStorage migration; idempotent. The only place in src/ that still reads local files.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { StorageService } from '../modules/storage/storage.service';
import { StorageBucket } from '../modules/storage/storage.types';
import { sha256 } from '../common/utils/helpers';

export interface ImportOptions {
  /** old UPLOAD_DIR (farmer documents: <dir>/<farmerId>/<file>) */
  uploadDir: string;
  /** old PROOF_STORAGE_DIR (driver-documents/<file>, proof-of-delivery/<file>) */
  privateDir: string;
  dryRun: boolean;
}

export interface ImportReport {
  copied: string[];
  alreadyPresent: string[];
  missingOnDisk: string[];
  hashMismatch: string[];
}

interface Row {
  bucket: StorageBucket;
  table: string;
  id: string;
  key: string;
  sha256: string;
  mimeType: string;
  oldPath: string;
  /** how the stored hash was computed: farmer documents and delivery proofs hash the base64 text */
  hash: (buf: Buffer) => string;
}

const base64Hash = (buf: Buffer) => sha256(buf.toString('base64'));
const rawHash = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const file = (key: string) => key.split('/').pop()!;

async function rows(ds: DataSource, o: ImportOptions): Promise<Row[]> {
  const farmer = await ds.query(`SELECT id, storage_key AS key, sha256, mime_type FROM farmer_documents`);
  const driver = await ds.query(`SELECT id, secure_storage_key AS key, sha256, mime_type FROM driver_documents`);
  const proof = await ds.query(`SELECT id, proof_of_delivery_storage_key AS key, proof_sha256 AS sha256, proof_mime_type AS mime_type
                                FROM deliveries WHERE proof_of_delivery_storage_key IS NOT NULL`);
  return [
    ...farmer.map((r: any): Row => ({ bucket: 'FARMER_DOCUMENTS', table: 'farmer_documents', id: r.id, key: r.key, sha256: r.sha256, mimeType: r.mime_type,
      oldPath: path.join(o.uploadDir, r.key), hash: base64Hash })),
    ...driver.map((r: any): Row => ({ bucket: 'DRIVER_DOCUMENTS', table: 'driver_documents', id: r.id, key: r.key, sha256: r.sha256, mimeType: r.mime_type,
      oldPath: path.join(o.privateDir, 'driver-documents', file(r.key)), hash: rawHash })),
    ...proof.map((r: any): Row => ({ bucket: 'DELIVERY_PROOFS', table: 'deliveries', id: r.id, key: r.key, sha256: r.sha256, mimeType: r.mime_type || 'application/octet-stream',
      oldPath: path.join(o.privateDir, 'proof-of-delivery', file(r.key)), hash: base64Hash }))
  ];
}

export async function importLocalFiles(ds: DataSource, storage: StorageService, o: ImportOptions): Promise<ImportReport> {
  const report: ImportReport = { copied: [], alreadyPresent: [], missingOnDisk: [], hashMismatch: [] };
  for (const r of await rows(ds, o)) {
    const label = `${r.table} ${r.id} → ${storage.bucketName(r.bucket)}/${r.key}`;
    if (await storage.exists(r.bucket, r.key)) {
      report.alreadyPresent.push(label);
      continue;
    }
    if (!fs.existsSync(r.oldPath)) {
      report.missingOnDisk.push(`${label} (expected ${r.oldPath})`);
      continue;
    }
    const buf = await fs.promises.readFile(r.oldPath);
    if (r.hash(buf) !== r.sha256) {
      report.hashMismatch.push(`${label} (${r.oldPath})`);
      continue;
    }
    if (!o.dryRun) await storage.put(r.bucket, r.key, buf, { mimeType: r.mimeType, sha256: r.sha256 });
    report.copied.push(label);
  }
  return report;
}
