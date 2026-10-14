import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Signed-out JWT ids (logout / session termination). */
@Entity('revoked_tokens')
export class RevokedToken {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  jti: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;
}
