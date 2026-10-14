import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { Notification } from '../../notifications/entities/notification.entity';
import { HotStateService } from '../jobs/hot-state.service';
import { JobsService, QUEUES } from '../jobs/jobs.service';

export type OutboundChannel = 'EMAIL' | 'SMS' | 'PUSH';

/** What a gateway adapter receives. Real adapters resolve the recipient's address (user / role / unit) themselves. */
export interface OutboundMessage {
  notificationId: number;
  channel: OutboundChannel;
  recipientUserId: string | null;
  recipientRole: string | null;
  recipientUnitId: string | null;
  title: string;
  message: string;
  link: string | null;
}

export interface DeliveryProvider {
  /** Throw to signal a (retryable) delivery failure. */
  send(msg: OutboundMessage): Promise<void>;
}
export type EmailProvider = DeliveryProvider;
export type SmsProvider = DeliveryProvider;
export type PushProvider = DeliveryProvider;

export const EMAIL_PROVIDER = 'LOGISTICS_EMAIL_PROVIDER';
export const SMS_PROVIDER = 'LOGISTICS_SMS_PROVIDER';
export const PUSH_PROVIDER = 'LOGISTICS_PUSH_PROVIDER';

export const NOTIFICATION_DELIVER_JOB = 'deliver';

/** Default adapter until a gateway is configured: logs channel + recipient + title only (never the message body). */
export class LoggingProvider implements DeliveryProvider {
  private readonly logger: Logger;
  constructor(private readonly channel: OutboundChannel) {
    this.logger = new Logger(`Notify:${channel}`);
  }

  async send(msg: OutboundMessage): Promise<void> {
    const recipient = msg.recipientUserId
      ? `user:${msg.recipientUserId}`
      : `role:${msg.recipientRole ?? '-'}${msg.recipientUnitId ? `@${msg.recipientUnitId}` : ''}`;
    this.logger.log(`[${this.channel}] -> ${recipient}: ${msg.title}`);
  }
}

/**
 * Outbound notification delivery (Logistics doc §11 / §18): the notifications table is the outbox; EMAIL / SMS / PUSH rows
 * with deliveredAt IS NULL are enqueued on QUEUES.NOTIFICATIONS with jobId 'notif-<id>' (one job per notification → no
 * duplicate sends; BullMQ retries with exponential backoff, exhausted jobs are dead-lettered). The handler is idempotent:
 * it re-checks deliveredAt before sending and marks the row only if still undelivered.
 */
@Injectable()
export class NotificationDeliveryService implements OnModuleInit {
  private readonly logger = new Logger('NotificationDelivery');
  private sweeping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly jobs: JobsService,
    private readonly hot: HotStateService,
    @InjectRepository(Notification) private readonly notifications: Repository<Notification>,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider
  ) {}

  onModuleInit() {
    this.jobs.register(QUEUES.NOTIFICATIONS, NOTIFICATION_DELIVER_JOB, data => this.deliver(Number((data as { notificationId: number })?.notificationId)));
  }

  @Interval('logistics-notification-delivery', 30_000)
  async tick() {
    if (!this.config.get<boolean>('schedulerEnabled')) return;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(`Notification sweep failed: ${(err as Error)?.message}`);
    }
  }

  /** Enqueue undelivered outbound notifications (max 200 per sweep). Returns the number of jobs dispatched. */
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const pending = await this.notifications.find({
        where: { channel: In(['EMAIL', 'SMS', 'PUSH']), deliveredAt: IsNull() },
        select: { id: true },
        order: { id: 'ASC' },
        take: 200
      });
      let dispatched = 0;
      for (const n of pending) {
        // Throttle re-dispatch of a failing notification (inline mode has no BullMQ jobId de-duplication across sweeps)
        if (!(await this.hot.setOnce(`notif:dispatch:${n.id}`, 300))) continue;
        await this.jobs.dispatch(QUEUES.NOTIFICATIONS, NOTIFICATION_DELIVER_JOB, { notificationId: n.id }, { jobId: `notif-${n.id}` });
        dispatched++;
      }
      return dispatched;
    } finally {
      this.sweeping = false;
    }
  }

  private providerFor(channel: string): DeliveryProvider | null {
    if (channel === 'EMAIL') return this.email;
    if (channel === 'SMS') return this.sms;
    if (channel === 'PUSH') return this.push;
    return null;
  }

  /** Job handler — idempotent. */
  async deliver(notificationId: number): Promise<void> {
    if (!Number.isInteger(notificationId)) return;
    const n = await this.notifications.findOneBy({ id: notificationId });
    if (!n || n.deliveredAt) return;
    const provider = this.providerFor(n.channel);
    if (!provider) return;
    await provider.send({
      notificationId: n.id, channel: n.channel as OutboundChannel, recipientUserId: n.recipientUserId, recipientRole: n.recipientRole,
      recipientUnitId: n.recipientUnitId, title: n.title, message: n.message, link: n.link
    });
    await this.notifications.createQueryBuilder().update(Notification).set({ deliveredAt: new Date() })
      .where('id = :id AND delivered_at IS NULL', { id: n.id }).execute();
  }
}
