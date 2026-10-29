import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Signature } from './entities/signature.entity';
import { User } from '../users/entities/user.entity';
import { AuthUser } from '../../common/types/auth-user';
import { AppError, Errors } from '../../common/utils/errors';
import { nowStamp, sha256, shortId } from '../../common/utils/helpers';

export interface SignatureCredentials {
  pin?: string;
  password?: string;
}

/** Key used for new signatures; older rows keep the key id they were signed with. */
export const CURRENT_SIGNATURE_KEY = 'sig-v1';
const LEGACY_SIGNATURE_KEY = 'jwt-legacy';

export interface SignatureResult {
  id: string;
  signer: string;
  role: string;
  method: string;
  signedAt: string;
  hash: string;
}

/**
 * Electronic signatures (Proclamation No. 1078/2018). The signer re-authenticates with PIN or password; the
 * signature binds signer + target + sha256(payload) + time with an HMAC so tampering is detectable.
 * The HMAC key is SIGNATURE_SECRET (key id 'sig-v1'); signatures made before the key split are verified with the JWT
 * secret (key id 'jwt-legacy'), so existing records stay verifiable.
 * Production: replace the HMAC with government PKI (X.509) — the sign()/verify() contract stays the same.
 */
@Injectable()
export class SignaturesService {
  private readonly keys: Record<string, string>;

  constructor(
    @InjectRepository(Signature) private readonly repo: Repository<Signature>,
    @InjectRepository(User) private readonly users: Repository<User>,
    config: ConfigService
  ) {
    this.keys = {
      [CURRENT_SIGNATURE_KEY]: config.get<string>('signatures.secret')!,
      [LEGACY_SIGNATURE_KEY]: config.get<string>('jwt.secret')!
    };
  }

  private hmac(parts: string[], keyId: string = CURRENT_SIGNATURE_KEY): string {
    const key = this.keys[keyId];
    if (!key) throw new Error(`Unknown signature key id "${keyId}"`);
    return crypto.createHmac('sha256', key).update(parts.join('|')).digest('hex');
  }

  private async checkCredential(user: AuthUser, cred: SignatureCredentials, manager?: EntityManager): Promise<'PIN' | 'PASSWORD'> {
    const row = await (manager ? manager.getRepository(User) : this.users).createQueryBuilder('u').addSelect(['u.pinHash', 'u.passwordHash']).where('u.id = :id', { id: user.id }).getOne();
    if (!row) throw Errors.unauthorized();
    if (cred.pin && row.pinHash && bcrypt.compareSync(String(cred.pin), row.pinHash)) return 'PIN';
    if (cred.password && bcrypt.compareSync(String(cred.password), row.passwordHash)) return 'PASSWORD';
    throw new AppError(401, 'SIGNATURE_REJECTED', 'Electronic signature failed: invalid PIN or password');
  }

  /**
   * Sign `payload` on behalf of `user`. Throws 400 when no credential is supplied, 401 when it is wrong.
   * @param signedAt optional fixed timestamp (seeding historic signatures)
   */
  async sign(user: AuthUser, cred: SignatureCredentials | null | undefined, targetType: string, targetId: string, payload: unknown, manager?: EntityManager, signedAt?: string): Promise<SignatureResult> {
    if (!cred || (!cred.pin && !cred.password)) throw Errors.badRequest('Approval requires an electronic signature: provide "pin" (or "password")');
    const method = await this.checkCredential(user, cred, manager);
    const at = signedAt || nowStamp();
    const payloadHash = sha256(payload ?? {});
    const signatureHash = this.hmac([user.id, targetType, targetId, payloadHash, at]);
    const id = shortId('SIG');
    await (manager ? manager.getRepository(Signature) : this.repo).insert({
      id, userId: user.id, signerName: user.name, role: user.role, method, targetType, targetId, payloadHash, signatureHash, signedAt: at,
      keyId: CURRENT_SIGNATURE_KEY
    });
    return { id, signer: user.name, role: user.role, method, signedAt: at, hash: `sha256:${signatureHash}` };
  }

  async verify(signatureId: string, payload?: unknown) {
    const s = await this.repo.findOne({ where: { id: signatureId } });
    if (!s) return { valid: false, reason: 'Signature not found' };
    const expected = this.hmac([s.userId, s.targetType, s.targetId, s.payloadHash, s.signedAt], s.keyId || LEGACY_SIGNATURE_KEY);
    const payloadOk = payload === undefined ? true : sha256(payload) === s.payloadHash;
    return {
      valid: expected === s.signatureHash && payloadOk,
      tamperEvident: !payloadOk,
      signer: s.signerName, role: s.role, method: s.method, signedAt: s.signedAt,
      target: `${s.targetType}:${s.targetId}`, hash: `sha256:${s.signatureHash}`, keyId: s.keyId
    };
  }

  findById(id: string) {
    return this.repo.findOne({ where: { id } });
  }
}
