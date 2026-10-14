import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/** Photo / ID / land certificate uploads (REQ-1.1-002). sha256 is globally unique (duplicate detection). */
@Entity('farmer_documents')
export class FarmerDocument {
  @PrimaryColumn({ type: 'varchar', length: 40 }) id: string;
  @Index() @Column({ type: 'varchar', length: 20 }) farmerId: string;
  @Column({ type: 'varchar', length: 30 }) docType: string;
  @Column({ type: 'varchar', length: 240 }) fileName: string;
  @Column({ type: 'varchar', length: 60 }) mimeType: string;
  @Column({ type: 'int' }) sizeBytes: number;
  @Index({ unique: true }) @Column({ type: 'varchar', length: 64 }) sha256: string;
  @Column({ type: 'text' }) storagePath: string;
  @Column({ type: 'boolean', default: false }) consentGiven: boolean;
  @Column({ type: 'varchar', length: 40, nullable: true }) uploadedBy: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
