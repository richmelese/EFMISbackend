import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Notification record per channel (REQ-1.2-006). IN_APP rows are the notification centre; EMAIL/SMS/PUSH rows record
 * what was sent — the delivery itself goes through the platform outbox (outbox_messages). `deliveredAt` is legacy
 * (set by the retired logistics delivery worker) and no longer written.
 */
@Entity('notifications')
@Index(['recipientUserId'])
@Index(['recipientRole'])
export class Notification {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'varchar', length: 40, nullable: true }) recipientUserId: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) recipientRole: string | null;
  /** Limits a role notification to one administrative unit (region/zone/woreda/kebele id) */
  @Column({ type: 'varchar', length: 40, nullable: true }) recipientUnitId: string | null;
  /** IN_APP | EMAIL | SMS | PUSH */
  @Column({ type: 'varchar', length: 10, default: 'IN_APP' }) channel: string;
  @Column({ type: 'varchar', length: 240 }) title: string;
  @Column({ type: 'text' }) message: string;
  @Column({ type: 'varchar', length: 240, nullable: true }) link: string | null;
  @Column({ type: 'boolean', default: false }) read: boolean;
  @Column({ type: 'timestamptz', nullable: true }) deliveredAt: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
