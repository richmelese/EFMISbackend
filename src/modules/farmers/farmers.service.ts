import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';
import { Farmer } from './entities/farmer.entity';
import { FarmerDemand } from './entities/farmer-demand.entity';
import { FarmerDocument } from './entities/farmer-document.entity';
import { DeleteFarmerDto, ListFarmersQueryDto, RegisterFarmerDto, SyncFarmersDto, UpdateFarmerDto, UploadDocumentDto } from './dto/farmer.dto';
import { RULES } from '../../common/constants/rules';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { nowStamp, parseStamp, round, sha256, shortId, stamp, today } from '../../common/utils/helpers';
import { assertInScope, scopeCondition, UnitRef } from '../../common/utils/scope';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ExternalService, FAYDA_MESSAGES, FaydaRecord } from '../external/external.service';
import { HierarchyService } from '../hierarchy/hierarchy.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';

export interface QualityFlag {
  code: string;
  severity: 'WARNING' | 'BLOCKING';
  type?: string;
  message: string;
}

/** Records in these approval levels can still be edited by the DA. */
export const EDITABLE_LEVELS = ['Pending Kebele Review', 'Returned for Revision', 'Rejected by Kebele'];
export const PENDING_KEBELE = 'Pending Kebele Review';

/** pg advisory lock key serialising Farm ID allocation (FARM-YYYY-XXXXX). */
const FARM_ID_LOCK = 4_242_101;

const MIME_EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' };

const flattenValidation = (e: ValidationError, prefix = ''): Array<{ field: string; message: string }> => {
  const field = prefix ? `${prefix}.${e.property}` : e.property;
  return Object.values(e.constraints || {}).map(message => ({ field, message })).concat((e.children || []).flatMap(c => flattenValidation(c, field)));
};

/** Uploaded file (multer memory storage). */
export interface UploadedDoc {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Farmer registry & demand capture (REQ-1.1-001..007).
 * Public contract used by other modules: toFrontend, qualityFlags, getRow, unitOf, recommendedQtl, classifyDemand.
 */
@Injectable()
export class FarmersService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Farmer) readonly repo: Repository<Farmer>,
    @InjectRepository(FarmerDemand) readonly demandRepo: Repository<FarmerDemand>,
    @InjectRepository(FarmerDocument) private readonly docRepo: Repository<FarmerDocument>,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly approvals: ApprovalsService,
    private readonly external: ExternalService,
    private readonly hierarchy: HierarchyService,
    private readonly config: ConfigService
  ) {}

  // ------------------------------------------------------------------ rules

  anomalyThreshold(): Promise<number> {
    return this.settings.get<number>('anomalyThresholdPct', RULES.anomalyThresholdPct);
  }

  recommendedQtl(type: string, farmSizeHa: number): number {
    return round((RULES.recommendedQtlPerHa[type] ?? 1) * farmSizeHa, 2);
  }

  /** REQ-1.1-007: classify a demand line against the agronomic recommendation. */
  classifyDemand(requestedQtl: number, recommended: number, thresholdPct: number): 'FLAGGED_ANOMALY' | 'PENDING_REVIEW' {
    const limit = recommended * (1 + thresholdPct / 100);
    return requestedQtl > limit ? 'FLAGGED_ANOMALY' : 'PENDING_REVIEW';
  }

  async qualityFlags(farmer: Farmer, demands: FarmerDemand[], thresholdPct?: number): Promise<QualityFlag[]> {
    const threshold = thresholdPct ?? (await this.anomalyThreshold());
    const flags: QualityFlag[] = [];
    for (const d of demands) {
      if (d.recommendedQtl > 0 && d.requestedQtl > d.recommendedQtl * (1 + threshold / 100)) {
        const pct = round(((d.requestedQtl - d.recommendedQtl) / d.recommendedQtl) * 100, 1);
        flags.push({ code: 'DEMAND_ANOMALY', severity: 'WARNING', type: d.type, message: `${d.type} request exceeds agronomic recommendation by +${pct}% (threshold ${threshold}%)` });
      }
    }
    if (farmer.creditArrearsEtb > 0) {
      flags.push({ code: 'OUTSTANDING_ARREARS', severity: 'WARNING', message: `Outstanding credit arrears of ${farmer.creditArrearsEtb.toLocaleString('en-US')} ETB` });
    }
    if (farmer.faydaStatus !== 'VERIFIED_ACTIVE') flags.push({ code: 'FAYDA_PENDING', severity: 'WARNING', message: 'Fayda Verification Pending' });
    const mandatory: Array<[keyof Farmer, string]> = [['phone', 'phone'], ['farmSizeHa', 'farm_size_ha'], ['landCertNumber', 'land_cert_number'], ['kebeleId', 'kebele_id']];
    const missing = mandatory.filter(([k]) => farmer[k] === null || farmer[k] === undefined || (farmer[k] as unknown) === '').map(([, label]) => label);
    if (missing.length) flags.push({ code: 'INCOMPLETE', severity: 'BLOCKING', message: `Missing mandatory fields: ${missing.join(', ')}` });
    return flags;
  }

  // ------------------------------------------------------------------ mapping

  async demandsOf(farmerId: string, manager?: EntityManager): Promise<FarmerDemand[]> {
    return (manager ? manager.getRepository(FarmerDemand) : this.demandRepo).find({ where: { farmerId }, order: { id: 'ASC' } });
  }

  /** Frontend farmer shape (EFMIS_DATA.farmers). Loads demand lines when farmer.demands is not loaded. */
  async toFrontend(farmer: Farmer, opts: { thresholdPct?: number; manager?: EntityManager } = {}): Promise<any> {
    const f = farmer;
    const lines = f.demands ? [...f.demands].sort((a, b) => a.id - b.id) : await this.demandsOf(f.id, opts.manager);
    return {
      id: f.id,
      name: f.name,
      firstName: f.firstName, middleName: f.middleName, lastName: f.lastName, motherName: f.motherName,
      faydaId: f.faydaId,
      faydaStatus: f.faydaStatus,
      nationalIdNumber: f.nationalIdNumber,
      phone: f.phone,
      phoneSecondary: f.phoneSecondary,
      gender: f.gender,
      ageGroup: f.ageGroup,
      householdSize: f.householdSize,
      educationLevel: f.educationLevel,
      primaryOccupation: f.primaryOccupation,
      region: f.region, zone: f.zone, woreda: f.woreda, kebele: f.kebele,
      regionId: f.regionId, zoneId: f.zoneId, woredaId: f.woredaId, kebeleId: f.kebeleId,
      cooperative: f.cooperative,
      landCertNumber: f.landCertNumber,
      landCertVerified: !!f.landCertVerified,
      farmSizeHa: f.farmSizeHa,
      irrigationAccess: f.irrigationAccess,
      landTenure: f.landTenure,
      crops: f.crops || [],
      targetCrop: f.targetCrop,
      season: f.season,
      demands: lines.map(d => ({
        type: d.type, requestedQtl: d.requestedQtl, recommendedQtl: d.recommendedQtl, approvedQtl: d.approvedQtl,
        status: d.status, reviewComment: d.reviewComment || undefined
      })),
      submissionDate: f.submissionDate,
      daName: f.daName,
      creditScore: f.creditScore,
      creditArrearsETB: f.creditArrearsEtb,
      telebirrPhone: f.telebirrPhone,
      cbeAccount: f.cbeAccount,
      photoUrl: f.photoUrl,
      approvalLevel: f.approvalLevel,
      notes: f.notes,
      gps: f.gpsLat !== null && f.gpsLat !== undefined ? { lat: f.gpsLat, lng: f.gpsLng } : null,
      source: f.source,
      version: f.version,
      updatedAt: stamp(f.updatedAt),
      qualityFlags: await this.qualityFlags(f, lines, opts.thresholdPct)
    };
  }

  /** Map many farmers with one settings lookup. */
  async manyToFrontend(rows: Farmer[]): Promise<any[]> {
    const thresholdPct = await this.anomalyThreshold();
    return Promise.all(rows.map(f => this.toFrontend(f, { thresholdPct })));
  }

  async getRow(id: string, manager?: EntityManager): Promise<Farmer> {
    if (!id) throw Errors.notFound('Farmer');
    const f = await (manager ? manager.getRepository(Farmer) : this.repo).findOne({ where: { id, deleted: false } });
    if (!f) throw Errors.notFound('Farmer');
    return f;
  }

  unitOf(f: Farmer): UnitRef {
    return { regionId: f.regionId, zoneId: f.zoneId, woredaId: f.woredaId, kebeleId: f.kebeleId };
  }

  private async getScoped(user: AuthUser, id: string): Promise<Farmer> {
    const f = await this.getRow(id);
    assertInScope(user, this.unitOf(f), 'farmer');
    return f;
  }

  // ------------------------------------------------------------------ queries

  async list(user: AuthUser, q: ListFarmersQueryDto) {
    const s = scopeCondition(user, 'f');
    const qb = this.repo.createQueryBuilder('f').leftJoinAndSelect('f.demands', 'd').where('f.deleted = false').andWhere(s.sql, s.params);
    if (q.q) qb.andWhere('(f.name ILIKE :q OR f.id ILIKE :q OR f.faydaId ILIKE :q OR f.landCertNumber ILIKE :q OR f.kebele ILIKE :q)', { q: `%${q.q}%` });
    if (q.kebeleId) qb.andWhere('f.kebeleId = :kebeleId', { kebeleId: q.kebeleId });
    if (q.woredaId) qb.andWhere('f.woredaId = :woredaId', { woredaId: q.woredaId });
    if (q.regionId) qb.andWhere('f.regionId = :regionId', { regionId: q.regionId });
    if (q.approvalLevel) qb.andWhere('f.approvalLevel = :approvalLevel', { approvalLevel: q.approvalLevel });
    if (q.season) qb.andWhere('f.season = :season', { season: q.season });
    if (q.status) qb.andWhere('EXISTS (SELECT 1 FROM farmer_demands sd WHERE sd.farmer_id = f.id AND sd.status = :dstatus)', { dstatus: q.status });
    if (q.minRequestedQtl) {
      qb.andWhere('(SELECT SUM(sd.requested_qtl) FROM farmer_demands sd WHERE sd.farmer_id = f.id) > :minQ', { minQ: Number(q.minRequestedQtl) });
    }
    const sortMap: Record<string, string> = { name: 'f.name', date: 'f.submissionDate', farmSize: 'f.farmSizeHa', id: 'f.id' };
    qb.orderBy(sortMap[q.sort || ''] || 'f.id', q.order === 'desc' ? 'DESC' : 'ASC').addOrderBy('d.id', 'ASC');
    return this.manyToFrontend(await qb.getMany());
  }

  async recommendation(farmSizeHa: unknown) {
    const ha = Number(farmSizeHa) || 0;
    return {
      farmSizeHa: ha,
      recommendedQtl: Object.fromEntries(Object.keys(RULES.recommendedQtlPerHa).map(t => [t, this.recommendedQtl(t, ha)])),
      anomalyThresholdPct: await this.anomalyThreshold()
    };
  }

  private findActiveBy(where: { faydaId?: string; landCertNumber?: string }, select: Array<keyof Farmer> = ['id', 'name', 'kebele']) {
    return this.repo.findOne({ where: { ...where, deleted: false }, select });
  }

  async checkDuplicate(faydaId?: string, landCertNumber?: string) {
    const byFayda = faydaId ? await this.findActiveBy({ faydaId }) : null;
    const byCert = landCertNumber ? await this.findActiveBy({ landCertNumber }) : null;
    return { duplicate: !!(byFayda || byCert), byFaydaId: byFayda || null, byLandCertificate: byCert || null };
  }

  /** Active farmer holding a Fayda ID / land certificate (identity endpoints). */
  activeByFayda(faydaId: string) {
    return this.findActiveBy({ faydaId });
  }

  activeByLandCert(landCertNumber: string) {
    return this.findActiveBy({ landCertNumber }, ['id', 'name']);
  }

  async findOne(user: AuthUser, id: string) {
    return this.toFrontend(await this.getScoped(user, id));
  }

  async history(user: AuthUser, id: string) {
    const f = await this.getScoped(user, id);
    const previous = f.faydaId
      ? await this.repo.find({ where: { faydaId: f.faydaId, id: Not(f.id), deleted: false }, select: ['id', 'season', 'approvalLevel'] })
      : [];
    return {
      approvals: await this.approvals.history('FARMER', f.id),
      audit: await this.audit.list({ target: f.id }),
      previousSeasons: previous.map(p => ({ id: p.id, season: p.season, approval_level: p.approvalLevel }))
    };
  }

  // ------------------------------------------------------------------ registration

  /** Next FARM-YYYY-XXXXX inside a transaction holding the allocation lock. */
  private async nextFarmId(m: EntityManager): Promise<string> {
    await m.query('SELECT pg_advisory_xact_lock($1)', [FARM_ID_LOCK]);
    const year = new Date().getFullYear();
    const rows: Array<{ id: string }> = await m.query('SELECT id FROM farmers WHERE id LIKE $1 ORDER BY id DESC LIMIT 1', [`FARM-${year}-%`]);
    const next = rows.length ? parseInt(rows[0].id.split('-')[2], 10) + 1 : 1;
    return `FARM-${year}-${String(next).padStart(5, '0')}`;
  }

  /**
   * Validate & register a farmer (REQ-1.1-001). Used by online registration and offline sync.
   * The record, its demand lines, the audit entry and the kebele notification commit atomically.
   */
  async register(user: AuthUser, input: RegisterFarmerDto, ctx: RequestContext, opts: { source?: 'ONLINE' | 'OFFLINE_SYNC' } = {}) {
    const source = opts.source || 'ONLINE';
    // Kebele selection must match DA's assigned location
    const kebeleId = input.kebeleId || user.kebeleId;
    if (!kebeleId) throw Errors.badRequest('kebeleId is required');
    if (user.role === 'DA' && user.kebeleId && kebeleId !== user.kebeleId) {
      throw Errors.forbidden("Kebele selection must match the DA's assigned location");
    }
    const k = await this.hierarchy.resolveKebele(kebeleId);
    const maxHa = k.region.maxFarmSizeHa ?? RULES.defaultMaxFarmSizeHa;

    const fullName = [input.firstName, input.middleName, input.lastName].filter(Boolean).join(' ').trim();
    const errors: Array<{ field: string; message: string }> = [];
    if (fullName.length < RULES.minFarmerNameLength) errors.push({ field: 'firstName', message: 'Farmer name must be provided (minimum 3 characters)' });
    if (!RULES.phoneRegex.test(input.phone || '')) errors.push({ field: 'phone', message: 'Phone number must be valid Ethiopian format (09XXXXXXXX or 07XXXXXXXX)' });
    if (input.phoneSecondary && !RULES.phoneRegex.test(input.phoneSecondary)) errors.push({ field: 'phoneSecondary', message: 'Secondary phone must be valid Ethiopian format' });
    if (!(input.farmSizeHa > 0) || input.farmSizeHa > maxHa) {
      errors.push({ field: 'farmSizeHa', message: `Farm size must be greater than zero and at most ${maxHa} ha for ${k.region.name}` });
    }
    if (errors.length) throw Errors.unprocessable('Farmer registration validation failed', errors);

    // Duplicate checks (land certificate & Fayda unique, REQ-1.1-004)
    if (await this.repo.exist({ where: { landCertNumber: input.landCertNumber, deleted: false } })) {
      throw Errors.conflict('Land certificate number is already registered (duplicate registration)', { field: 'landCertNumber' });
    }
    let faydaStatus = 'FAYDA_VERIFICATION_PENDING';
    let faydaRecord: FaydaRecord | null = null;
    if (input.faydaId) {
      const dup = await this.findActiveBy({ faydaId: input.faydaId });
      if (dup) throw Errors.conflict(FAYDA_MESSAGES.DUPLICATE, { existingFarmer: dup });
      const v = await this.external.faydaVerify(input.faydaId, { user });
      if (v.status === 'INVALID') throw Errors.unprocessable(v.message, [{ field: 'faydaId', message: v.message }]);
      if (v.status === 'VERIFIED') {
        faydaStatus = 'VERIFIED_ACTIVE';
        faydaRecord = v.record;
      }
    }

    const nrlais = await this.external.nrlaisVerify(input.landCertNumber);
    const threshold = await this.anomalyThreshold();
    const season = input.season || (await this.settings.currentSeason());
    const coop = input.cooperativeMember === false ? null : input.cooperative || null;
    const irrigation = input.irrigationAccess ? `Yes (${input.irrigationType || 'Other'})` : 'No';

    // Demand lines: explicit array, or the two quantities the DA screen captures (reqNpsb / reqUrea)
    const demandInput = input.demands && input.demands.length
      ? input.demands
      : [{ type: 'NPSB', requestedQtl: input.reqNpsb }, { type: 'UREA', requestedQtl: input.reqUrea }].filter(d => d.requestedQtl !== undefined && d.requestedQtl !== null);
    const lines = demandInput.map(d => {
      const recommended = this.recommendedQtl(d.type, input.farmSizeHa);
      const requested = Number(d.requestedQtl);
      return { type: d.type, requestedQtl: round(requested), recommendedQtl: recommended, approvedQtl: null, status: this.classifyDemand(requested, recommended, threshold) };
    });
    const anomalies = lines.filter(l => l.status === 'FLAGGED_ANOMALY');
    const at = input.clientTimestamp ? parseStamp(input.clientTimestamp) : null;
    const timestamps = at && !Number.isNaN(at.getTime()) ? { createdAt: at, updatedAt: at } : {};

    const farmer = await this.ds.transaction(async m => {
      const id = await this.nextFarmId(m);
      await m.getRepository(Farmer).insert({
        id,
        firstName: input.firstName, middleName: input.middleName || null, lastName: input.lastName || null, name: fullName,
        motherName: input.motherName || null, faydaId: input.faydaId || null, faydaStatus,
        nationalIdNumber: faydaRecord?.nationalIdNumber || input.nationalIdNumber || null,
        phone: input.phone, phoneSecondary: input.phoneSecondary || null, gender: input.gender || faydaRecord?.gender || null,
        ageGroup: input.ageGroup || null, householdSize: input.householdSize ?? null, educationLevel: input.educationLevel || null,
        primaryOccupation: input.primaryOccupation || null,
        regionId: k.region.id, zoneId: k.zone.id, woredaId: k.woreda.id, kebeleId: k.kebele.id,
        region: k.region.name, zone: k.zone.name, woreda: k.woreda.name, kebele: k.kebele.name,
        cooperative: coop, landCertNumber: input.landCertNumber, landCertVerified: !!nrlais.verified, farmSizeHa: input.farmSizeHa,
        irrigationAccess: irrigation, landTenure: input.landTenure || null, crops: input.crops || [], targetCrop: input.targetCrop || null,
        season, submissionDate: today(),
        daUserId: user.role === 'DA' ? user.id : null, daName: user.role === 'DA' ? user.name : k.kebele.daName || user.name,
        creditScore: null, creditArrearsEtb: 0, telebirrPhone: input.phone, cbeAccount: null,
        approvalLevel: PENDING_KEBELE,
        notes: anomalies.length
          ? `Anomaly flagged: ${anomalies.map(a => a.type).join(', ')} exceeds NSIS recommended rate by more than ${threshold}%.`
          : input.notes || null,
        gpsLat: input.gps?.lat ?? null, gpsLng: input.gps?.lng ?? null, consentGiven: !!input.consent,
        source, clientUuid: input.clientUuid || null, deviceId: input.deviceId || null,
        ...timestamps
      });
      if (lines.length) await m.getRepository(FarmerDemand).insert(lines.map(l => ({ ...l, farmerId: id })));
      const row = await this.getRow(id, m);
      const out = await this.toFrontend(row, { thresholdPct: threshold, manager: m });

      if (source === 'ONLINE') {
        await this.audit.record(user, 'FARMER_REGISTERED', id, { new: { name: out.name, kebele: out.kebele, demands: out.demands } }, ctx, m);
        await this.notifications.notify({
          role: 'KEBELE', unitId: out.kebeleId, title: 'New farmer demand submitted', message: `${out.name} (${out.id}) is pending kebele review`, link: '/kebele/pending'
        }, m);
      } else {
        await this.audit.record(user, 'FARMER_REGISTRATION_OFFLINE_SYNC', id, { deviceId: input.deviceId, enteredAt: input.clientTimestamp }, { ...ctx, source: 'MOBILE' }, m);
      }
      return out;
    });

    const warnings = [
      ...('message' in nrlais && !nrlais.verified ? [nrlais.message] : []),
      ...(faydaStatus !== 'VERIFIED_ACTIVE' ? [FAYDA_MESSAGES.UNAVAILABLE] : [])
    ];
    return { farmer, warnings };
  }

  // ------------------------------------------------------------------ edits

  /** Apply an edit to an editable record (PATCH and offline sync). Version-guarded against concurrent writers. */
  private async applyUpdate(f: Farmer, data: UpdateFarmerDto, m: EntityManager): Promise<void> {
    if (!EDITABLE_LEVELS.includes(f.approvalLevel)) {
      throw Errors.conflict(`Record is "${f.approvalLevel}" and can no longer be edited; request an amendment instead`);
    }
    if (data.phone && !RULES.phoneRegex.test(data.phone)) throw Errors.unprocessable('Phone number must be valid Ethiopian format (09XXXXXXXX or 07XXXXXXXX)');
    if (data.farmSizeHa !== undefined) {
      const region = await this.hierarchy.regions.findOne({ where: { id: f.regionId } });
      const max = region?.maxFarmSizeHa ?? RULES.defaultMaxFarmSizeHa;
      if (!(data.farmSizeHa > 0) || data.farmSizeHa > max) throw Errors.unprocessable(`Farm size must be greater than zero and at most ${max} ha`);
    }

    const fields = [
      'phone', 'phoneSecondary', 'householdSize', 'educationLevel', 'primaryOccupation', 'cooperative', 'farmSizeHa', 'landTenure',
      'targetCrop', 'notes', 'ageGroup', 'gender'
    ] as const;
    const set: Record<string, unknown> = {};
    for (const k of fields) if (data[k] !== undefined) set[k] = data[k];
    if (data.crops) set.crops = data.crops;
    if (data.irrigationAccess !== undefined) set.irrigationAccess = data.irrigationAccess ? `Yes (${data.irrigationType || 'Other'})` : 'No';
    if (data.gps) {
      set.gpsLat = data.gps.lat;
      set.gpsLng = data.gps.lng;
    }
    set.approvalLevel = PENDING_KEBELE;
    const at = data.clientTimestamp ? parseStamp(data.clientTimestamp) : null;
    if (at && !Number.isNaN(at.getTime())) set.updatedAt = at;

    // version auto-increments (and updatedAt defaults to now) via the query builder
    const res = await m.createQueryBuilder().update(Farmer).set(set as any)
      .where('id = :id AND version = :version AND deleted = false', { id: f.id, version: f.version }).execute();
    if (!res.affected) throw Errors.conflict('Record was modified by someone else. Reload and try again.', { serverVersion: f.version });

    const size = data.farmSizeHa ?? f.farmSizeHa;
    const lines: Array<{ type: string; requestedQtl: number }> | null = data.demands
      || (data.farmSizeHa !== undefined ? (await this.demandsOf(f.id, m)).map(d => ({ type: d.type, requestedQtl: d.requestedQtl })) : null);
    if (lines) {
      const threshold = await this.anomalyThreshold();
      for (const d of lines) {
        const rec = this.recommendedQtl(d.type, size);
        await m.query(
          `INSERT INTO farmer_demands (farmer_id, type, requested_qtl, recommended_qtl, approved_qtl, status) VALUES ($1, $2, $3, $4, NULL, $5)
           ON CONFLICT (farmer_id, type) DO UPDATE SET requested_qtl = EXCLUDED.requested_qtl, recommended_qtl = EXCLUDED.recommended_qtl,
           approved_qtl = NULL, status = EXCLUDED.status, review_comment = NULL`,
          [f.id, d.type, round(d.requestedQtl), rec, this.classifyDemand(Number(d.requestedQtl), rec, threshold)]
        );
      }
    }
  }

  async update(user: AuthUser, id: string, dto: UpdateFarmerDto, ctx: RequestContext) {
    const f = await this.getScoped(user, id);
    if (dto.version !== undefined && dto.version !== f.version) {
      throw Errors.conflict('Record was modified by someone else. Reload and try again.', { serverVersion: f.version });
    }
    const old = await this.toFrontend(f);
    await this.ds.transaction(async m => {
      await this.applyUpdate(f, dto, m);
      await this.audit.record(user, 'FARMER_UPDATED', f.id, { old: { demands: old.demands, farmSizeHa: old.farmSizeHa, phone: old.phone }, new: dto }, ctx, m);
    });
    return this.toFrontend(await this.getRow(f.id));
  }

  private async softDelete(f: Farmer, m: EntityManager) {
    await m.createQueryBuilder().update(Farmer).set({ deleted: true }).where('id = :id', { id: f.id }).execute();
  }

  async remove(user: AuthUser, id: string, dto: DeleteFarmerDto, ctx: RequestContext) {
    const f = await this.getScoped(user, id);
    if (f.approvalLevel !== PENDING_KEBELE) throw Errors.conflict('Only records pending kebele review can be deleted');
    const old = await this.toFrontend(f);
    await this.ds.transaction(async m => {
      await this.softDelete(f, m);
      await this.audit.record(user, 'FARMER_DELETED', f.id, { reason: dto.reason, old }, ctx, m);
    });
    return { deleted: true, id: f.id };
  }

  // ------------------------------------------------------------------ offline sync (REQ-1.1-006)

  private async validateAs<T extends object>(cls: new () => T, plain: Record<string, unknown>): Promise<T> {
    const obj = plainToInstance(cls, plain, { enableImplicitConversion: true });
    const errs = await validate(obj, { whitelist: true });
    if (errs.length) throw Errors.unprocessable('Request validation failed', errs.flatMap(e => flattenValidation(e)));
    return obj;
  }

  /**
   * Priority: registrations -> demand edits -> deletions. Conflict policy: last write wins (by client timestamp), audited.
   * @param rawRecords the records exactly as received (checksums are computed over the untransformed `data`)
   */
  async sync(user: AuthUser, dto: SyncFarmersDto, rawRecords: any[], ctx: RequestContext) {
    const mobile: RequestContext = { ...ctx, source: 'MOBILE' };
    const order = { CREATE: 0, UPDATE: 1, DELETE: 2 };
    const records = dto.records
      .map((r, i) => ({ r, raw: rawRecords?.[i]?.data ?? r.data }))
      .sort((a, b) => order[a.r.operation] - order[b.r.operation]);
    const results: any[] = [];

    for (const { r, raw } of records) {
      const base = { clientUuid: r.clientUuid, operation: r.operation };
      try {
        if (sha256(raw) !== r.checksum.replace(/^sha256:/, '')) {
          results.push({ ...base, status: 'REJECTED', error: 'Checksum mismatch: payload corrupted in transit' });
          continue;
        }
        if (r.operation === 'CREATE') {
          const existing = await this.repo.findOne({ where: { clientUuid: r.clientUuid } });
          if (existing) {
            results.push({ ...base, status: 'ALREADY_SYNCED', farmerId: existing.id });
            continue;
          }
          const input = await this.validateAs(RegisterFarmerDto, { ...raw, clientUuid: r.clientUuid, deviceId: dto.deviceId, clientTimestamp: r.clientUpdatedAt });
          const { farmer, warnings } = await this.register(user, input, mobile, { source: 'OFFLINE_SYNC' });
          results.push({ ...base, status: 'CREATED', farmerId: farmer.id, warnings });
          continue;
        }

        const f = await this.getScoped(user, r.farmerId as string);
        const clientAt = parseStamp(r.clientUpdatedAt);
        if (f.updatedAt > clientAt) {
          await this.audit.record(user, 'SYNC_CONFLICT_SERVER_WINS', f.id, { deviceId: dto.deviceId, clientUpdatedAt: r.clientUpdatedAt, serverUpdatedAt: stamp(f.updatedAt) }, mobile);
          results.push({ ...base, status: 'CONFLICT_SERVER_WINS', farmerId: f.id, server: await this.toFrontend(f) });
          continue;
        }
        if (r.operation === 'UPDATE') {
          const data = await this.validateAs(UpdateFarmerDto, { ...raw, clientTimestamp: r.clientUpdatedAt });
          await this.ds.transaction(async m => {
            await this.applyUpdate(f, data, m);
            await this.audit.record(user, 'FARMER_UPDATED_OFFLINE_SYNC', f.id, { deviceId: dto.deviceId, new: raw }, mobile, m);
          });
          results.push({ ...base, status: 'UPDATED', farmerId: f.id });
        } else {
          if (f.approvalLevel !== PENDING_KEBELE) throw Errors.conflict('Only pending records can be deleted');
          await this.ds.transaction(async m => {
            await this.softDelete(f, m);
            await this.audit.record(user, 'FARMER_DELETED_OFFLINE_SYNC', f.id, { deviceId: dto.deviceId }, mobile, m);
          });
          results.push({ ...base, status: 'DELETED', farmerId: f.id });
        }
      } catch (err: any) {
        const body = typeof err?.getResponse === 'function' ? err.getResponse() : null;
        const details = err?.details ?? (body && typeof body === 'object' ? body.details : undefined);
        results.push({
          ...base, status: 'FAILED', error: err?.message || 'Sync failed',
          details: Array.isArray(details) && details.every((d: any) => d && d.field) ? details.map((d: any) => `${d.field}: ${d.message}`) : details
        });
      }
    }
    const summary = results.reduce((s: Record<string, number>, x) => ({ ...s, [x.status]: (s[x.status] || 0) + 1 }), {});
    return { syncedAt: nowStamp(), deviceId: dto.deviceId, summary, results };
  }

  // ------------------------------------------------------------------ documents (REQ-1.1-002 / -005)

  async uploadDocument(user: AuthUser, id: string, file: UploadedDoc | undefined, dto: UploadDocumentDto, ctx: RequestContext) {
    const f = await this.getScoped(user, id);
    if (!file) throw Errors.badRequest('Attach the document as multipart field "file"');
    const docType = String(dto.docType || 'OTHER').toUpperCase();
    if (!RULES.documentTypes.includes(docType)) throw Errors.badRequest(`docType must be one of ${RULES.documentTypes.join(', ')}`);
    if (String(dto.consent) !== 'true') throw Errors.badRequest('Farmer consent is required for image storage and use (consent=true)');
    if (!RULES.uploadMimeTypes.includes(file.mimetype)) throw Errors.badRequest('Only JPEG, PNG or PDF files are accepted');

    const hash = sha256(file.buffer.toString('base64'));
    const dup = await this.docRepo.findOne({ where: { sha256: hash }, select: ['id', 'farmerId'] });
    if (dup) throw Errors.conflict('Duplicate document upload detected (identical file already stored)', { existingDocumentId: dup.id, farmerId: dup.farmerId });

    const docId = shortId('DOC');
    const dir = path.join(this.config.get<string>('uploadDir')!, f.id);
    await fs.promises.mkdir(dir, { recursive: true });
    const storagePath = path.join(dir, docId + MIME_EXT[file.mimetype]);
    await fs.promises.writeFile(storagePath, file.buffer);
    try {
      await this.ds.transaction(async m => {
        await m.getRepository(FarmerDocument).insert({
          id: docId, farmerId: f.id, docType, fileName: file.originalname.slice(0, 240), mimeType: file.mimetype, sizeBytes: file.size,
          sha256: hash, storagePath, consentGiven: true, uploadedBy: user.id
        });
        if (docType === 'PHOTO') {
          await m.getRepository(Farmer).update({ id: f.id }, { photoUrl: `/api/farmers/${f.id}/documents/${docId}/file` });
        }
        await this.audit.record(user, 'FARMER_DOCUMENT_UPLOADED', f.id, { documentId: docId, docType, sha256: hash, sizeBytes: file.size }, ctx, m);
      });
    } catch (e) {
      await fs.promises.unlink(storagePath).catch(() => undefined);
      throw e;
    }
    return { id: docId, farmerId: f.id, docType, fileName: file.originalname, mimeType: file.mimetype, sizeBytes: file.size, sha256: hash };
  }

  async listDocuments(user: AuthUser, id: string) {
    const f = await this.getScoped(user, id);
    const docs = await this.docRepo.find({ where: { farmerId: f.id }, order: { createdAt: 'ASC' } });
    return docs.map(d => ({
      id: d.id, docType: d.docType, fileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, sha256: d.sha256,
      uploadedAt: stamp(d.createdAt), url: `/api/farmers/${f.id}/documents/${d.id}/file`
    }));
  }

  /** Resolve a stored document for download; every access to sensitive images is audited. */
  async documentFile(user: AuthUser, id: string, docId: string, ctx: RequestContext) {
    const f = await this.getScoped(user, id);
    const d = await this.docRepo.findOne({ where: { id: docId, farmerId: f.id } });
    if (!d) throw Errors.notFound('Document');
    const file = path.resolve(d.storagePath);
    if (!fs.existsSync(file)) throw Errors.notFound('Document file');
    await this.audit.record(user, 'SENSITIVE_DOCUMENT_ACCESSED', f.id, { documentId: d.id, docType: d.docType }, ctx);
    return { path: file, mimeType: d.mimeType, fileName: d.fileName };
  }

  /** Farmers by id list (helper for other modules). */
  findByIds(ids: string[]) {
    return ids.length ? this.repo.find({ where: { id: In(ids), deleted: false } }) : Promise.resolve([]);
  }
}
