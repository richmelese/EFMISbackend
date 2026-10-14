import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Dead-letter record for jobs that exhausted their retries (queue or inline mode). status: DEAD | RETRIED | DISCARDED */
@Entity('job_failures')
@Index(['queue', 'status'])
export class JobFailure {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 40 }) queue: string;
  @Column({ type: 'varchar', length: 60 }) jobName: string;
  @Column({ type: 'jsonb' }) data: unknown;
  @Column({ type: 'int' }) attempts: number;
  @Column({ type: 'text' }) error: string;
  @Column({ type: 'varchar', length: 10, default: 'DEAD' }) status: string;
  @CreateDateColumn({ type: 'timestamptz' }) failedAt: Date;
}
