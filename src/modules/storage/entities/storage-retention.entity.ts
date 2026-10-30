import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Objects waiting for their write-once retention. A row is written in the same transaction as the record that
 * references the object, so it only exists for committed uploads; retention is applied right after the commit and
 * retried by the scheduler until it succeeds. (Retention cannot be applied before the commit: it would block the
 * rollback delete of an upload whose transaction fails.)
 */
@Entity('storage_retention_queue')
export class StorageRetention {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 30 })
  bucket: string;

  @Column({ type: 'text' })
  objectKey: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  versionId: string | null;

  @Column({ type: 'timestamptz' })
  retainUntil: Date;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
