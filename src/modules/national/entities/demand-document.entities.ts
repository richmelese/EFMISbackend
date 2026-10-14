import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** Formal national demand approval document (REQ-1.3-005). status: SIGNING | FINAL | REJECTED */
@Entity('demand_documents')
export class DemandDocument {
  @PrimaryColumn({ type: 'varchar', length: 40 }) id: string;
  @Column({ type: 'varchar', length: 40, unique: true }) docNo: string;
  @Column({ type: 'varchar', length: 40 }) season: string;
  @Column({ type: 'int' }) version: number;
  @Column({ type: 'varchar', length: 12 }) status: string;
  /** json (not jsonb) so key order is preserved and the content hash can be recomputed exactly */
  @Column({ type: 'json' }) content: any;
  /** sha256 of content — tamper evidence */
  @Column({ type: 'varchar', length: 80 }) contentHash: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) createdBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @Column({ type: 'varchar', length: 30, nullable: true }) finalizedAt: string | null;
}

/** Sequential signatory slot: FTWG Chair -> ATI DG -> MoA State Minister. status: PENDING | SIGNED | REJECTED */
@Entity('document_signatures')
export class DocumentSignature {
  @PrimaryColumn({ type: 'varchar', length: 40 }) documentId: string;
  @PrimaryColumn({ type: 'int' }) step: number;
  @Column({ type: 'varchar', length: 20 }) role: string;
  @Column({ type: 'varchar', length: 80 }) title: string;
  @Column({ type: 'varchar', length: 160, nullable: true }) signerName: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) userId: string | null;
  @Column({ type: 'varchar', length: 12, default: 'PENDING' }) status: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) signatureId: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) signedAt: string | null;
  @Column({ type: 'text', nullable: true }) comments: string | null;
}
