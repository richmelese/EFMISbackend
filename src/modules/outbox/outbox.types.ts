export const OUTBOX_CHANNELS = ['EMAIL', 'SMS', 'PUSH', 'WEBHOOK', 'EXTERNAL_API'] as const;
export type OutboxChannel = (typeof OUTBOX_CHANNELS)[number];

/**
 * PENDING: not tried yet · FAILED: last attempt failed, retry scheduled · SENT: delivered to the provider ·
 * ACKED: the receiving system confirmed · DEAD: gave up after maxAttempts (alert raised)
 */
export const OUTBOX_STATUSES = ['PENDING', 'FAILED', 'SENT', 'ACKED', 'DEAD'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface OutboxMessageInput {
  channel: OutboxChannel;
  payload: Record<string, unknown>;
  /** Same key twice = one message (idempotent producers) */
  dedupeKey?: string | null;
  /** The receiver must acknowledge within this many hours of sending, or an alert is raised */
  ackWithinHours?: number | null;
  maxAttempts?: number;
}

export interface DeliveryResult {
  /** Provider's message id */
  providerRef?: string | null;
  /** The provider confirmed delivery synchronously */
  acked?: boolean;
}

/**
 * One delivery channel (an e-mail provider, an SMS gateway, an external API …). Real providers replace the stubs by
 * registering their adapter: OutboxService.registerAdapter(adapter). Throwing = failed attempt (retried with back-off).
 */
export interface ChannelAdapter {
  readonly channel: OutboxChannel;
  send(payload: Record<string, unknown>, messageId: string): Promise<DeliveryResult>;
}

/**
 * Published when delivery needs attention (messages DEAD, acknowledgements overdue). The alerts module turns it into
 * an alert; `dedupeKey` is per channel per day so a failing provider cannot cause an alert → message → alert loop.
 */
export class OutboxProblem {
  constructor(
    readonly kind: 'DEAD' | 'ACK_OVERDUE',
    readonly channel: OutboxChannel,
    readonly messageId: string,
    readonly detail: string,
    readonly dedupeKey: string
  ) {}
}

export const DEFAULT_MAX_ATTEMPTS = 8;
/** Exponential back-off: 30 s, 1 min, 2 min, … capped at 6 h. */
export const backoffMs = (attempts: number): number => Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 6 * 3_600_000);
