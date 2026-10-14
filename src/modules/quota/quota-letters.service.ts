import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { PurchaseOrder, QuotaAllocation, QuotaLetter } from './entities/quota.entities';
import { Region } from '../hierarchy/entities/region.entity';
import { DemandDocument } from '../national/entities/demand-document.entities';
import { Signature } from '../signatures/entities/signature.entity';
import { RULES } from '../../common/constants/rules';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { fmtMT, nowStamp, shortId, stamp } from '../../common/utils/helpers';
import { isNational } from '../../common/utils/scope';
import { AuditService } from '../audit/audit.service';
import { SignaturesService } from '../signatures/signatures.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { AggregationService } from '../aggregation/aggregation.service';
import { NationalFiguresService } from '../aggregation/national-figures.service';
import { CreateLettersDto, CreateProcurementRequestDto, ProcurementStatusDto } from './dto/quota.dto';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** Electronic quota letters (REQ-1.4-006) and automatic procurement requests / POs to EABC (REQ-1.4-010). */
@Injectable()
export class QuotaLettersService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(QuotaLetter) private readonly letters: Repository<QuotaLetter>,
    @InjectRepository(PurchaseOrder) private readonly orders: Repository<PurchaseOrder>,
    @InjectRepository(Region) private readonly regions: Repository<Region>,
    @InjectRepository(DemandDocument) private readonly documents: Repository<DemandDocument>,
    private readonly audit: AuditService,
    private readonly signatures: SignaturesService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly aggregation: AggregationService,
    private readonly figures: NationalFiguresService
  ) {}

  // ---------------- Letters ----------------
  async letterToFrontend(l: QuotaLetter) {
    const sig = l.signatureId ? await this.signatures.findById(l.signatureId) : null;
    return this.letterShape(l, sig);
  }

  private letterShape(l: QuotaLetter, sig: Signature | null) {
    return {
      id: l.id, controlNo: l.controlNo, regionId: l.regionId, season: l.season, status: l.status, content: l.content,
      signature: sig ? { signer: sig.signerName, signedAt: sig.signedAt, hash: `sha256:${sig.signatureHash}` } : null,
      watermark: 'Official Document', createdAt: stamp(l.createdAt), readAt: stamp(l.readAt), acknowledgedAt: stamp(l.acknowledgedAt), acknowledgedBy: l.acknowledgedBy,
      printUrl: `/api/quota/letters/${l.id}/print`
    };
  }

  async createLetters(user: AuthUser, dto: CreateLettersDto, ctx: RequestContext) {
    let regions: Region[];
    if (dto.regionIds?.length) {
      const found = await this.regions.findBy({ id: In(dto.regionIds) });
      regions = dto.regionIds.map(id => found.find(r => r.id === id)).filter((r): r is Region => !!r);
    } else {
      regions = await this.regions.find({ order: { sort: 'ASC' } });
    }
    if (!regions.length) throw Errors.badRequest('No regions selected');
    const season = await this.settings.currentSeason();
    const ids = await this.ds.transaction(async m => {
      const out: string[] = [];
      for (const r of regions) {
        const lines = await m.getRepository(QuotaAllocation).find({ where: { regionId: r.id, parentId: `QA-${r.code}-REGION` }, order: { sort: 'ASC', createdAt: 'ASC' } });
        const count = await m.getRepository(QuotaLetter).count();
        const controlNo = `MOA/QL/${new Date().getFullYear()}/${String(count + 1).padStart(4, '0')}`;
        const q = r.quotaAllocationMt;
        const npsb = Math.round(q * RULES.productSplit.NPSB), urea = Math.round(q * RULES.productSplit.UREA);
        const content = {
          letterhead: 'Federal Democratic Republic of Ethiopia - Ministry of Agriculture', to: `${r.name} Bureau of Agriculture`,
          subject: `Quota Allocation for ${season} Planting Season`,
          introduction: `Following national demand validation and the FTWG consensus, the Ministry hereby communicates the fertilizer quota for ${r.name} for the ${season} season.`,
          totalQuota: { totalMT: q, NPSB: npsb, UREA: urea, OTHER: q - npsb - urea },
          allocationBreakdown: lines.map(l => ({ recipient: l.recipientName, npsbMT: l.npsbMt, ureaMT: l.ureaMt, deliveryWindow: l.deliveryWindow })),
          deliverySchedule: 'Per quota line delivery windows; milestones tracked in EFMIS',
          termsAndConditions: ['Payment through approved bank credit / TeleBirr channels', 'Monthly distribution reporting to MoA', 'ESA quality standards apply; report non-conformance within 24 hours'],
          reminders: ['Acknowledge receipt of this letter in EFMIS', 'Complete downward allocation to PCs before the delivery window'],
          signatory: 'State Minister, Ministry of Agriculture', cc: ['MoA', 'Zone and Woreda Agriculture Offices'],
          footer: 'Confidential - for official use. Queries: National Input Planning Directorate, MoA.'
        };
        const id = shortId('QL');
        const signature = await this.signatures.sign(user, dto, 'QUOTA_LETTER', id, content, m);
        await m.getRepository(QuotaLetter).insert({ id, controlNo, regionId: r.id, season, content: content as any, status: 'DELIVERED', signatureId: signature.id, createdBy: user.name });
        await this.notifications.notify({
          role: 'REGION', unitId: r.id, title: 'Electronic quota letter issued', message: `${controlNo}: ${content.subject}. Please acknowledge receipt.`,
          link: `/quota/letters/${id}`, channels: ['IN_APP', 'EMAIL']
        }, m);
        await this.audit.record(user, 'QUOTA_LETTER_ISSUED', id, { controlNo, regionId: r.id, signatureId: signature.id }, ctx, m);
        out.push(id);
      }
      return out;
    });
    const created: any[] = [];
    for (const id of ids) created.push(await this.letterToFrontend((await this.letters.findOneBy({ id }))!));
    return created;
  }

  async listLetters(user: AuthUser) {
    const rows = await this.letters.find({ where: isNational(user) ? {} : { regionId: user.regionId ?? '' }, order: { createdAt: 'DESC' } });
    const sigIds = rows.map(r => r.signatureId).filter(Boolean) as string[];
    const sigs = sigIds.length ? await this.ds.getRepository(Signature).findBy({ id: In(sigIds) }) : [];
    return rows.map(l => this.letterShape(l, sigs.find(s => s.id === l.signatureId) || null));
  }

  private async letterFor(user: AuthUser, id: string) {
    const l = await this.letters.findOneBy({ id });
    if (!l) throw Errors.notFound('Quota letter');
    if (!isNational(user) && l.regionId !== user.regionId) throw Errors.forbidden();
    return l;
  }

  async getLetter(user: AuthUser, id: string) {
    const l = await this.letterFor(user, id);
    if (user.role === 'REGION' && !l.readAt) {
      await this.letters.update({ id: l.id }, { readAt: new Date(), status: l.status === 'ACKNOWLEDGED' ? l.status : 'READ' });
    }
    return this.letterToFrontend((await this.letters.findOneBy({ id: l.id }))!);
  }

  /** Print-ready HTML rendering of the letter (browser "Save as PDF" for PDF/A archival copies) */
  async printLetter(user: AuthUser, id: string): Promise<string> {
    const l = await this.letterToFrontend(await this.letterFor(user, id));
    const c = l.content || {};
    const tq = c.totalQuota || {};
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(l.controlNo)}</title>
<style>body{font-family:Georgia,serif;max-width:780px;margin:40px auto;color:#111;position:relative}h1{font-size:18px;text-align:center}
.wm{position:fixed;top:40%;left:15%;font-size:72px;color:rgba(0,120,60,.08);transform:rotate(-30deg)}table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:6px;font-size:13px}
.meta{display:flex;justify-content:space-between;font-size:13px}.sig{margin-top:40px;font-size:13px}</style></head><body>
<div class="wm">${esc(l.watermark)}</div><h1>${esc(c.letterhead)}</h1>
<div class="meta"><span>Ref: ${esc(l.controlNo)}</span><span>Date: ${esc(l.createdAt)}</span></div>
<p>To: ${esc(c.to)}</p><p><b>Subject: ${esc(c.subject)}</b></p><p>${esc(c.introduction)}</p>
<table><tr><th>Fertilizer</th><th>Quantity (MT)</th></tr>${['NPSB', 'UREA', 'OTHER'].map(k => `<tr><td>${k}</td><td>${esc(Number(tq[k]).toLocaleString('en-US'))}</td></tr>`).join('')}
<tr><th>Total</th><th>${esc(Number(tq.totalMT).toLocaleString('en-US'))}</th></tr></table>
<h3>Terms and conditions</h3><ul>${(c.termsAndConditions || []).map((t: string) => `<li>${esc(t)}</li>`).join('')}</ul>
<h3>Reminders</h3><ul>${(c.reminders || []).map((t: string) => `<li>${esc(t)}</li>`).join('')}</ul>
<div class="sig">Electronically signed by ${esc(l.signature?.signer)} (${esc(c.signatory)}) on ${esc(l.signature?.signedAt)}<br>Signature: ${esc(l.signature?.hash)}<br>CC: ${esc((c.cc || []).join(', '))}</div>
<p style="font-size:11px;margin-top:30px">${esc(c.footer)}</p></body></html>`;
  }

  async acknowledgeLetter(user: AuthUser, id: string, ctx: RequestContext) {
    const l = await this.letterFor(user, id);
    if (l.status === 'ACKNOWLEDGED') throw Errors.conflict('Letter already acknowledged');
    await this.ds.transaction(async m => {
      const now = new Date();
      await m.getRepository(QuotaLetter).update({ id: l.id }, { status: 'ACKNOWLEDGED', acknowledgedAt: now, acknowledgedBy: user.name, readAt: l.readAt ?? now });
      await this.audit.record(user, 'QUOTA_LETTER_ACKNOWLEDGED', l.id, null, ctx, m);
      await this.notifications.notify({ role: 'MOA', title: 'Quota letter acknowledged', message: `${l.controlNo} acknowledged by ${user.name}` }, m);
    });
    return this.letterToFrontend((await this.letters.findOneBy({ id: l.id }))!);
  }

  // ---------------- Procurement requests / POs (REQ-1.4-010) ----------------
  poToFrontend(p: PurchaseOrder) {
    return {
      id: p.id, controlNo: p.controlNo, season: p.season, status: p.status, priority: p.priority, payload: p.payload, history: p.history || [],
      createdBy: p.createdBy, createdAt: stamp(p.createdAt), updatedAt: stamp(p.updatedAt)
    };
  }

  private latestDocument() {
    return this.documents.findOne({ where: {}, order: { createdAt: 'DESC', version: 'DESC' } });
  }

  async createProcurementRequest(user: AuthUser, dto: CreateProcurementRequestDto, ctx: RequestContext) {
    const priority = dto.priority || 'STANDARD', modality = dto.modality || 'OPEN_BID', override = dto.override ?? false;
    const doc = await this.latestDocument();
    if ((!doc || doc.status !== 'FINAL') && !override) {
      throw Errors.conflict('The national demand document must be FINAL (fully signed) before a procurement request is generated. Use override with a reason for exceptional circumstances.');
    }
    if (override && !dto.overrideReason) throw Errors.badRequest('overrideReason is required for a manual override');
    const net = await this.figures.netImport();
    const summary = await this.aggregation.nationalSummary();
    const season = await this.settings.currentSeason();
    const regions = await this.regions.find({ order: { sort: 'ASC' } });
    const result = await this.ds.transaction(async m => {
      const count = await m.getRepository(PurchaseOrder).count();
      const controlNo = `MOA/PR/${new Date().getFullYear()}/${String(count + 1).padStart(4, '0')}`;
      const payload = {
        documentControlNo: controlNo, season, issuedBy: 'Ministry of Agriculture', to: 'Ethiopian Agricultural Businesses Corporation (EABC)',
        demandDocument: doc ? { id: doc.id, documentNo: doc.docNo, status: doc.status } : null,
        grossNationalDemand: { totalMT: net.grossNationalDemandMT, byFertilizer: summary.byFertilizer },
        netImportRequirement: { totalMT: net.netImportRequirementMT, byFertilizer: net.byFertilizer },
        regionalQuotaSummary: regions.map(r => ({ regionId: r.id, region: r.name, quotaMT: r.quotaAllocationMt })),
        procurementSchedule: net.suggestedProcurementSchedule,
        procurementModality: modality, deliveryPriority: priority,
        qualitySpecifications: 'ESA Standard ES 684:2024; ECAE pre-shipment & destination inspection mandatory',
        termsAndConditions: ['Payment via LC through CBE', 'Delivery DAP Djibouti / Mojo dry port', 'Quality claims per ESA standards'],
        contact: 'MoA National Input Planning Directorate - procurement@moa.gov.et',
        manualOverride: override ? { reason: dto.overrideReason, by: user.name } : null
      };
      const id = shortId('PO');
      const signature = await this.signatures.sign(user, dto, 'PROCUREMENT_REQUEST', id, payload, m);
      const at = nowStamp();
      await m.getRepository(PurchaseOrder).insert({
        id, controlNo, season, payload: payload as any, status: 'SENT', priority,
        history: [{ status: 'GENERATED', at, by: user.name }, { status: 'SENT', at, by: 'EFMIS → EABC API' }], signatureId: signature.id, createdBy: user.name
      });
      await this.audit.record(user, 'PROCUREMENT_REQUEST_TRANSMITTED', id, { controlNo, netImportMT: net.netImportRequirementMT, signatureId: signature.id }, ctx, m);
      await this.notifications.notify({
        role: 'EABC', title: 'New procurement request from MoA', message: `${controlNo}: net import ${fmtMT(net.netImportRequirementMT)} (${priority})`,
        link: `/procurement/requests/${id}`, channels: ['IN_APP', 'EMAIL']
      }, m);
      return { id, signature };
    });
    return { ...this.poToFrontend((await this.orders.findOneBy({ id: result.id }))!), signature: result.signature, message: 'Automatic Purchase Order generated & transmitted to EABC!' };
  }

  async listProcurementRequests() {
    return (await this.orders.find({ order: { createdAt: 'DESC' } })).map(p => this.poToFrontend(p));
  }

  async getProcurementRequest(id: string) {
    const p = await this.orders.findOneBy({ id });
    if (!p) throw Errors.notFound('Procurement request');
    return this.poToFrontend(p);
  }

  /** EABC acknowledgement workflow */
  async updateProcurementStatus(user: AuthUser, id: string, dto: ProcurementStatusDto, ctx: RequestContext) {
    const p = await this.orders.findOneBy({ id });
    if (!p) throw Errors.notFound('Procurement request');
    if (dto.status === 'CLARIFICATION_REQUESTED' && !dto.note) throw Errors.badRequest('Describe the clarification needed');
    await this.ds.transaction(async m => {
      const history = [...(p.history || []), { status: dto.status, at: nowStamp(), by: user.name, note: dto.note || null }];
      await m.getRepository(PurchaseOrder).update({ id: p.id }, { status: dto.status, history });
      await this.audit.record(user, `PROCUREMENT_REQUEST_${dto.status}`, p.id, { note: dto.note }, ctx, m);
      await this.notifications.notify({
        role: 'MOA', title: `EABC: procurement request ${dto.status.toLowerCase().replace('_', ' ')}`, message: `${p.controlNo}${dto.note ? ': ' + dto.note : ''}`
      }, m);
    });
    return this.poToFrontend((await this.orders.findOneBy({ id: p.id }))!);
  }
}
