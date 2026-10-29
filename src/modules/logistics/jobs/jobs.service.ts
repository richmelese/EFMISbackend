import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Queue, Worker, Job, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { JobFailure } from './entities/job-failure.entity';

export type JobHandler = (data: any) => Promise<void>;

/** Queues used by the platform. */
export const QUEUES = {
  /** GPS position post-processing: geofences, milestones, route deviation, ETA, delay detection */
  TRACKING: 'tracking-events',
  /** Heavy/batch work (reports, KPI recomputation) */
  BACKGROUND: 'background'
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const DEFAULT_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false
};

/**
 * Queue abstraction (Logistics doc §2/§11: "Queue workers for heavy processing"; outbound notifications go through the
 * platform outbox).
 *  - REDIS_URL set   → BullMQ queues + workers, retries with exponential backoff; exhausted jobs go to the job_failures
 *                      dead-letter table.
 *  - REDIS_URL empty → handlers run inline (same retry count, synchronous) so dev and tests need no Redis.
 * Modules register handlers once (`register(queue, jobName, handler)`) and call `dispatch(queue, jobName, data)`.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private connection: IORedis | null = null;
  readonly mode: 'bullmq' | 'inline';

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(JobFailure) private readonly failures: Repository<JobFailure>
  ) {
    this.mode = this.config.get<string>('redisUrl') ? 'bullmq' : 'inline';
  }

  async onModuleInit() {
    if (this.mode !== 'bullmq') {
      this.logger.log('REDIS_URL not set — jobs run inline (no queue workers)');
      return;
    }
    this.connection = new IORedis(this.config.get<string>('redisUrl')!, { maxRetriesPerRequest: null });
    for (const name of Object.values(QUEUES)) {
      this.queues.set(name, new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_OPTS }));
      const worker = new Worker(name, (job: Job) => this.execute(name, job.name, job.data), {
        connection: this.connection, concurrency: name === QUEUES.TRACKING ? 8 : 4
      });
      worker.on('failed', (job, err) => {
        if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void this.deadLetter(name, job.name, job.data, job.attemptsMade, err);
      });
      this.workers.push(worker);
    }
    this.logger.log(`BullMQ workers started for ${[...this.queues.keys()].join(', ')}`);
  }

  async onModuleDestroy() {
    await Promise.allSettled(this.workers.map(w => w.close()));
    await Promise.allSettled([...this.queues.values()].map(q => q.close()));
    if (this.connection) this.connection.disconnect();
  }

  register(queue: QueueName, jobName: string, handler: JobHandler) {
    this.handlers.set(`${queue}:${jobName}`, handler);
  }

  private async execute(queue: string, jobName: string, data: unknown) {
    const handler = this.handlers.get(`${queue}:${jobName}`);
    if (!handler) throw new Error(`No handler registered for ${queue}:${jobName}`);
    await handler(data);
  }

  private async deadLetter(queue: string, jobName: string, data: unknown, attempts: number, err: unknown) {
    this.logger.error(`Job ${queue}:${jobName} dead-lettered after ${attempts} attempts: ${(err as Error)?.message}`);
    await this.failures.insert({ queue, jobName, data: data as any, attempts, error: String((err as Error)?.stack || err) });
  }

  /**
   * Enqueue a job. `opts.jobId` makes it idempotent in BullMQ mode (same id is not enqueued twice).
   * Inline mode runs the handler immediately (errors are dead-lettered, never thrown to the caller).
   */
  async dispatch(queue: QueueName, jobName: string, data: unknown, opts: JobsOptions = {}): Promise<void> {
    if (this.mode === 'bullmq') {
      await this.queues.get(queue)!.add(jobName, data, { ...DEFAULT_OPTS, ...opts });
      return;
    }
    const attempts = 1;
    try {
      await this.execute(queue, jobName, data);
    } catch (err) {
      await this.deadLetter(queue, jobName, data, attempts, err);
    }
  }

  /** Dead-letter queue inspection & manual retry (admin). */
  async listFailures(status = 'DEAD') {
    return this.failures.find({ where: { status }, order: { failedAt: 'DESC' }, take: 200 });
  }

  async retryFailure(id: string) {
    const f = await this.failures.findOneByOrFail({ id });
    await this.failures.update({ id }, { status: 'RETRIED' });
    await this.dispatch(f.queue as QueueName, f.jobName, f.data);
    return { retried: true, id };
  }

  async stats() {
    if (this.mode !== 'bullmq') return { mode: this.mode, deadLetters: await this.failures.countBy({ status: 'DEAD' }) };
    const out: Record<string, unknown> = { mode: this.mode, deadLetters: await this.failures.countBy({ status: 'DEAD' }) };
    for (const [name, q] of this.queues) out[name] = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    return out;
  }
}
