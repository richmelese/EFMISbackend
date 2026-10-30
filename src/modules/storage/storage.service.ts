import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Client, ObjectLockInfo, RETENTION_MODES } from 'minio';
import { Readable } from 'stream';
import { EntityManager, LessThan, Repository } from 'typeorm';
import { AppConfig } from '../../config/configuration';
import { Errors } from '../../common/utils/errors';
import { StorageRetention } from './entities/storage-retention.entity';
import { STORAGE_BUCKETS, StorageBucket, StoredObject } from './storage.types';

const SHA_META = 'X-Amz-Meta-Sha256';
const RETENTION_BATCH = 100;

/**
 * The only file storage of EFMIS: MinIO (S3 API), one private, versioned bucket per kind of file
 * (MINIO_STORAGE_PLAN.md). There is no local filesystem fallback — the API refuses to start without MinIO.
 * Callers keep the upload guarantees: put → save the referencing row in a transaction → on failure remove().
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger('Storage');
  private readonly cfg: AppConfig['storage'];
  readonly client: Client;
  /** Buckets created with object lock (retention can only be applied there) */
  private readonly locked = new Set<StorageBucket>();

  constructor(
    config: ConfigService,
    @InjectRepository(StorageRetention) private readonly retention: Repository<StorageRetention>
  ) {
    this.cfg = config.get<AppConfig['storage']>('storage')!;
    this.client = new Client({
      endPoint: this.cfg.endPoint, port: this.cfg.port, useSSL: this.cfg.useSSL,
      accessKey: this.cfg.accessKey, secretKey: this.cfg.secretKey, region: this.cfg.region
    });
  }

  bucketName(bucket: StorageBucket): string {
    return { FARMER_DOCUMENTS: this.cfg.buckets.farmerDocuments, DRIVER_DOCUMENTS: this.cfg.buckets.driverDocuments, DELIVERY_PROOFS: this.cfg.buckets.deliveryProofs }[bucket];
  }

  async onModuleInit() {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.ensureBuckets();
        return;
      } catch (e) {
        if (attempt >= this.cfg.connectAttempts) {
          throw new Error(`File storage (MinIO at ${this.cfg.endPoint}:${this.cfg.port}) is not available: ${(e as Error).message}`);
        }
        this.logger.warn(`MinIO not ready (attempt ${attempt}/${this.cfg.connectAttempts}): ${(e as Error).message}`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  /** Creates missing buckets (versioned; object lock when configured) and records which ones are locked. */
  private async ensureBuckets() {
    for (const bucket of STORAGE_BUCKETS) {
      const name = this.bucketName(bucket);
      if (!(await this.client.bucketExists(name))) {
        await this.client.makeBucket(name, this.cfg.region, this.cfg.objectLock ? { ObjectLocking: true } : {});
        this.logger.log(`Created bucket ${name}${this.cfg.objectLock ? ' (object lock)' : ''}`);
      }
      await this.client.setBucketVersioning(name, { Status: 'Enabled' });
      if (this.cfg.objectLock && (await this.hasObjectLock(name))) this.locked.add(bucket);
      else if (this.cfg.objectLock) this.logger.warn(`Bucket ${name} was created without object lock: retention cannot be applied to it`);
    }
  }

  private async hasObjectLock(name: string): Promise<boolean> {
    try {
      // the SDK's overloads make TypeScript pick the callback form; the promise form returns ObjectLockInfo
      const lock = await (this.client.getObjectLockConfig as (b: string) => Promise<ObjectLockInfo>).call(this.client, name);
      return lock?.objectLockEnabled === 'Enabled';
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ objects

  async put(bucket: StorageBucket, key: string, body: Buffer, meta: { mimeType: string; sha256: string }): Promise<StoredObject> {
    const info = await this.client.putObject(this.bucketName(bucket), key, body, body.length, { 'Content-Type': meta.mimeType, [SHA_META]: meta.sha256 });
    return { bucket, key, versionId: info.versionId ?? null, sizeBytes: body.length, sha256: meta.sha256, mimeType: meta.mimeType };
  }

  /** Streams an object; 404 NOT_FOUND when it does not exist. */
  async get(bucket: StorageBucket, key: string): Promise<{ stream: Readable; sizeBytes: number; mimeType: string; sha256: string | null }> {
    const name = this.bucketName(bucket);
    try {
      const stat = await this.client.statObject(name, key);
      const stream = await this.client.getObject(name, key);
      const meta = stat.metaData || {};
      return { stream, sizeBytes: stat.size, mimeType: String(meta['content-type'] || 'application/octet-stream'), sha256: (meta['sha256'] as string) ?? null };
    } catch (e) {
      if (isNotFound(e)) throw Errors.notFound('Stored file');
      throw e;
    }
  }

  async exists(bucket: StorageBucket, key: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucketName(bucket), key);
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  /**
   * Rollback of an upload whose transaction failed: removes exactly the uploaded version (no delete marker left
   * behind). Never throws — a failed cleanup is logged, it must not hide the original error.
   */
  async remove(obj: Pick<StoredObject, 'bucket' | 'key' | 'versionId'>): Promise<void> {
    try {
      await this.client.removeObject(this.bucketName(obj.bucket), obj.key, obj.versionId ? { versionId: obj.versionId } : {});
    } catch (e) {
      this.logger.error(`Could not remove ${obj.bucket}/${obj.key} after a failed upload: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ retention (write-once)

  /** Call inside the transaction that saves the referencing row; applied by applyPendingRetention() after commit. */
  async scheduleRetention(m: EntityManager, obj: StoredObject, retainUntil: Date): Promise<void> {
    if (!this.locked.has(obj.bucket)) return;
    await m.getRepository(StorageRetention).insert({ bucket: obj.bucket, objectKey: obj.key, versionId: obj.versionId, retainUntil, attempts: 0, lastError: null });
  }

  /** Applies GOVERNANCE retention to committed uploads (right after an upload, and by the scheduler as a retry). */
  async applyPendingRetention(): Promise<{ applied: number; failed: number }> {
    const rows = await this.retention.find({ where: { attempts: LessThan(1000) }, order: { id: 'ASC' }, take: RETENTION_BATCH });
    let applied = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        await this.client.putObjectRetention(this.bucketName(r.bucket as StorageBucket), r.objectKey, {
          versionId: r.versionId ?? '', mode: RETENTION_MODES.GOVERNANCE, retainUntilDate: r.retainUntil.toISOString()
        });
        await this.retention.delete({ id: r.id });
        applied++;
      } catch (e) {
        await this.retention.update({ id: r.id }, { attempts: r.attempts + 1, lastError: (e as Error).message.slice(0, 1000) });
        failed++;
      }
    }
    if (failed) this.logger.warn(`Retention could not be applied to ${failed} object(s); retried by the scheduler`);
    return { applied, failed };
  }

  /** Fire-and-forget variant for request handlers (after the commit). */
  applyPendingRetentionSoon(): void {
    void this.applyPendingRetention().catch(e => this.logger.error(`Retention run failed: ${(e as Error).message}`));
  }

  // ------------------------------------------------------------------ health / tests

  async health(): Promise<{ status: 'UP' | 'DOWN'; buckets: Record<string, boolean> }> {
    const buckets: Record<string, boolean> = {};
    try {
      for (const b of STORAGE_BUCKETS) buckets[b] = await this.client.bucketExists(this.bucketName(b));
      return { status: Object.values(buckets).every(Boolean) ? 'UP' : 'DOWN', buckets };
    } catch {
      return { status: 'DOWN', buckets };
    }
  }

  /** Test helper: deletes every version in the TEST buckets (names must start with "efmis-test-"). */
  async emptyTestBuckets(): Promise<void> {
    for (const bucket of STORAGE_BUCKETS) {
      const name = this.bucketName(bucket);
      if (!name.startsWith('efmis-test-')) throw new Error(`Refusing to empty non-test bucket ${name}`);
      const versions: Array<{ name: string; versionId?: string | null }> = await new Promise((resolve, reject) => {
        const out: Array<{ name: string; versionId?: string | null }> = [];
        const s = this.client.listObjects(name, '', true, { IncludeVersion: true });
        s.on('data', (o: any) => o.name && out.push({ name: o.name, versionId: o.versionId }));
        s.on('error', reject);
        s.on('end', () => resolve(out));
      });
      for (const v of versions) await this.client.removeObject(name, v.name, { versionId: v.versionId ?? undefined, governanceBypass: true });
    }
  }
}

function isNotFound(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === 'NotFound' || code === 'NoSuchKey' || code === 'NoSuchVersion';
}
