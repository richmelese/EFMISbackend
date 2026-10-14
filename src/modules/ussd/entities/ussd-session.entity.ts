import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Server-side USSD session state for the *804# simulator (REQ-1.4-008). */
@Entity('ussd_sessions')
export class UssdSession {
  @PrimaryColumn({ type: 'varchar', length: 120 }) sessionId: string;
  @Column({ type: 'varchar', length: 20, nullable: true }) phone: string | null;
  /** JSON array of menu steps, or "MAIN" */
  @Column({ type: 'text', default: 'MAIN' }) state: string;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
