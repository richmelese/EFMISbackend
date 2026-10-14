import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import { RULES } from '../../../common/constants/rules';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { Errors } from '../../../common/utils/errors';
import { AuditService } from '../../audit/audit.service';
import { SettingsService } from '../../settings/settings.service';
import { logisticsThresholds } from '../logistics.constants';
import { DocumentVerificationDto, UploadDriverDocumentDto } from './dto/driver.dto';
import { Driver, DriverDocument } from './entities/driver.entities';
import { DriversService } from './drivers.service';
import { docToFrontend, docValidThrough, uniqueViolation, ymd } from './drivers.util';

/** Uploaded file (multer memory storage). */
export interface UploadedDriverFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const MIME_EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' };
const STORAGE_AREA = 'driver-documents';

/** Magic-number check so a renamed executable cannot be stored as "image/png". */
function contentMatchesMime(buf: Buffer, mime: string): boolean {
  if (mime === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/png') return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'application/pdf') return buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
  return false;
}

/** Secure driver document storage (Logistics doc §6 steps 4–5): private storage, audited access, verification. */
@Injectable()
export class DriverDocumentsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(DriverDocument) private readonly documents: Repository<DriverDocument>,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly drivers: DriversService
  ) {}

  private storageRoot(): string {
    const dir = this.config.get<string>('logistics.proofStorageDir');
    if (!dir) throw Errors.unprocessable('Private document storage is not configured');
    return path.resolve(dir);
  }

  private async warningDays() {
    return (await logisticsThresholds(this.settings)).documentExpiryWarningDays;
  }

  async upload(user: AuthUser, driverId: string, file: UploadedDriverFile | undefined, dto: UploadDriverDocumentDto, ctx: RequestContext) {
    if (!file || !file.buffer?.length) throw Errors.badRequest('Attach the document as multipart field "file"');
    const max = this.config.get<number>('maxUploadBytes') ?? 5 * 1024 * 1024;
    if (file.size > max) throw Errors.unprocessable(`File exceeds the maximum upload size of ${Math.round(max / 1024 / 1024)} MB`);
    if (!RULES.uploadMimeTypes.includes(file.mimetype) || !MIME_EXT[file.mimetype]) throw Errors.unprocessable('Only JPEG, PNG or PDF files are accepted');
    if (!contentMatchesMime(file.buffer, file.mimetype)) throw Errors.unprocessable('File content does not match its declared type');

    const today = ymd();
    if (dto.issuedAt && dto.issuedAt > today) throw Errors.unprocessable('issuedAt cannot be in the future', { field: 'issuedAt' });
    if (dto.issuedAt && dto.expiresAt && dto.expiresAt <= dto.issuedAt) throw Errors.unprocessable('expiresAt must be after issuedAt', { field: 'expiresAt' });
    if (dto.expiresAt && dto.expiresAt < today) throw Errors.unprocessable('Document is already expired', { field: 'expiresAt' });

    const driver = await this.ds.getRepository(Driver).findOne({ where: { id: driverId } });
    if (!driver) throw Errors.notFound('Driver');

    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const dup = await this.documents.findOne({ where: { sha256: hash } });
    if (dup) throw Errors.conflict('Duplicate document upload detected (identical file already stored)', { existingDocumentId: dup.id, driverId: dup.driverId });

    const id = crypto.randomUUID();
    const fileName = `${id}${MIME_EXT[file.mimetype]}`;
    const dir = path.join(this.storageRoot(), STORAGE_AREA);
    const abs = path.join(dir, fileName);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(abs, file.buffer, { mode: 0o600 });

    const originalName = path.basename(String(file.originalname || 'document')).replace(/[\u0000-\u001f"\\/]/g, '_').slice(0, 200) || 'document';
    try {
      const doc = await this.ds.transaction(async m => {
        const repo = m.getRepository(DriverDocument);
        const saved = await repo.save(repo.create({
          id, driverId: driver.id, documentType: dto.documentType, secureStorageKey: `${STORAGE_AREA}/${fileName}`, fileName: originalName,
          mimeType: file.mimetype, sizeBytes: file.size, sha256: hash, issuedAt: dto.issuedAt ?? null, expiresAt: dto.expiresAt ?? null,
          verificationStatus: 'PENDING', verifiedBy: null, verifiedAt: null, rejectionReason: null, uploadedBy: user.id
        }));
        await this.audit.record(user, 'DRIVER_DOCUMENT_UPLOADED', driver.id, {
          old: null,
          new: { documentId: saved.id, documentType: saved.documentType, mimeType: saved.mimeType, sizeBytes: saved.sizeBytes, sha256: hash, issuedAt: saved.issuedAt, expiresAt: saved.expiresAt }
        }, ctx, m);
        return saved;
      });
      return docToFrontend(doc, await this.warningDays());
    } catch (e) {
      await fs.promises.unlink(abs).catch(() => undefined);
      const msg = uniqueViolation(e);
      if (msg) throw Errors.conflict(msg);
      throw e;
    }
  }

  async list(user: AuthUser, driverId: string) {
    await this.drivers.readable(user, driverId);
    const warn = await this.warningDays();
    const rows = await this.documents.find({ where: { driverId }, order: { createdAt: 'DESC' } });
    return { items: rows.map(x => docToFrontend(x, warn)), total: rows.length, page: 1, pageSize: rows.length };
  }

  /** Resolve the private file for an authorised, audited download. */
  async file(user: AuthUser, documentId: string, ctx: RequestContext) {
    const doc = await this.documents.findOne({ where: { id: documentId } });
    if (!doc) throw Errors.notFound('Driver document');
    const root = this.storageRoot();
    const abs = path.resolve(root, doc.secureStorageKey);
    if (!abs.startsWith(root + path.sep)) throw Errors.notFound('Document file');
    if (!fs.existsSync(abs)) throw Errors.notFound('Document file');
    await this.audit.record(user, 'DRIVER_DOCUMENT_ACCESSED', doc.driverId, { documentId: doc.id, documentType: doc.documentType }, ctx);
    return { path: abs, mimeType: doc.mimeType, fileName: doc.fileName, sizeBytes: doc.sizeBytes };
  }

  async setVerification(user: AuthUser, documentId: string, dto: DocumentVerificationDto, ctx: RequestContext) {
    if (dto.status === 'REJECTED' && !dto.reason?.trim()) throw Errors.unprocessable('reason is required when rejecting a document', { field: 'reason' });
    const today = ymd();
    const res = await this.ds.transaction(async m => {
      const repo = m.getRepository(DriverDocument);
      const doc = await repo.findOne({ where: { id: documentId }, lock: { mode: 'pessimistic_write' } });
      if (!doc) throw Errors.notFound('Driver document');
      if (dto.status === 'VERIFIED' && (doc.verificationStatus === 'EXPIRED' || (doc.expiresAt && doc.expiresAt < today))) {
        throw Errors.unprocessable('An expired document cannot be verified — upload the renewed document');
      }
      const old = { verificationStatus: doc.verificationStatus, rejectionReason: doc.rejectionReason };
      doc.verificationStatus = dto.status;
      doc.verifiedBy = user.name;
      doc.verifiedAt = new Date();
      doc.rejectionReason = dto.status === 'REJECTED' ? dto.reason!.trim() : null;
      await repo.save(doc);
      await this.audit.record(user, dto.status === 'VERIFIED' ? 'DRIVER_DOCUMENT_VERIFIED' : 'DRIVER_DOCUMENT_REJECTED', doc.driverId, {
        documentId: doc.id, documentType: doc.documentType, old, new: { verificationStatus: doc.verificationStatus }, reason: dto.reason ?? null
      }, ctx, m);

      const driver = await m.getRepository(Driver).findOne({ where: { id: doc.driverId } });
      const licenceDocs = await repo.find({ where: { driverId: doc.driverId, documentType: 'LICENCE' } });
      const hasValidLicence = licenceDocs.some(x => docValidThrough(x, today));
      // renewal: a verified licence document restores a DOCUMENT_EXPIRED driver (licence date, verification and employment permitting)
      if (driver && dto.status === 'VERIFIED' && doc.documentType === 'LICENCE' && driver.availabilityStatus === 'DOCUMENT_EXPIRED') {
        await this.drivers.setAvailability(driver.id, 'AVAILABLE', m);
      }
      const warnings: string[] = [];
      if (driver && doc.documentType === 'LICENCE' && !hasValidLicence) {
        warnings.push('Driver has no verified, non-expired LICENCE document — the driver is not eligible for assignment');
      }
      return { doc, warnings };
    });
    return { ...docToFrontend(res.doc, await this.warningDays()), warnings: res.warnings };
  }
}
