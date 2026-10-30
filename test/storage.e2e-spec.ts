// File storage on MinIO (MINIO_STORAGE_PLAN.md): buckets, upload/download, duplicate block, rollback, write-once
// retention, refusing to start without MinIO, and the one-off import of the old local files.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { importLocalFiles } from '../src/database/storage-import';
import { AuditService } from '../src/modules/audit/audit.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { StorageRetention } from '../src/modules/storage/entities/storage-retention.entity';
import { STORAGE_BUCKETS } from '../src/modules/storage/storage.types';
import { SEED_USERS, startTestApi, TestApi } from './helpers/e2e';

const FARMER = 'FARM-2026-04821'; // Adama / Wonji kebele
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

const binary = (r: any) => r.buffer(true).parse((res: any, cb: (e: null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

/** A small valid JPEG-looking file with unique content (the type check reads the first bytes). */
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(256)]);

describe('File storage on MinIO (e2e)', () => {
  let t: TestApi;
  let storage: StorageService;
  let ds: DataSource;
  let da: string;

  beforeAll(async () => {
    t = await startTestApi();
    storage = t.app.get(StorageService);
    ds = t.app.get(DataSource);
    da = await t.loginAsUser(SEED_USERS.DA_WONJI);
  });

  afterAll(async () => {
    await t?.close();
  });

  const upload = (buf: Buffer, token = da) =>
    t.call('post', `/farmers/${FARMER}/documents`, token).field('docType', 'PHOTO').field('consent', 'true')
      .attach('file', buf, { filename: 'farmer.jpg', contentType: 'image/jpeg' });

  it('creates one private, versioned, object-locked bucket per kind of file; health reports it', async () => {
    for (const b of STORAGE_BUCKETS) {
      const name = storage.bucketName(b);
      expect(name.startsWith('efmis-test-')).toBe(true);
      expect(await storage.client.bucketExists(name)).toBe(true);
      expect((await storage.client.getBucketVersioning(name)).Status).toBe('Enabled');
      const lock = await (storage.client.getObjectLockConfig as (n: string) => Promise<{ objectLockEnabled: string }>).call(storage.client, name);
      expect(lock.objectLockEnabled).toBe('Enabled');
    }
    const health = await t.call('get', '/health');
    expect(health.body.storage).toEqual({ status: 'UP', buckets: { FARMER_DOCUMENTS: true, DRIVER_DOCUMENTS: true, DELIVERY_PROOFS: true } });
  });

  it('farmer document: stored in its bucket under <farmerId>/, downloaded byte for byte, retained 7 years', async () => {
    const buf = jpeg();
    const up = await upload(buf);
    expect(up.status).toBe(201);
    const [row] = await ds.query(`SELECT storage_key FROM farmer_documents WHERE id = $1`, [up.body.id]);
    expect(row.storage_key).toBe(`${FARMER}/${up.body.id}.jpg`);
    expect(await storage.exists('FARMER_DOCUMENTS', row.storage_key)).toBe(true);

    const down = await binary(t.call('get', `/farmers/${FARMER}/documents/${up.body.id}/file`, da));
    expect(down.status).toBe(200);
    expect(down.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(down.body, buf)).toBe(0);

    await storage.applyPendingRetention();
    expect(await ds.getRepository(StorageRetention).count()).toBe(0);
    const ret = await storage.client.getObjectRetention(storage.bucketName('FARMER_DOCUMENTS'), row.storage_key);
    expect(ret?.mode).toBe('GOVERNANCE');
    const years = (new Date(String(ret?.retainUntilDate)).getTime() - Date.now()) / YEAR_MS;
    expect(years).toBeGreaterThan(6.9);
    expect(years).toBeLessThan(7.1);
    // write-once: deleting the version without the governance bypass is refused
    const stat = await storage.client.statObject(storage.bucketName('FARMER_DOCUMENTS'), row.storage_key);
    await expect(storage.client.removeObject(storage.bucketName('FARMER_DOCUMENTS'), row.storage_key, { versionId: stat.versionId ?? undefined })).rejects.toThrow();
  });

  it('the same file twice is refused (409) and nothing new is stored', async () => {
    const buf = jpeg();
    expect((await upload(buf)).status).toBe(201);
    const before = await ds.query(`SELECT count(*)::int AS n FROM farmer_documents WHERE farmer_id = $1`, [FARMER]);
    expect((await upload(buf)).status).toBe(409);
    expect((await ds.query(`SELECT count(*)::int AS n FROM farmer_documents WHERE farmer_id = $1`, [FARMER]))[0].n).toBe(before[0].n);
  });

  it('rollback: when the row cannot be saved, the uploaded object is removed again', async () => {
    const listKeys = async () =>
      new Promise<string[]>((resolve, reject) => {
        const keys: string[] = [];
        const s = storage.client.listObjects(storage.bucketName('FARMER_DOCUMENTS'), `${FARMER}/`, true, { IncludeVersion: true });
        s.on('data', (o: any) => keys.push(`${o.name}@${o.versionId}`));
        s.on('error', reject);
        s.on('end', () => resolve(keys));
      });
    const before = await listKeys();
    const audit = t.app.get(AuditService);
    const original = audit.record.bind(audit);
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (...args: Parameters<AuditService['record']>) => {
      if (args[1] === 'FARMER_DOCUMENT_UPLOADED') throw new Error('simulated failure while saving');
      return original(...args);
    });
    try {
      expect((await upload(jpeg())).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await listKeys()).toEqual(before);
    expect(await ds.getRepository(StorageRetention).count()).toBe(0);
  });

  it('driver documents: seeded licences are real objects; uploads are retained until expiry + 2 years', async () => {
    const manager = await t.loginAs('LOGISTICS_MANAGER');
    const [seeded] = await ds.query(`SELECT id, driver_id, secure_storage_key AS key FROM driver_documents LIMIT 1`);
    expect(seeded.key).toBe(`${seeded.driver_id}/licence-demo.pdf`);
    const file = await binary(t.call('get', `/v1/driver-documents/${seeded.id}/file`, manager));
    expect(file.status).toBe(200);
    expect(file.body.subarray(0, 5).toString()).toBe('%PDF-');

    const pdf = Buffer.from(`%PDF-1.4\n% permit ${crypto.randomUUID()}\n%%EOF\n`);
    const up = await t.call('post', `/v1/drivers/${seeded.driver_id}/documents`, manager)
      .field('documentType', 'MEDICAL').field('expiresAt', '2029-10-30').attach('file', pdf, { filename: 'medical.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    const [row] = await ds.query(`SELECT secure_storage_key AS key FROM driver_documents WHERE id = $1`, [up.body.id]);
    await storage.applyPendingRetention();
    const ret = await storage.client.getObjectRetention(storage.bucketName('DRIVER_DOCUMENTS'), row.key);
    expect(new Date(String(ret?.retainUntilDate)).toISOString().slice(0, 10)).toBe(new Date(new Date('2029-10-30').getTime() + 2 * YEAR_MS).toISOString().slice(0, 10));
  });

  it('the API refuses to start without MinIO', async () => {
    const cfg = t.app.get(ConfigService);
    const offline = new ConfigService({ storage: { ...cfg.get('storage'), port: 1, connectAttempts: 1 } });
    const svc = new StorageService(offline, ds.getRepository(StorageRetention));
    await expect(svc.onModuleInit()).rejects.toThrow(/File storage \(MinIO .*\) is not available/);
  });

  it('import of the old local files: dry run, copy, idempotent second run, hash mismatch reported', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'efmis-import-'));
    const uploadDir = path.join(dir, 'uploads');
    const good = jpeg();
    const bad = jpeg();
    const sha = (b: Buffer) => crypto.createHash('sha256').update(b.toString('base64')).digest('hex');
    for (const [id, buf, stored] of [['DOC-IMPORT-1', good, good], ['DOC-IMPORT-2', bad, jpeg()]] as const) {
      fs.mkdirSync(path.join(uploadDir, FARMER), { recursive: true });
      fs.writeFileSync(path.join(uploadDir, FARMER, `${id}.jpg`), buf);
      await ds.query(
        `INSERT INTO farmer_documents (id, farmer_id, doc_type, file_name, mime_type, size_bytes, sha256, storage_key, consent_given, uploaded_by)
         VALUES ($1, $2, 'PHOTO', $3, 'image/jpeg', $4, $5, $6, true, 'test')`,
        [id, FARMER, `${id}.jpg`, buf.length, sha(stored), `${FARMER}/${id}.jpg`]
      );
    }
    const opts = { uploadDir, privateDir: path.join(dir, 'private'), dryRun: true };
    const dry = await importLocalFiles(ds, storage, opts);
    expect(dry.copied.some(l => l.includes('DOC-IMPORT-1'))).toBe(true);
    expect(dry.hashMismatch.some(l => l.includes('DOC-IMPORT-2'))).toBe(true);
    expect(await storage.exists('FARMER_DOCUMENTS', `${FARMER}/DOC-IMPORT-1.jpg`)).toBe(false);

    const real = await importLocalFiles(ds, storage, { ...opts, dryRun: false });
    expect(real.copied.some(l => l.includes('DOC-IMPORT-1'))).toBe(true);
    expect(await storage.exists('FARMER_DOCUMENTS', `${FARMER}/DOC-IMPORT-1.jpg`)).toBe(true);
    const again = await importLocalFiles(ds, storage, { ...opts, dryRun: false });
    expect(again.copied).toEqual([]);
    expect(again.alreadyPresent.some(l => l.includes('DOC-IMPORT-1'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
