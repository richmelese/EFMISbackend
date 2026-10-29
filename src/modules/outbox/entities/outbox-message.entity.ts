import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { OutboxChannel, OutboxStatus } from '../outbox.types';

/** A side effect (email, SMS, push, webhook, external API call) written in the business transaction, sent later. */
@Entity('outbox_messages')
@Index('IDX_outbox_due', ['status', 'nextAttemptAt'])
export class OutboxMessage {
  /** e.g. OBX-… */
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  @Column({ type: 'varchar', length: 20 })
  channel: OutboxChannel;

  @Column({ type: 'jsonb' })
  payload: any;

  @Column({ type: 'varchar', length: 10, default: 'PENDING' })
  status: OutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'int', default: 8 })
  maxAttempts: number;

  @Column({ type: 'timestamptz' })
  nextAttemptAt: Date;

  /** Hours the receiver has to acknowledge after sending (null: no acknowledgement expected) */
  @Column({ type: 'int', nullable: true })
  ackWithinHours: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  ackDueAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  providerRef: string | null;

  @Index('UQ_outbox_dedupe', { unique: true, where: 'dedupe_key IS NOT NULL' })
  @Column({ type: 'varchar', length: 160, nullable: true })
  dedupeKey: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  ackedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
