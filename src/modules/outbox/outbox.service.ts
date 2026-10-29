import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { DataSource, EntityManager, LessThan, Repository } from 'typeorm';
import { Errors } from '../../common/utils/errors';
import { nowStamp, shortId } from '../../common/utils/helpers';
import { DomainEvents } from '../../common/events';
import { LoggingStubAdapter } from './adapters/stub.adapters';
import { OutboxMessage } from './entities/outbox-message.entity';
import { backoffMs, ChannelAdapter, DEFAULT_MAX_ATTEMPTS, OutboxChannel, OutboxMessageInput, OutboxProblem } from './outbox.types';

const QUEUE = 'outbox';
/** A claimed message is invisible to other relays for this long (crash safety: it is retried afterwards). */
const LEASE_MS = 5 * 60_000;
const BATCH = 100;

/**
 * Transactional outbox (architecture rule 4). Producers call `enqueue(msg, m)` inside their business transaction, so
 * a message exists exactly when the change commits. A relay claims due rows and delivers them through the channel's
 * adapter with exponential back-off, then DEAD after maxAttempts (OutboxProblem event → alert, per channel per day).
 *  - REDIS_URL set   → the relay hands claimed ids to a BullMQ worker (concurrency, multiple API instances).
 *  - REDIS_URL empty → the relay delivers inline (dev, tests).
 * The relay polls every OUTBOX_POLL_MS (default 5000; 0 disables; off under NODE_ENV=test — tests call drain()).
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Outbox');
  private readonly adapters = new Map<OutboxChannel, ChannelAdapter>();
  readonly mode: 'bullmq' | 'inline';
  private connection: IORedis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(OutboxMessage) private readonly repo: Repository<OutboxMessage>,
    private readonly events: DomainEvents
  ) {
    this.mode = this.config.get<string>('redisUrl') ? 'bullmq' : 'inline';
    for (const channel of ['EMAIL', 'SMS', 'PUSH'] as const) this.registerAdapter(new LoggingStubAdapter(channel));
  }

  async onModuleInit() {
    if (this.mode === 'bullmq') {
      this.connection = new IORedis(this.config.get<string>('redisUrl')!, { maxRetriesPerRequest: null });
      this.queue = new Queue(QUEUE, { connection: this.connection, defaultJobOptions: { attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 } });
      this.worker = new Worker(QUEUE, (job: Job) => this.deliver(job.data.id), { connection: this.connection, concurrency: 4 });
    }
    const pollMs = Number(this.config.get<string>('OUTBOX_POLL_MS') ?? 5000);
    if (pollMs > 0 && process.env.NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.drain().catch(e => this.logger.error(`Relay failed: ${(e as Error).message}`)), pollMs);
      this.timer.unref();
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([this.worker?.close(), this.queue?.close()]);
    this.connection?.disconnect();
  }

  /** Replace a channel's provider (the EMAIL / SMS / PUSH stubs, or add WEBHOOK / EXTERNAL_API). */
  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  adapterFor(channel: OutboxChannel): ChannelAdapter | undefined {
    return this.adapters.get(channel);
  }

  // ------------------------------------------------------------------ produce

  /** Call inside the business transaction. A message with an already used dedupeKey is ignored (returns null). */
  async enqueue(msg: OutboxMessageInput, m: EntityManager): Promise<string | null> {
    const id = shortId('OBX');
    const res = await m.createQueryBuilder().insert().into(OutboxMessage).values({
      id, channel: msg.channel, payload: msg.payload as any, status: 'PENDING', attempts: 0, maxAttempts: msg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      nextAttemptAt: new Date(), ackWithinHours: msg.ackWithinHours ?? null, dedupeKey: msg.dedupeKey ?? null
    }).orIgnore().returning(['id']).execute();
    return res.raw?.length ? id : null;
  }

  /** The receiving system confirmed a sent message (webhook callback, API acknowledgement, delivery report). */
  async ack(id: string, m?: EntityManager): Promise<void> {
    const r = await (m ? m.getRepository(OutboxMessage) : this.repo).update({ id, status: 'SENT' }, { status: 'ACKED', ackedAt: new Date() });
    if (!r.affected) throw Errors.conflict(`Outbox message ${id} is not awaiting acknowledgement`);
  }

  // ------------------------------------------------------------------ relay

  /** Claims due messages and delivers them (inline) or hands them to the worker (BullMQ). Returns how many were claimed. */
  async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      const rows: Array<{ id: string; attempts: number }> = await this.ds.query(
        `UPDATE outbox_messages SET next_attempt_at = now() + ($2 || ' milliseconds')::interval, updated_at = now()
         WHERE id IN (SELECT id FROM outbox_messages WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= now()
                      ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
         RETURNING id, attempts`,
        [BATCH, String(LEASE_MS)]
      ).then(r => (Array.isArray(r[0]) ? r[0] : r));
      for (const { id, attempts } of rows) {
        if (this.queue) await this.queue.add('deliver', { id }, { jobId: `${id}-${attempts}` });
        else await this.deliver(id);
      }
      return rows.length;
    } finally {
      this.draining = false;
    }
  }

  /** One delivery attempt for a claimed message. */
  async deliver(id: string): Promise<void> {
    const msg = await this.repo.findOne({ where: { id } });
    if (!msg || !['PENDING', 'FAILED'].includes(msg.status)) return;
    const attempts = msg.attempts + 1;
    try {
      const adapter = this.adapters.get(msg.channel);
      if (!adapter) throw new Error(`No adapter registered for channel ${msg.channel}`);
      const result = await adapter.send(msg.payload, msg.id);
      const now = new Date();
      const awaitsAck = !!msg.ackWithinHours && !result.acked;
      await this.repo.update({ id }, {
        status: result.acked ? 'ACKED' : 'SENT', attempts, sentAt: now, lastError: null, providerRef: result.providerRef ?? null,
        ackedAt: result.acked ? now : null, ackDueAt: awaitsAck ? new Date(now.getTime() + msg.ackWithinHours! * 3_600_000) : null
      });
    } catch (e) {
      const error = (e as Error)?.message || String(e);
      const dead = attempts >= msg.maxAttempts;
      await this.repo.update({ id }, {
        status: dead ? 'DEAD' : 'FAILED', attempts, lastError: error.slice(0, 2000), nextAttemptAt: new Date(Date.now() + backoffMs(attempts))
      });
      this.logger.warn(`${msg.channel} message ${id} attempt ${attempts}/${msg.maxAttempts} failed: ${error}`);
      if (dead) {
        const detail = `${id} gave up after ${attempts} attempts: ${error.slice(0, 300)}`;
        await this.events.publish(new OutboxProblem('DEAD', msg.channel, id, detail, `OUTBOX-DEAD-${msg.channel}-${nowStamp().slice(0, 10)}`));
      }
    }
  }

  /** Sent messages whose acknowledgement is overdue: one alert per channel per day. Called by the scheduler. */
  async checkAckOverdue(now = new Date()): Promise<number> {
    const overdue = await this.repo.find({ where: { status: 'SENT', ackDueAt: LessThan(now) }, take: 1000 });
    const byChannel = new Map<OutboxChannel, OutboxMessage[]>();
    for (const m of overdue) byChannel.set(m.channel, [...(byChannel.get(m.channel) ?? []), m]);
    for (const [channel, rows] of byChannel) {
      const detail = `${rows.length} message(s) past their acknowledgement deadline (e.g. ${rows[0].id})`;
      await this.events.publish(new OutboxProblem('ACK_OVERDUE', channel, rows[0].id, detail, `OUTBOX-ACK-${channel}-${nowStamp().slice(0, 10)}`));
    }
    return overdue.length;
  }

  async stats(): Promise<Record<string, number>> {
    const rows: Array<{ status: string; n: string }> = await this.repo.createQueryBuilder('o').select('o.status', 'status').addSelect('COUNT(*)', 'n').groupBy('o.status').getRawMany();
    return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
  }
}
