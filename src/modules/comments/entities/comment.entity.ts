import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Threaded collaboration comments with @mentions (REQ-1.2-003/004, REQ-1.3-003, alerts, quota requests).
 * scopeType: WOREDA | ZONE | REGION | KEBELE | FTWG | ALERT | QUOTA_REQUEST | DOCUMENT
 */
@Entity('comments')
@Index(['scopeType', 'scopeId'])
export class Comment {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'varchar', length: 20 }) scopeType: string;
  @Column({ type: 'varchar', length: 60 }) scopeId: string;
  @Column({ type: 'int', nullable: true }) parentId: number | null;
  @Column({ type: 'varchar', length: 160 }) authorName: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) userId: string | null;
  @Column({ type: 'text' }) text: string;
  @Column({ type: 'jsonb', default: () => `'[]'` }) mentions: string[];
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
