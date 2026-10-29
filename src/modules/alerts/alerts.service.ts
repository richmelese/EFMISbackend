import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Alert } from './entities/alert.entity';
import { AlertSeverity, RULES } from '../../common/constants/rules';
import { nowStamp, stamp } from '../../common/utils/helpers';
import { NotificationsService } from '../notifications/notifications.service';
import { DomainEvents } from '../../common/events';
import { OutboxProblem } from '../outbox/outbox.types';

const PMO_STATUS: Record<string, string> = { CRITICAL_RED: 'ESCALATED_TO_PMO', HIGH_ORANGE: 'NOTIFIED_MOA', MEDIUM_YELLOW: 'NORMAL', LOW_BLUE: 'NORMAL' };

export interface RaiseAlertInput {
  severity: AlertSeverity;
  title: string;
  category: string;
  trigger?: string | null;
  affectedArea?: string | null;
  actionRequired?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  /** Same key => no duplicate alert (automated conditions) */
  dedupeKey?: string | null;
  slaHours?: number;
  /** Override the notified roles (default: MoA, plus PMO for CRITICAL; logistics categories go to logistics roles) */
  notifyRoles?: string[];
}

/** Categories handled by the logistics operations team rather than MoA. */
const LOGISTICS_CATEGORIES = ['Logistics', 'Logistics Delays', 'Logistics & Warehousing', 'Fleet & GPS', 'Driver Compliance', 'Inventory', 'Theft/Diversion Risk'];

/** Critical event alerts with SLA tracking (REQ-1.2-006, REQ-INT-005). */
@Injectable()
export class AlertsService implements OnModuleInit {
  constructor(
    @InjectRepository(Alert) readonly repo: Repository<Alert>,
    private readonly notifications: NotificationsService,
    private readonly events: DomainEvents
  ) {}

  onModuleInit() {
    this.events.subscribe(OutboxProblem, (p, m) =>
      this.raise({
        severity: p.kind === 'DEAD' ? 'HIGH_ORANGE' : 'MEDIUM_YELLOW', category: 'Integration', affectedArea: 'Messaging',
        title: p.kind === 'DEAD' ? `Outgoing ${p.channel} messages are failing` : `${p.channel} messages not acknowledged by the receiver`,
        trigger: p.detail, sourceType: 'OUTBOX', sourceId: p.messageId, dedupeKey: p.dedupeKey,
        actionRequired: p.kind === 'DEAD'
          ? 'Check the provider configuration; failed messages stay in outbox_messages (status DEAD)'
          : 'Confirm receipt with the receiving system or resend'
      }, m).then(() => undefined)
    );
  }

  hoursRemaining(deadline: Date | null): number | null {
    if (!deadline) return null;
    return Math.round(((new Date(deadline).getTime() - Date.now()) / 36e5) * 10) / 10;
  }

  /** Frontend shape (EFMIS_DATA.criticalAlerts) + workflow fields */
  toFrontend(r: Alert) {
    const remaining = this.hoursRemaining(r.slaDeadline);
    return {
      id: r.id,
      severity: r.severity,
      title: r.title,
      category: r.category,
      trigger: r.triggerText,
      affectedArea: r.affectedArea,
      slaHoursRemaining: remaining === null ? null : Math.max(remaining, 0),
      slaBreached: remaining !== null && remaining < 0 && !r.resolved,
      pmoNotificationStatus: r.pmoNotificationStatus,
      actionRequired: r.actionRequired,
      timestamp: r.timestamp,
      resolved: r.resolved,
      status: r.status,
      assignedTo: r.assignedTo,
      acknowledgedBy: r.acknowledgedBy,
      acknowledgedAt: stamp(r.acknowledgedAt),
      resolvedBy: r.resolvedBy,
      resolvedAt: stamp(r.resolvedAt),
      resolutionNotes: r.resolutionNotes,
      snoozedUntil: stamp(r.snoozedUntil),
      sourceType: r.sourceType,
      sourceId: r.sourceId
    };
  }

  /** Collision-free ids from the alert_seq sequence (see migration AlertSequence). */
  private async nextId(manager?: EntityManager): Promise<string> {
    const [{ n }] = await (manager ?? this.repo.manager).query(`SELECT nextval('alert_seq') AS n`);
    return `ALT-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
  }

  /** Raise an alert and route notifications per severity (Critical: PMO+MoA via all channels). */
  async raise(input: RaiseAlertInput, manager?: EntityManager) {
    const repo = manager ? manager.getRepository(Alert) : this.repo;
    if (input.dedupeKey) {
      const existing = await repo.findOne({ where: { dedupeKey: input.dedupeKey } });
      if (existing) return { ...this.toFrontend(existing), created: false };
    }
    const hours = input.slaHours ?? RULES.alertSlaHours[input.severity];
    const now = new Date();
    const alert = repo.create({
      id: await this.nextId(manager),
      severity: input.severity,
      title: input.title,
      category: input.category,
      triggerText: input.trigger ?? null,
      affectedArea: input.affectedArea ?? null,
      slaDeadline: new Date(now.getTime() + hours * 36e5),
      pmoNotificationStatus: PMO_STATUS[input.severity],
      actionRequired: input.actionRequired ?? null,
      timestamp: nowStamp(now).slice(0, 16),
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      dedupeKey: input.dedupeKey ?? null
    });
    await repo.save(alert);
    const channels: Array<'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH'> =
      input.severity === 'CRITICAL_RED' ? ['IN_APP', 'EMAIL', 'SMS', 'PUSH'] : input.severity === 'HIGH_ORANGE' ? ['IN_APP', 'EMAIL'] : ['IN_APP'];
    const logistics = LOGISTICS_CATEGORIES.includes(input.category);
    const roles = input.notifyRoles ?? (logistics
      ? (input.severity === 'CRITICAL_RED' ? ['LOGISTICS_MANAGER', 'DISPATCHER', 'PMO'] : ['LOGISTICS_MANAGER', 'DISPATCHER'])
      : (input.severity === 'CRITICAL_RED' ? ['PMO', 'MOA'] : ['MOA']));
    for (const role of roles) {
      await this.notifications.notify({ role, title: `[${input.severity}] ${input.title}`, message: input.trigger || input.title, link: `/alerts/${alert.id}`, channels }, manager);
    }
    return { ...this.toFrontend(alert), created: true };
  }
}
