import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

/** FTWG collaborative review session (REQ-1.3-003). status: OPEN | CLOSED */
@Entity('ftwg_sessions')
export class FtwgSession {
  @PrimaryColumn({ type: 'varchar', length: 60 }) id: string;
  @Column({ type: 'varchar', length: 240 }) title: string;
  @Column({ type: 'text', nullable: true }) agenda: string | null;
  @Column({ type: 'varchar', length: 10, default: 'OPEN' }) status: string;
  /** Votes cast before EFMIS (carried in from the seeded session) */
  @Column({ type: 'int', default: 0 }) baseInFavor: number;
  @Column({ type: 'int', default: 0 }) baseOpposed: number;
  @Column({ type: 'int', default: 0 }) baseAbstain: number;
  @Column({ type: 'text', nullable: true }) decision: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) closedAt: Date | null;
}

/** One vote per member per session. vote: FAVOR | OPPOSE | ABSTAIN */
@Entity('ftwg_votes')
export class FtwgVote {
  @PrimaryColumn({ type: 'varchar', length: 60 }) sessionId: string;
  @PrimaryColumn({ type: 'varchar', length: 40 }) userId: string;
  @Column({ type: 'varchar', length: 10 }) vote: string;
  @Column({ type: 'text', nullable: true }) comment: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}

/** status: OPEN | IN_PROGRESS | DONE */
@Entity('ftwg_action_items')
@Index(['sessionId'])
export class FtwgActionItem {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'varchar', length: 60 }) sessionId: string;
  @Column({ type: 'text' }) description: string;
  @Column({ type: 'varchar', length: 160, nullable: true }) assignee: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) dueDate: string | null;
  @Column({ type: 'varchar', length: 20, default: 'OPEN' }) status: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
