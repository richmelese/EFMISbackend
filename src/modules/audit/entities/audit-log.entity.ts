import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Immutable, hash-chained audit trail (REQ-1.7-002).
 * hash = sha256(prev_hash + canonical entry). UPDATE/DELETE blocked by DB triggers (see migration).
 */
@Entity('audit_log')
@Index(['target'])
@Index(['action'])
export class AuditLog {
  @PrimaryGeneratedColumn() seq: number;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 20 }) id: string;
  /** "YYYY-MM-DD HH:mm:ss" (part of the hashed material) */
  @Column({ type: 'varchar', length: 20 }) timestamp: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) userId: string | null;
  @Column({ type: 'varchar', length: 160 }) userName: string;
  @Column({ type: 'varchar', length: 20, nullable: true }) role: string | null;
  @Column({ type: 'varchar', length: 60 }) action: string;
  @Column({ type: 'text', nullable: true }) target: string | null;
  /** JSON string (stored as text so the hashed representation is stable) */
  @Column({ type: 'text', nullable: true }) details: string | null;
  /** API | MOBILE | USSD | SEED | SYSTEM */
  @Column({ type: 'varchar', length: 20, default: 'API' }) source: string;
  @Column({ type: 'varchar', length: 60, nullable: true }) ip: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) sessionId: string | null;
  @Column({ type: 'varchar', length: 80 }) prevHash: string;
  @Column({ type: 'varchar', length: 80 }) hash: string;
}
