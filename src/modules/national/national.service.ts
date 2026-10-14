import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { FtwgActionItem, FtwgSession, FtwgVote } from './entities/ftwg.entities';
import { DemandDocument, DocumentSignature } from './entities/demand-document.entities';
import { User } from '../users/entities/user.entity';
import { RULES } from '../../common/constants/rules';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { nowStamp, sha256, stamp, toCsv } from '../../common/utils/helpers';
import { AuditService } from '../audit/audit.service';
import { SignaturesService, SignatureCredentials } from '../signatures/signatures.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CommentsService } from '../comments/comments.service';
import { SettingsService } from '../settings/settings.service';
import { AggregationService } from '../aggregation/aggregation.service';
import { CarryOverUpdate, NationalFiguresService } from '../aggregation/national-figures.service';
import { CreateActionItemDto, CreateFtwgSessionDto } from './dto/national.dto';

/** pg advisory lock key serialising demand-document generation (count-based numbering). */
const DOC_NUMBER_LOCK = 4_242_013;

/**
 * Re-order object keys the way PostgreSQL jsonb stores them (shorter keys first, then bytewise), recursively.
 * The content hash is computed over this form so that it can be recomputed from the jsonb value read back.
 */
function jsonbOrder(value: any): any {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => {
      const la = Buffer.byteLength(a), lb = Buffer.byteLength(b);
      return la !== lb ? la - lb : Buffer.compare(Buffer.from(a), Buffer.from(b));
    });
    const out: Record<string, any> = {};
    for (const k of keys) if (value[k] !== undefined) out[k] = jsonbOrder(value[k]);
    return out;
  }
  return value;
}

const contentHashOf = (content: unknown) => 'sha256:' + sha256(content);

/** National validation & demand finalisation (REQ-1.3-001..005): FTWG review and the formal demand document. */
@Injectable()
export class NationalService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly audit: AuditService,
    private readonly signatures: SignaturesService,
    private readonly notifications: NotificationsService,
    private readonly comments: CommentsService,
    private readonly settings: SettingsService,
    private readonly aggregation: AggregationService,
    private readonly figures: NationalFiguresService
  ) {}

  private m(manager?: EntityManager): EntityManager {
    return manager ?? this.ds.manager;
  }

  // ---------------------------------------------------------------- summary / figures
  async summary(user: AuthUser) {
    const latest = await this.ds.getRepository(FtwgSession).find({ order: { createdAt: 'DESC', id: 'DESC' }, take: 1 });
    return {
      national: await this.aggregation.nationalSummary(),
      netImport: await this.figures.netImport(),
      carryOverStocks: await this.figures.carryOver(),
      ftwg: latest[0] ? await this.ftwgSession(latest[0].id, user) : null,
      demandDocument: await this.latestDocument()
    };
  }

  grossDemand() {
    return this.aggregation.nationalSummary();
  }

  netImport() {
    return this.figures.netImport();
  }

  carryOver() {
    return this.figures.carryOver();
  }

  async updateCarryOver(user: AuthUser, type: string, changes: CarryOverUpdate, ctx: RequestContext) {
    await this.ds.transaction(async m => {
      const result = await this.figures.updateCarryOver(user, type, changes, m);
      await this.audit.record(user, 'CARRY_OVER_ADJUSTED', type, { old: result.before, new: result.after, reason: changes.justification }, ctx, m);
    });
    return { ...(await this.figures.carryOver()), netImport: await this.figures.netImport() };
  }

  /** Machine-readable / Excel export of the national demand. Returns either CSV text or the JSON body. */
  async exportNational(user: AuthUser, format: string | undefined, ctx: RequestContext): Promise<{ csv: string; filename: string } | Record<string, any>> {
    const s = await this.aggregation.nationalSummary();
    await this.audit.record(user, 'DATA_EXPORT', 'NATIONAL_DEMAND', { format: format || 'json' }, ctx);
    if (format === 'csv') {
      const S = RULES.productSplit;
      const rows: unknown[][] = s.regions.map(r => [r.name, r.demandMT, r.sharePercent, Math.round(r.demandMT * S.NPSB), Math.round(r.demandMT * S.UREA), r.approvalStatus]);
      rows.push([`Exported ${nowStamp()} by ${user.name}`]);
      return {
        filename: `efmis-national-demand-${nowStamp().slice(0, 10)}.csv`,
        csv: toCsv(['Region', 'Demand (MT)', 'Share %', 'NPSB (MT)', 'Urea (MT)', 'Approval Status'], rows)
      };
    }
    return { exportedAt: nowStamp(), exportedBy: user.name, ...s };
  }

  // ---------------------------------------------------------------- FTWG collaborative review (REQ-1.3-003)
  async ftwgSession(id: string, user?: AuthUser, manager?: EntityManager): Promise<any> {
    const m = this.m(manager);
    const s = await m.getRepository(FtwgSession).findOneBy({ id });
    if (!s) throw Errors.notFound('FTWG session');
    const votes = await m.getRepository(FtwgVote).find({ where: { sessionId: id }, order: { createdAt: 'ASC' } });
    const users = votes.length ? await m.getRepository(User).find({ where: { id: In(votes.map(v => v.userId)) } }) : [];
    const nameOf = (uid: string) => users.find(u => u.id === uid)?.fullName ?? uid;
    const count = (v: string) => votes.filter(x => x.vote === v).length;
    const mine = user ? votes.find(v => v.userId === user.id) : undefined;
    const items = await m.getRepository(FtwgActionItem).find({ where: { sessionId: id }, order: { id: 'ASC' } });
    return {
      id: s.id, title: s.title, agenda: s.agenda, status: s.status, decision: s.decision,
      createdAt: stamp(s.createdAt), closedAt: stamp(s.closedAt),
      inFavor: s.baseInFavor + count('FAVOR'),
      opposed: s.baseOpposed + count('OPPOSE'),
      abstain: s.baseAbstain + count('ABSTAIN'),
      voted: !!mine,
      myVote: mine ? mine.vote : null,
      votes: votes.map(v => ({ member: nameOf(v.userId), vote: v.vote, comment: v.comment, at: stamp(v.createdAt) })),
      comments: await this.comments.list('FTWG', id),
      actionItems: items.map(a => ({ id: a.id, description: a.description, assignee: a.assignee, dueDate: a.dueDate, status: a.status }))
    };
  }

  async listSessions(user: AuthUser) {
    const rows = await this.ds.getRepository(FtwgSession).find({ select: { id: true }, order: { createdAt: 'DESC', id: 'DESC' } });
    const out: any[] = [];
    for (const r of rows) out.push(await this.ftwgSession(r.id, user));
    return out;
  }

  async createSession(user: AuthUser, dto: CreateFtwgSessionDto, ctx: RequestContext) {
    const id = `FTWG-SESSION-${Date.now().toString(36).toUpperCase()}`;
    await this.ds.transaction(async m => {
      await m.getRepository(FtwgSession).insert({ id, title: dto.title, agenda: dto.agenda || null });
      await this.audit.record(user, 'FTWG_SESSION_OPENED', id, null, ctx, m);
    });
    return this.ftwgSession(id, user);
  }

  async castVote(user: AuthUser, sessionId: string, vote: string, comment: string | undefined, ctx: RequestContext) {
    await this.ds.transaction(async m => {
      const s = await m.getRepository(FtwgSession).createQueryBuilder('s').setLock('pessimistic_write').where('s.id = :id', { id: sessionId }).getOne();
      if (!s) throw Errors.notFound('FTWG session');
      if (s.status !== 'OPEN') throw Errors.conflict('Voting is closed for this session');
      if (await m.getRepository(FtwgVote).existsBy({ sessionId, userId: user.id })) throw Errors.conflict('You have already voted in this session');
      await m.getRepository(FtwgVote).insert({ sessionId, userId: user.id, vote, comment: comment || null });
      await this.audit.record(user, 'FTWG_VOTE_CAST', sessionId, { vote }, ctx, m);
    });
    return { ...(await this.ftwgSession(sessionId, user)), message: `Vote [${vote}] successfully recorded in FTWG consensus ledger!` };
  }

  async closeSession(user: AuthUser, sessionId: string, decision: string | undefined, ctx: RequestContext) {
    await this.ds.transaction(async m => {
      await m.getRepository(FtwgSession).createQueryBuilder('s').setLock('pessimistic_write').where('s.id = :id', { id: sessionId }).getOne();
      const s = await this.ftwgSession(sessionId, user, m);
      if (s.status !== 'OPEN') throw Errors.conflict('Session already closed');
      const outcome = decision || (s.inFavor > s.opposed ? 'CONSENSUS_REACHED: national demand endorsed' : 'NO_CONSENSUS: returned to MoA for revision');
      await m.getRepository(FtwgSession).update({ id: sessionId }, { status: 'CLOSED', decision: outcome, closedAt: new Date() });
      await this.audit.record(user, 'CONSENSUS_VOTE_CLOSED', sessionId, { decision: outcome, inFavor: s.inFavor, opposed: s.opposed }, ctx, m);
    });
    return this.ftwgSession(sessionId, user);
  }

  /** Auto-generated meeting minutes */
  async minutes(sessionId: string) {
    const s = await this.ftwgSession(sessionId);
    const lines = [
      `MINUTES - ${s.title}`,
      `Session: ${s.id} | Status: ${s.status} | Opened: ${s.createdAt}${s.closedAt ? ' | Closed: ' + s.closedAt : ''}`,
      `Agenda: ${s.agenda || '-'}`,
      '',
      `Vote tally: In favour ${s.inFavor} | Opposed ${s.opposed} | Abstain ${s.abstain}`,
      ...s.votes.map((v: any) => `  - ${v.member}: ${v.vote}${v.comment ? ' ("' + v.comment + '")' : ''} at ${v.at}`),
      '',
      'Discussion:',
      ...s.comments.map((c: any) => `  [${c.createdAt}] ${c.author}: ${c.text}`),
      '',
      'Action items:',
      ...(s.actionItems.length
        ? s.actionItems.map((a: any) => `  - ${a.description} (owner: ${a.assignee || 'TBD'}, due ${a.dueDate || 'TBD'}, ${a.status})`)
        : ['  - none recorded']),
      '',
      `Decision: ${s.decision || 'Pending'}`
    ];
    return { sessionId, generatedAt: nowStamp(), text: lines.join('\n') };
  }

  async addActionItem(user: AuthUser, sessionId: string, dto: CreateActionItemDto, ctx: RequestContext) {
    await this.ds.transaction(async m => {
      if (!(await m.getRepository(FtwgSession).existsBy({ id: sessionId }))) throw Errors.notFound('FTWG session');
      const saved = await m.getRepository(FtwgActionItem).save(m.getRepository(FtwgActionItem).create({
        sessionId, description: dto.description, assignee: dto.assignee || null, dueDate: dto.dueDate || null
      }));
      await this.audit.record(user, 'FTWG_ACTION_ITEM_CREATED', sessionId, { actionItemId: saved.id }, ctx, m);
    });
    return this.ftwgSession(sessionId, user);
  }

  async updateActionItem(user: AuthUser, itemId: number, status: string, ctx: RequestContext) {
    const sessionId = await this.ds.transaction(async m => {
      const item = await m.getRepository(FtwgActionItem).findOneBy({ id: itemId });
      if (!item) throw Errors.notFound('Action item');
      await m.getRepository(FtwgActionItem).update({ id: item.id }, { status });
      await this.audit.record(user, 'FTWG_ACTION_ITEM_UPDATED', item.sessionId, { actionItemId: item.id, old: { status: item.status }, new: { status } }, ctx, m);
      return item.sessionId;
    });
    return this.ftwgSession(sessionId, user);
  }

  // ---------------------------------------------------------------- formal demand document (REQ-1.3-005)
  async docToFrontend(doc: DemandDocument, manager?: EntityManager): Promise<any> {
    const sigs = await this.m(manager).getRepository(DocumentSignature).find({ where: { documentId: doc.id }, order: { step: 'ASC' } });
    const signatories: any[] = [];
    for (const s of sigs) {
      const sig = s.signatureId ? await this.signatures.findById(s.signatureId) : null;
      signatories.push({
        step: s.step, title: s.title, role: s.role, name: s.signerName, signed: s.status === 'SIGNED', status: s.status,
        date: s.signedAt, hash: sig ? `sha256:${sig.signatureHash.slice(0, 8)}...` : null, signatureId: s.signatureId, comments: s.comments
      });
    }
    const next = sigs.find(s => s.status === 'PENDING');
    return {
      id: doc.id, documentNo: doc.docNo, season: doc.season, version: doc.version, status: doc.status,
      watermark: doc.status === 'FINAL' ? 'Official Document' : 'Draft',
      contentHash: doc.contentHash, createdAt: stamp(doc.createdAt), finalizedAt: doc.finalizedAt,
      content: doc.content ?? {},
      signatories,
      verificationCode: `VERIFY-MOA-${doc.docNo}`,
      nextSignatory: next ? { step: next.step, title: next.title } : null
    };
  }

  async listDocuments() {
    const docs = await this.ds.getRepository(DemandDocument).find({ order: { createdAt: 'DESC', id: 'DESC' } });
    const out: any[] = [];
    for (const d of docs) out.push(await this.docToFrontend(d));
    return out;
  }

  async latestDocument(): Promise<any | null> {
    const docs = await this.ds.getRepository(DemandDocument).find({ order: { createdAt: 'DESC', id: 'DESC' }, take: 1 });
    return docs[0] ? this.docToFrontend(docs[0]) : null;
  }

  async getDocument(user: AuthUser, id: string, ctx: RequestContext) {
    const d = await this.ds.getRepository(DemandDocument).findOneBy({ id });
    if (!d) throw Errors.notFound('Demand document');
    await this.audit.record(user, 'DOCUMENT_ACCESSED', d.id, null, ctx);
    return this.docToFrontend(d);
  }

  async createDocument(user: AuthUser, ctx: RequestContext) {
    const meta = await this.settings.get<any>('systemMetadata', {});
    const summary = await this.aggregation.nationalSummary();
    const net = await this.figures.netImport();
    const id = await this.ds.transaction(async m => {
      await m.query('SELECT pg_advisory_xact_lock($1)', [DOC_NUMBER_LOCK]);
      const docs = m.getRepository(DemandDocument);
      const open = await docs.findOne({ where: { status: 'SIGNING' }, select: { id: true } });
      if (open) throw Errors.conflict(`Document ${open.id} is still in the signing workflow`);
      const year = new Date().getFullYear();
      const count = await docs.count();
      const docNo = `MOA/DEMAND/${year}/${String(count + 1).padStart(4, '0')}`;
      const version = (await docs.countBy({ season: meta.currentSeason })) + 1;
      const content = jsonbOrder({
        title: `Formal National Fertilizer Demand Approval - ${meta.currentSeason}`,
        letterhead: 'Federal Democratic Republic of Ethiopia - Ministry of Agriculture',
        nationalDemand: { grossMT: summary.grossNationalDemandMT, byFertilizer: summary.byFertilizer, bySeason: summary.bySeason },
        regionalBreakdown: summary.regions,
        netImportRequirement: net,
        supportingEvidence: ['NSIS soil overlay analysis', '5-year uptake trend analysis', 'FTWG consensus session minutes'],
        procurementSchedule: net.suggestedProcurementSchedule,
        proclamation: meta.proclamationRef ?? null
      });
      const docId = count === 0 ? `DOC-DEMAND-${year}-FINAL` : `DOC-DEMAND-${year}-${String(count + 1).padStart(3, '0')}`;
      await docs.insert({
        id: docId, docNo, season: meta.currentSeason, version, status: 'SIGNING', content, contentHash: contentHashOf(content), createdBy: user.id || null
      });
      await m.getRepository(DocumentSignature).insert(RULES.demandDocumentSigningOrder.map(s => ({ documentId: docId, step: s.step, role: s.role, title: s.title, status: 'PENDING' })));
      await this.audit.record(user, 'DEMAND_DOCUMENT_GENERATED', docId, { documentNo: docNo, version }, ctx, m);
      await this.notifications.notify({
        role: 'FTWG', title: 'Demand document awaiting your signature', message: `${docNo} is ready for FTWG Chair signature`,
        link: `/national/documents/${docId}`, channels: ['IN_APP', 'EMAIL']
      }, m);
      return docId;
    });
    return this.docToFrontend((await this.ds.getRepository(DemandDocument).findOneBy({ id }))!);
  }

  /** Sequential signing FTWG Chair -> ATI DG -> MoA State Minister; `reject` returns the document for revision. */
  async signDocument(user: AuthUser, docId: string, cred: SignatureCredentials | null, ctx: RequestContext, opts: { reject?: boolean; comments?: string } = {}) {
    await this.ds.transaction(async m => {
      const d = await m.getRepository(DemandDocument).createQueryBuilder('d').setLock('pessimistic_write').where('d.id = :id', { id: docId }).getOne();
      if (!d) throw Errors.notFound('Demand document');
      if (d.status !== 'SIGNING') throw Errors.conflict(`Document is ${d.status}; it cannot be signed`);
      const sigRepo = m.getRepository(DocumentSignature);
      const steps = await sigRepo.find({ where: { documentId: docId }, order: { step: 'ASC' } });
      const pending = steps.find(s => s.status === 'PENDING');
      if (!pending) throw Errors.conflict('All signatures already collected');
      if (pending.role !== user.role) throw Errors.forbidden(`Next signatory is the ${pending.title} (role ${pending.role}); signing is sequential`);

      if (opts.reject) {
        if (!opts.comments) throw Errors.badRequest('Comments are required when rejecting the document');
        await sigRepo.update({ documentId: docId, step: pending.step }, { status: 'REJECTED', signerName: user.name, userId: user.id, signedAt: nowStamp(), comments: opts.comments });
        await m.getRepository(DemandDocument).update({ id: docId }, { status: 'REJECTED' });
        await this.audit.record(user, 'DEMAND_DOCUMENT_REJECTED', d.id, { step: pending.step, comments: opts.comments }, ctx, m);
        await this.notifications.notify({ role: 'MOA', title: 'Demand document returned for revision', message: `${user.name} rejected ${d.docNo}: ${opts.comments}` }, m);
        return;
      }

      const sig = await this.signatures.sign(user, cred, 'DEMAND_DOCUMENT', docId, { contentHash: d.contentHash, step: pending.step }, m);
      const nextStep = steps.find(s => s.status === 'PENDING' && s.step > pending.step);
      const isLast = !nextStep;
      const signedAt = nowStamp().slice(0, 16);
      await sigRepo.update({ documentId: docId, step: pending.step }, { status: 'SIGNED', signerName: user.name, userId: user.id, signatureId: sig.id, signedAt });
      if (isLast) await m.getRepository(DemandDocument).update({ id: docId }, { status: 'FINAL', finalizedAt: signedAt });
      await this.audit.record(user, isLast ? 'DIGITAL_SIGNATURE_APPLIED' : 'DOC_CO_SIGNATURE', d.id, { step: pending.step, signatureId: sig.id }, ctx, m);
      if (isLast) {
        await this.notifications.notify({ role: 'EABC', title: 'National demand finalised', message: `${d.docNo} signed by all signatories. Procurement request will follow.`, channels: ['IN_APP', 'EMAIL'] }, m);
        await this.notifications.notify({ role: 'REGION', title: 'National demand finalised', message: `${d.docNo} is now official.` }, m);
      } else {
        await this.notifications.notify({ role: nextStep.role, title: 'Demand document awaiting your signature', message: `${d.docNo} requires the ${nextStep.title} signature`, channels: ['IN_APP', 'EMAIL'] }, m);
      }
    });
    return this.docToFrontend((await this.ds.getRepository(DemandDocument).findOneBy({ id: docId }))!);
  }

  /** Tamper-evident verification (the QR verification code resolves here). */
  async verifyDocument(id: string) {
    const d = await this.ds.getRepository(DemandDocument).findOneBy({ id });
    if (!d) throw Errors.notFound('Demand document');
    // jsonb does not preserve key order: accept the hash of the stored form or of its jsonb-canonical form
    const contentIntact = [d.content, jsonbOrder(d.content)].some(c => contentHashOf(c) === d.contentHash);
    const sigs = await this.ds.getRepository(DocumentSignature).find({ where: { documentId: d.id }, order: { step: 'ASC' } });
    const signatures: any[] = [];
    for (const s of sigs) {
      signatures.push({
        step: s.step, title: s.title, signer: s.signerName, status: s.status,
        verification: s.signatureId ? await this.signatures.verify(s.signatureId, { contentHash: d.contentHash, step: s.step }) : null
      });
    }
    return {
      documentId: d.id, documentNo: d.docNo, status: d.status, contentIntact, signatures,
      valid: contentIntact && signatures.every(s => s.status !== 'SIGNED' || !!s.verification?.valid)
    };
  }
}
