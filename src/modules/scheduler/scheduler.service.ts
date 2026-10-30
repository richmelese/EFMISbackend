import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Farmer } from '../farmers/entities/farmer.entity';
import { DemandDocument, DocumentSignature } from '../national/entities/demand-document.entities';
import { PurchaseOrder, QuotaLetter } from '../quota/entities/quota.entities';
import { daysSince, nowStamp, parseStamp, stamp } from '../../common/utils/helpers';
import { AlertsService } from '../alerts/alerts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { AuthService } from '../auth/auth.service';
import { WorkflowService } from '../workflow/workflow.service';
import { OutboxService } from '../outbox/outbox.service';
import { StorageService } from '../storage/storage.service';

export interface SchedulerSummary {
  kebeleEscalations: number;
  reminders: number;
  signatureEscalations: number;
  letterReminders: number;
  poEscalations: number;
  slaEscalations: number;
  unsnoozed: number;
  workflowReminders: number;
  workflowEscalations: number;
  outboxAckOverdue: number;
  storageRetentionApplied: number;
}

const age = (d: Date | string) => daysSince(typeof d === 'string' ? parseStamp(d) : d);

/**
 * Periodic workflow job: reminders, escalations and SLA tracking.
 *  - REQ-1.1-007: kebele records pending > N days escalate woreda -> zone -> region; daily reminders from day 3
 *  - REQ-1.3-005: signature reminders after 2 days, escalation after 5 days
 *  - REQ-1.4-006: quota letter acknowledgement reminders / escalation
 *  - REQ-1.4-010: escalate if EABC has not acknowledged a procurement request within 48 h
 *  - REQ-INT-005: unacknowledged Critical/High alerts past SLA escalate to PMO; snoozed alerts re-open
 *  - workflow cases past due_at: escalation / reminders as their definition says (WorkflowService.processDeadlines)
 * Reminder/escalation notifications go out once per day; alerts are de-duplicated by dedupeKey.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private running = false;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(Farmer) private readonly farmers: Repository<Farmer>,
    @InjectRepository(DemandDocument) private readonly documents: Repository<DemandDocument>,
    @InjectRepository(DocumentSignature) private readonly docSignatures: Repository<DocumentSignature>,
    @InjectRepository(QuotaLetter) private readonly letters: Repository<QuotaLetter>,
    @InjectRepository(PurchaseOrder) private readonly purchaseOrders: Repository<PurchaseOrder>,
    private readonly alerts: AlertsService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly auth: AuthService,
    private readonly workflow: WorkflowService,
    private readonly outbox: OutboxService,
    private readonly storage: StorageService
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'efmis-workflow-scheduler' })
  async tick() {
    if (!this.config.get<boolean>('schedulerEnabled')) return;
    if (this.running) return;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(`Scheduler run failed: ${(err as Error)?.message}`, (err as Error)?.stack);
    }
  }

  async runOnce(): Promise<SchedulerSummary> {
    this.running = true;
    try {
      return await this.execute();
    } finally {
      this.running = false;
    }
  }

  private async execute(): Promise<SchedulerSummary> {
    const summary: SchedulerSummary = { kebeleEscalations: 0, reminders: 0, signatureEscalations: 0, letterReminders: 0, poEscalations: 0, slaEscalations: 0, unsnoozed: 0, workflowReminders: 0, workflowEscalations: 0, outboxAckOverdue: 0, storageRetentionApplied: 0 };
    const escalationDays = Number(await this.settings.get('kebeleEscalationDays', this.config.get<number>('kebeleEscalationDays') ?? 7)) || 7;
    const today = nowStamp().slice(0, 10);
    const lastRun = await this.settings.get<any>('schedulerLastRun', null);
    const daily = !lastRun || lastRun.date !== today;

    // ---- Kebele pending approvals (REQ-1.1-007)
    const pendingByKebele: Array<{ kebeleId: string; kebele: string; woredaId: string; zoneId: string; regionId: string; oldest: Date; n: string }> =
      await this.farmers.createQueryBuilder('f')
        .select('f.kebeleId', 'kebeleId').addSelect('MIN(f.kebele)', 'kebele').addSelect('MIN(f.woredaId)', 'woredaId')
        .addSelect('MIN(f.zoneId)', 'zoneId').addSelect('MIN(f.regionId)', 'regionId')
        .addSelect('MIN(f.createdAt)', 'oldest').addSelect('COUNT(*)', 'n')
        .where('f.deleted = false').andWhere(`f.approvalLevel = 'Pending Kebele Review'`)
        .groupBy('f.kebeleId').getRawMany();
    for (const k of pendingByKebele) {
      const days = age(k.oldest);
      const n = Number(k.n);
      if (days >= 3 && daily) {
        await this.notifications.notify({ role: 'KEBELE', unitId: k.kebeleId, title: 'Reminder: pending approvals', message: `${n} farmer demand record(s) in ${k.kebele} awaiting review (oldest ${Math.floor(days)} days)`, channels: ['IN_APP', 'EMAIL'] });
        summary.reminders++;
      }
      if (days >= escalationDays) {
        const tier = days >= escalationDays * 3 ? 'REGION' : days >= escalationDays * 2 ? 'ZONE' : 'WOREDA';
        const unit = { WOREDA: k.woredaId, ZONE: k.zoneId, REGION: k.regionId }[tier];
        if (daily) await this.notifications.notify({ role: tier, unitId: unit, title: `Escalation: ${k.kebele} approvals overdue`, message: `${n} record(s) pending for ${Math.floor(days)} days`, channels: ['IN_APP', 'EMAIL'] });
        await this.alerts.raise({
          severity: 'MEDIUM_YELLOW', title: `Kebele approvals overdue in ${k.kebele}`, category: 'Pending Approvals', trigger: `${n} record(s) pending > ${escalationDays} days`,
          affectedArea: k.kebele, actionRequired: `Escalated to ${tier}`, sourceType: 'KEBELE', sourceId: k.kebeleId, dedupeKey: `KEB-OVERDUE-${k.kebeleId}-${tier}`
        });
        summary.kebeleEscalations++;
      }
    }

    // ---- Demand document signatures (REQ-1.3-005)
    const signing = await this.documents.find({ where: { status: 'SIGNING' } });
    for (const d of signing) {
      const sigs = await this.docSignatures.find({ where: { documentId: d.id }, order: { step: 'ASC' } });
      const next = sigs.find(s => s.status === 'PENDING');
      if (!next) continue;
      const prevSigned = sigs.filter(s => s.status === 'SIGNED' && s.signedAt).map(s => s.signedAt as string).sort().pop();
      const days = age(prevSigned || d.createdAt);
      if (days >= 2 && daily) {
        await this.notifications.notify({ role: next.role, title: 'Reminder: signature pending', message: `${d.docNo} awaits the ${next.title} signature`, channels: ['IN_APP', 'EMAIL'] });
        summary.reminders++;
      }
      if (days >= 5) {
        await this.alerts.raise({
          severity: 'HIGH_ORANGE', title: `Demand document signature overdue (${next.title})`, category: 'Governance', trigger: `${d.docNo} pending ${Math.floor(days)} days`,
          affectedArea: 'National', sourceType: 'DOCUMENT', sourceId: d.id, dedupeKey: `DOC-SIG-${d.id}-${next.step}`
        });
        summary.signatureEscalations++;
      }
    }

    // ---- Quota letters not acknowledged (REQ-1.4-006)
    const letters = await this.letters.createQueryBuilder('l').where(`l.status != 'ACKNOWLEDGED'`).getMany();
    for (const l of letters) {
      const days = age(l.createdAt);
      if (days >= 2 && daily) {
        await this.notifications.notify({ role: 'REGION', unitId: l.regionId, title: 'Reminder: acknowledge quota letter', message: `${l.controlNo} has not been acknowledged`, channels: ['IN_APP', 'SMS'] });
        summary.letterReminders++;
      }
      if (days >= 5 && daily) {
        await this.notifications.notify({ role: 'MOA', title: 'Quota letter unacknowledged', message: `${l.controlNo} (${l.regionId}) unacknowledged for ${Math.floor(days)} days` });
      }
    }

    // ---- Procurement requests without EABC acknowledgement within 48 h (REQ-1.4-010)
    for (const p of await this.purchaseOrders.find({ where: { status: In(['SENT', 'RECEIVED']) } })) {
      if (age(p.createdAt) >= 2) {
        await this.alerts.raise({
          severity: 'HIGH_ORANGE', title: `EABC has not acknowledged procurement request ${p.controlNo}`, category: 'Procurement', trigger: `Sent ${stamp(p.createdAt)}`,
          affectedArea: 'National procurement', actionRequired: 'Follow up with EABC; use fallback manual transmission if API failed', sourceType: 'PO', sourceId: p.id,
          dedupeKey: `PO-ACK-${p.id}`
        });
        summary.poEscalations++;
      }
    }

    // ---- Alert SLA escalation & snooze expiry (REQ-INT-005)
    const now = new Date();
    for (const a of await this.alerts.repo.find({ where: { resolved: false } })) {
      const remaining = this.alerts.hoursRemaining(a.slaDeadline);
      if (remaining !== null && remaining < 0 && !a.acknowledgedAt && ['CRITICAL_RED', 'HIGH_ORANGE'].includes(a.severity) && a.pmoNotificationStatus !== 'ESCALATED_TO_PMO') {
        await this.alerts.repo.update({ id: a.id }, { pmoNotificationStatus: 'ESCALATED_TO_PMO' });
        await this.notifications.notify({ role: 'PMO', title: `SLA breached: ${a.title}`, message: `${a.id} not acknowledged within SLA`, channels: ['IN_APP', 'EMAIL', 'SMS'] });
        summary.slaEscalations++;
      }
      if (a.status === 'SNOOZED' && a.snoozedUntil && new Date(a.snoozedUntil) <= now) {
        await this.alerts.repo.update({ id: a.id }, { status: 'OPEN', snoozedUntil: null });
        summary.unsnoozed++;
      }
    }

    // ---- Workflow cases past their deadline: escalation up the unit chain, or daily reminders
    const wf = await this.workflow.processDeadlines(now);
    summary.workflowReminders = wf.reminders;
    summary.workflowEscalations = wf.escalations;

    // ---- Outgoing messages whose receiver has not acknowledged in time
    summary.outboxAckOverdue = await this.outbox.checkAckOverdue(now);

    // ---- Write-once retention for uploads whose immediate attempt failed
    summary.storageRetentionApplied = (await this.storage.applyPendingRetention()).applied;

    // ---- Housekeeping: expired revoked tokens and OTP codes
    await this.auth.purgeExpired();
    await this.settings.set('schedulerLastRun', { at: nowStamp(), date: today, summary }, 'scheduler');
    return summary;
  }
}
