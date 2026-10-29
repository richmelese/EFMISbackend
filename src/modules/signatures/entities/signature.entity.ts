import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** Electronic signature record (Proclamation No. 1078/2018). */
@Entity('signatures')
@Index(['targetType', 'targetId'])
export class Signature {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  @Column({ type: 'varchar', length: 40 })
  userId: string;

  @Column({ type: 'varchar', length: 160 })
  signerName: string;

  @Column({ type: 'varchar', length: 20 })
  role: string;

  @Column({ type: 'varchar', length: 12 })
  method: 'PIN' | 'PASSWORD' | 'BIOMETRIC';

  @Column({ type: 'varchar', length: 60 })
  targetType: string;

  @Column({ type: 'text' })
  targetId: string;

  @Column({ type: 'varchar', length: 64 })
  payloadHash: string;

  @Column({ type: 'varchar', length: 64 })
  signatureHash: string;

  /** Which key produced signatureHash: 'sig-v1' (SIGNATURE_SECRET) or 'jwt-legacy' (signed before the keys were split). */
  @Column({ type: 'varchar', length: 20, default: 'jwt-legacy' })
  keyId: string;

  /** Exact signing timestamp string (part of the signed material) */
  @Column({ type: 'varchar', length: 30 })
  signedAt: string;
}
