import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { OtpCode } from './entities/otp-code.entity';
import { RevokedToken } from './entities/revoked-token.entity';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { AppError, Errors } from '../../common/utils/errors';
import { randomDigits } from '../../common/utils/helpers';
import { HotStateService } from '../logistics/jobs/hot-state.service';
import { ChangePinDto, LoginDto, OtpRequestDto, OtpVerifyDto } from './dto/auth.dto';

const OTP_TTL_MIN = 5;
const MAX_OTP_ATTEMPTS = 5;
const LOCKOUT_FAILURES = 5;
const LOCKOUT_MS = 15 * 60e3;

/** Authentication (REQ-1.7-001): credentials, Fayda ID + OTP, phone + OTP, demo persona login. */
@Injectable()
export class AuthService {

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    @InjectRepository(OtpCode) private readonly otps: Repository<OtpCode>,
    @InjectRepository(RevokedToken) private readonly revoked: Repository<RevokedToken>,
    private readonly hot: HotStateService
  ) {}

  /** Brute-force guard per identifier, shared by every API instance through Redis (memory fallback without Redis). */
  private async guard(key: string) {
    const f = await this.hot.getJson<{ count: number; at: number }>(`auth:fail:${key}`);
    if (f && f.count >= LOCKOUT_FAILURES && Date.now() - f.at < LOCKOUT_MS) throw Errors.tooMany('Too many failed attempts. Try again in 15 minutes.');
  }

  private async fail(key: string) {
    const k = `auth:fail:${key}`;
    const f = (await this.hot.getJson<{ count: number; at: number }>(k)) || { count: 0, at: 0 };
    await this.hot.setJson(k, { count: f.count + 1, at: Date.now() }, Math.ceil(LOCKOUT_MS / 1000));
  }

  private async clearFailures(key: string) {
    await this.hot.del(`auth:fail:${key}`);
  }

  private async issue(u: User, method: string, ctx: RequestContext) {
    const jti = crypto.randomUUID();
    const token = await this.jwt.signAsync({ sub: u.id, role: u.role, jti });
    await this.users.repo.update({ id: u.id }, { lastLoginAt: new Date() });
    const user = await this.users.authUserFor(u);
    if (!user.permissions?.length && !u.mustChangePassword) throw new AppError(403, 'ROLE_INACTIVE', 'Your role is inactive or has no permissions. Contact the administrator.');
    await this.audit.record(user, 'LOGIN', u.id, { method }, { ...ctx, sessionId: jti });
    const role = await this.users.roleInfo(u.role);
    const { exp } = this.jwt.decode(token) as { exp: number };
    return { token, tokenType: 'Bearer', expiresAt: new Date(exp * 1000).toISOString(), user: { ...user, roleLevel: role?.level } };
  }

  async login(dto: LoginDto, ctx: RequestContext) {
    if (!dto.email && !dto.phone) throw Errors.badRequest('email or phone is required');
    const key = `pw:${dto.email || dto.phone}`;
    await this.guard(key);
    const u = await this.users.findWithSecrets(dto.email ? { email: dto.email } : { phone: dto.phone });
    if (!u || !bcrypt.compareSync(dto.password, u.passwordHash)) {
      await this.fail(key);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email/phone or password');
    }
    await this.clearFailures(key);
    return this.issue(u, 'PASSWORD', ctx);
  }

  async requestOtp(dto: OtpRequestDto) {
    const u = await this.users.findWithSecrets(dto.channel === 'FAYDA' ? { faydaId: dto.identifier } : { phone: dto.identifier });
    const code = randomDigits(6);
    // Same response whether or not the account exists (no user enumeration), except devOtp in demo mode.
    if (u) {
      await this.otps.insert({ channel: dto.channel, identifier: dto.identifier, codeHash: bcrypt.hashSync(code, 8), expiresAt: new Date(Date.now() + OTP_TTL_MIN * 60e3) });
    }
    const demo = this.config.get<boolean>('demoMode');
    return {
      sent: true, channel: dto.channel, expiresInSeconds: OTP_TTL_MIN * 60,
      deliveredTo: u?.phone ? `${u.phone.slice(0, 4)}****${u.phone.slice(-2)}` : undefined,
      ...(demo ? { devOtp: u ? code : null, note: 'DEMO_MODE: OTP returned because no SMS gateway is configured' } : {})
    };
  }

  async verifyOtp(dto: OtpVerifyDto, ctx: RequestContext) {
    const key = `otp:${dto.identifier}`;
    await this.guard(key);
    const row = await this.otps.findOne({ where: { channel: dto.channel, identifier: dto.identifier, used: false }, order: { id: 'DESC' } });
    if (!row || row.expiresAt < new Date() || row.attempts >= MAX_OTP_ATTEMPTS) {
      await this.fail(key);
      throw new AppError(401, 'OTP_INVALID', 'OTP expired or invalid. Request a new code.');
    }
    if (!bcrypt.compareSync(dto.otp, row.codeHash)) {
      await this.otps.increment({ id: row.id }, 'attempts', 1);
      await this.fail(key);
      throw new AppError(401, 'OTP_INVALID', 'Incorrect OTP code');
    }
    await this.otps.update({ id: row.id }, { used: true });
    const u = await this.users.findWithSecrets(dto.channel === 'FAYDA' ? { faydaId: dto.identifier } : { phone: dto.identifier });
    if (!u) throw Errors.unauthorized('Account not found or deactivated');
    await this.clearFailures(key);
    return this.issue(u, dto.channel === 'FAYDA' ? 'FAYDA_OTP' : 'PHONE_OTP', ctx);
  }

  /** 1-click persona login (LoginPage). DEMO_MODE only. */
  async demoLogin(role: string, ctx: RequestContext) {
    if (!this.config.get<boolean>('demoMode')) throw Errors.forbidden('Demo login is disabled');
    const u = await this.users.repo.findOne({ where: { role: role.toUpperCase(), active: true }, order: { id: 'ASC' } });
    if (!u) throw Errors.notFound(`Demo user for role ${role}`);
    return this.issue(u, 'DEMO_PERSONA', ctx);
  }

  async changePin(user: AuthUser, dto: ChangePinDto, ctx: RequestContext) {
    const u = await this.users.findWithSecrets({ id: user.id });
    if (!u || !bcrypt.compareSync(dto.currentPassword, u.passwordHash)) throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    await this.users.repo.update({ id: user.id }, { pinHash: bcrypt.hashSync(dto.newPin, 10) });
    await this.audit.record(user, 'ESIGNATURE_PIN_CHANGED', user.id, null, ctx);
    return { updated: true };
  }

  async logout(user: AuthUser, ctx: RequestContext) {
    await this.revoked.save({ jti: user.jti!, expiresAt: new Date((user.tokenExp || 0) * 1000) });
    await this.audit.record(user, 'LOGOUT', user.id, null, ctx);
    return { signedOut: true, message: 'You have been securely signed out of EFMIS.' };
  }

  /** Housekeeping used by the scheduler. */
  async purgeExpired() {
    await this.revoked.delete({ expiresAt: LessThan(new Date()) });
    await this.otps.delete({ expiresAt: LessThan(new Date(Date.now() - 864e5)) });
  }
}
