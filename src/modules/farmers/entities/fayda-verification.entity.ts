import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Every Fayda verification attempt is logged (REQ-1.1-003 Verification Logging). */
@Entity('fayda_verifications')
export class FaydaVerification {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'varchar', length: 40 }) faydaId: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) userId: string | null;
  @Column({ type: 'boolean' }) success: boolean;
  @Column({ type: 'varchar', length: 40, nullable: true }) reason: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
