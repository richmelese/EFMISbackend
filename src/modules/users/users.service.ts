import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { User } from './entities/user.entity';
import { RoleEntity } from './entities/role.entity';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Role } from '../../common/constants/permissions';
import { Errors } from '../../common/utils/errors';
import { shortId, stamp } from '../../common/utils/helpers';
import { HierarchyService } from '../hierarchy/hierarchy.service';
import { AuditService } from '../audit/audit.service';
import { RbacService } from './rbac.service';
import { ChangePasswordDto, CreateUserDto, ListUsersQueryDto, PASSWORD_MESSAGE, PASSWORD_RULE, ResetPasswordDto, UpdateUserDto } from './dto/user.dto';

const BCRYPT_ROUNDS = 12;
/** Data scope each base role must carry (REQ-1.7-001 data segmentation). */
const SCOPE_REQUIRED: Record<string, 'kebeleId' | 'woredaId' | 'zoneId' | 'regionId' | 'warehouseId'> = {
  [Role.DA]: 'kebeleId', [Role.KEBELE]: 'kebeleId', [Role.WOREDA]: 'woredaId', [Role.ZONE]: 'zoneId', [Role.REGION]: 'regionId',
  [Role.WAREHOUSE_OPERATOR]: 'warehouseId'
};

type Scope = { regionId: string | null; zoneId: string | null; woredaId: string | null; kebeleId: string | null; warehouseId: string | null };

/** A readable temporary password that satisfies PASSWORD_RULE. */
const UNAMBIGUOUS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/l/I
function temporaryPassword(): string {
  const pick = (n: number) => Array.from({ length: n }, () => UNAMBIGUOUS[crypto.randomInt(UNAMBIGUOUS.length)]).join('');
  // 4-4-4 groups, always with upper, lower and a digit (PASSWORD_RULE)
  return `${pick(3)}K-${pick(3)}m-${pick(3)}${crypto.randomInt(2, 10)}`;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) readonly repo: Repository<User>,
    @InjectRepository(RoleEntity) readonly roles: Repository<RoleEntity>,
    @InjectDataSource() private readonly ds: DataSource,
    private readonly hierarchy: HierarchyService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService
  ) {}

  // ------------------------------------------------------------------ principal

  /** Synchronous principal without permissions (only for audit attribution of a not-yet-authenticated login). */
  toAuthUser(u: User): AuthUser {
    return {
      id: u.id, name: u.fullName, email: u.email, phone: u.phone, role: u.role, roleId: u.role, title: u.title,
      regionId: u.regionId, zoneId: u.zoneId, woredaId: u.woredaId, kebeleId: u.kebeleId, warehouseId: u.warehouseId,
      preferredLanguage: u.preferredLanguage, mustChangePassword: u.mustChangePassword
    };
  }

  /** Full principal: base role for data scope, assigned role + its permissions from the database. */
  async authUserFor(u: User): Promise<AuthUser> {
    const r = await this.rbac.resolve(u.role);
    return { ...this.toAuthUser(u), role: r.baseRole, roleId: u.role, roleName: r.roleName, permissions: r.permissions };
  }

  /**
   * Active user for a token. `issuedAt` (JWT iat, seconds) is checked against tokensValidAfter so deactivation,
   * password resets and "sign out everywhere" invalidate existing sessions immediately.
   */
  async findActive(id: string, issuedAt?: number): Promise<AuthUser | null> {
    const u = await this.repo.findOne({ where: { id, active: true } });
    if (!u) return null;
    if (issuedAt !== undefined && u.tokensValidAfter && issuedAt * 1000 < new Date(u.tokensValidAfter).getTime() - 999) return null;
    return this.authUserFor(u);
  }

  /** Load a user including password/pin hashes. */
  findWithSecrets(where: Partial<Pick<User, 'id' | 'email' | 'phone' | 'faydaId'>>) {
    const qb = this.repo.createQueryBuilder('u').addSelect(['u.passwordHash', 'u.pinHash']).where('u.active = true');
    for (const [k, v] of Object.entries(where)) qb.andWhere(k === 'email' ? 'LOWER(u.email) = LOWER(:v_' + k + ')' : `u.${k} = :v_${k}`, { [`v_${k}`]: v });
    return qb.getOne();
  }

  async roleInfo(roleId: string) {
    return this.roles.findOne({ where: { id: roleId } });
  }

  toFrontend(u: User, role?: RoleEntity | null) {
    return {
      id: u.id, name: u.fullName, email: u.email, phone: u.phone, faydaId: u.faydaId, role: u.role, roleName: role?.name ?? null,
      baseRole: role?.baseRole ?? u.role, title: u.title,
      regionId: u.regionId, zoneId: u.zoneId, woredaId: u.woredaId, kebeleId: u.kebeleId, warehouseId: u.warehouseId,
      preferredLanguage: u.preferredLanguage, active: u.active, deactivationReason: u.deactivationReason,
      mustChangePassword: u.mustChangePassword, passwordChangedAt: stamp(u.passwordChangedAt),
      lastLoginAt: stamp(u.lastLoginAt), createdAt: stamp(u.createdAt), createdBy: u.createdBy
    };
  }

  // ------------------------------------------------------------------ queries

  async list(q: ListUsersQueryDto = {}) {
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 50, 200);
    const qb = this.repo.createQueryBuilder('u');
    if (q.role) qb.andWhere('u.role = :role', { role: q.role });
    if (q.active) qb.andWhere('u.active = :active', { active: q.active === 'true' });
    if (q.regionId) qb.andWhere('u.regionId = :regionId', { regionId: q.regionId });
    if (q.q) {
      const like = `%${q.q.trim().toLowerCase()}%`;
      qb.andWhere(new Brackets(b => b.where('LOWER(u.fullName) LIKE :like', { like }).orWhere('LOWER(u.email) LIKE :like', { like })
        .orWhere('u.phone LIKE :like', { like }).orWhere('LOWER(u.title) LIKE :like', { like }).orWhere('LOWER(u.id) LIKE :like', { like })));
    }
    const [rows, total] = await qb.orderBy('u.active', 'DESC').addOrderBy('u.fullName', 'ASC').skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    const roles = new Map((await this.roles.find()).map(r => [r.id, r]));
    return { items: rows.map(u => this.toFrontend(u, roles.get(u.role))), total, page, pageSize };
  }

  async get(id: string) {
    const u = await this.repo.findOne({ where: { id } });
    if (!u) throw Errors.notFound('User');
    const role = await this.roles.findOne({ where: { id: u.role } });
    const r = await this.rbac.resolve(u.role);
    return { ...this.toFrontend(u, role), permissions: r.permissions };
  }

  // ------------------------------------------------------------------ commands

  private async assertRole(roleId: string): Promise<RoleEntity> {
    const role = await this.roles.findOne({ where: { id: roleId } });
    if (!role) throw Errors.unprocessable(`Unknown role ${roleId}`, { field: 'role' });
    if (!role.active) throw Errors.unprocessable(`Role ${role.name} is inactive`, { field: 'role' });
    return role;
  }

  /** Validate and complete the administrative / warehouse scope for the role's base role. */
  private async resolveScope(baseRole: string, input: Partial<Scope>): Promise<Scope> {
    const s: Scope = { regionId: input.regionId ?? null, zoneId: input.zoneId ?? null, woredaId: input.woredaId ?? null, kebeleId: input.kebeleId ?? null, warehouseId: input.warehouseId ?? null };
    if (s.kebeleId) {
      const c = await this.hierarchy.resolveKebele(s.kebeleId);
      s.regionId = c.region.id; s.zoneId = c.zone.id; s.woredaId = c.woreda.id;
    } else if (s.woredaId) {
      const ref = await this.hierarchy.unitRef('WOREDA', s.woredaId);
      if (!ref) throw Errors.unprocessable(`Unknown woreda ${s.woredaId}`, { field: 'woredaId' });
      s.regionId = ref.regionId!; s.zoneId = ref.zoneId!;
    } else if (s.zoneId) {
      const ref = await this.hierarchy.unitRef('ZONE', s.zoneId);
      if (!ref) throw Errors.unprocessable(`Unknown zone ${s.zoneId}`, { field: 'zoneId' });
      s.regionId = ref.regionId!;
    } else if (s.regionId && !(await this.hierarchy.unitRef('REGION', s.regionId))) {
      throw Errors.unprocessable(`Unknown region ${s.regionId}`, { field: 'regionId' });
    }
    if (s.warehouseId) {
      const ok = await this.ds.query('SELECT 1 FROM warehouses WHERE id = $1', [s.warehouseId]);
      if (!ok.length) throw Errors.unprocessable('Unknown warehouse', { field: 'warehouseId' });
    }
    const need = SCOPE_REQUIRED[baseRole];
    if (need && !s[need]) {
      throw Errors.unprocessable(`Users with a ${baseRole}-based role must be assigned a ${need.replace('Id', '')}`, { field: need });
    }
    return s;
  }

  private async assertUnique(email: string | null | undefined, phone: string | null | undefined, faydaId: string | null | undefined, exceptId?: string) {
    const clash = async (where: string, v: string, field: string) => {
      const qb = this.repo.createQueryBuilder('u').where(where, { v });
      if (exceptId) qb.andWhere('u.id <> :id', { id: exceptId });
      if (await qb.getExists()) throw Errors.conflict(`Another user already has this ${field}`, { field });
    };
    if (email) await clash('LOWER(u.email) = LOWER(:v)', email, 'email');
    if (phone) await clash('u.phone = :v', phone, 'phone');
    if (faydaId) await clash('u.faydaId = :v', faydaId, 'faydaId');
  }

  async create(dto: CreateUserDto, actor: AuthUser, ctx: RequestContext) {
    const role = await this.assertRole(dto.role);
    const scope = await this.resolveScope(role.baseRole || role.id, dto);
    await this.assertUnique(dto.email, dto.phone, dto.faydaId);
    const generated = !dto.password;
    const password = dto.password ?? temporaryPassword();
    const user = this.repo.create({
      id: shortId(`U-${(role.baseRole || role.id).slice(0, 6)}`), fullName: dto.name.trim(), email: dto.email.trim().toLowerCase(),
      phone: dto.phone ?? null, faydaId: dto.faydaId ?? null,
      passwordHash: bcrypt.hashSync(password, BCRYPT_ROUNDS), pinHash: dto.pin ? bcrypt.hashSync(dto.pin, BCRYPT_ROUNDS) : null,
      role: role.id, title: dto.title?.trim() || null, ...scope, preferredLanguage: dto.preferredLanguage ?? 'en',
      mustChangePassword: generated || dto.mustChangePassword !== false, createdBy: actor.id
    });
    await this.repo.save(user);
    await this.audit.record(actor, 'USER_CREATED', user.id, { role: role.id, email: user.email, scope, temporaryPassword: generated }, ctx);
    return { user: this.toFrontend(user, role), ...(generated ? { temporaryPassword: password, note: 'Shown once. Share it securely; the user must change it at first sign-in.' } : {}) };
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser, ctx: RequestContext) {
    if (dto.active === false) return this.deactivate(id, 'Deactivated', actor, ctx);
    if (dto.active === true) await this.reactivate(id, actor, ctx);
    return this.ds.transaction(async m => {
      const repo = m.getRepository(User);
      const u = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!u) throw Errors.notFound('User');
      const before = this.toFrontend(u);
      const roleId = dto.role ?? u.role;
      const role = await this.assertRole(roleId);
      const SCOPE_KEYS = ['regionId', 'zoneId', 'woredaId', 'kebeleId', 'warehouseId'] as const;
      // (validated DTOs carry every declared key as undefined: test values, not key presence; null = clear)
      const scopeSent = SCOPE_KEYS.some(k => (dto as Record<string, unknown>)[k] !== undefined);
      if (scopeSent || dto.role !== undefined) {
        // Scope sent: it replaces the old one entirely (fields not sent are cleared), so a user can move up or across
        // the hierarchy (e.g. DA in a kebele → WOREDA officer of another woreda). Role change alone: keep the scope.
        const from = scopeSent ? (dto as Record<string, any>) : (u as Record<string, any>);
        const scope = await this.resolveScope(role.baseRole || role.id, Object.fromEntries(SCOPE_KEYS.map(k => [k, from[k] ?? null])));
        Object.assign(u, scope);
      }
      await this.assertUnique(dto.email, dto.phone, dto.faydaId, id);
      if (dto.name !== undefined) u.fullName = dto.name.trim();
      if (dto.email !== undefined) u.email = dto.email.trim().toLowerCase();
      if (dto.phone !== undefined) u.phone = dto.phone || null;
      if (dto.faydaId !== undefined) u.faydaId = dto.faydaId || null;
      if (dto.title !== undefined) u.title = dto.title?.trim() || null;
      if (dto.preferredLanguage !== undefined) u.preferredLanguage = dto.preferredLanguage;
      u.role = role.id;
      await repo.save(u);
      if (dto.role !== undefined && dto.role !== before.role) await this.rbac.assertAdministrable(m);
      if (id === actor.id && dto.role !== undefined && dto.role !== before.role) {
        const r = await this.rbac.resolve(role.id);
        if (!r.permissions.includes('users:manage')) throw Errors.unprocessable('You cannot remove your own user-administration permission');
      }
      const after = this.toFrontend(u, role);
      const changed = Object.keys(after).filter(k => JSON.stringify((after as any)[k]) !== JSON.stringify((before as any)[k]) && k !== 'roleName' && k !== 'baseRole');
      await this.audit.record(actor, dto.role && dto.role !== before.role ? 'USER_ROLE_CHANGED' : 'USER_UPDATED', u.id,
        { old: Object.fromEntries(changed.map(k => [k, (before as any)[k]])), new: Object.fromEntries(changed.map(k => [k, (after as any)[k]])) }, ctx, m);
      return after;
    });
  }

  async deactivate(id: string, reason: string, actor: AuthUser, ctx: RequestContext) {
    if (id === actor.id) throw Errors.unprocessable('You cannot deactivate your own account');
    return this.ds.transaction(async m => {
      const repo = m.getRepository(User);
      const u = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!u) throw Errors.notFound('User');
      if (!u.active) return this.toFrontend(u);
      await repo.update({ id }, { active: false, deactivationReason: reason, tokensValidAfter: new Date() });
      await this.rbac.assertAdministrable(m);
      await this.audit.record(actor, 'USER_DEACTIVATED', id, { reason }, ctx, m);
      return this.toFrontend({ ...u, active: false, deactivationReason: reason } as User);
    });
  }

  async reactivate(id: string, actor: AuthUser, ctx: RequestContext) {
    const u = await this.repo.findOne({ where: { id } });
    if (!u) throw Errors.notFound('User');
    if (u.active) return this.toFrontend(u);
    await this.assertRole(u.role);
    await this.repo.update({ id }, { active: true, deactivationReason: null });
    await this.audit.record(actor, 'USER_REACTIVATED', id, null, ctx);
    return this.toFrontend({ ...u, active: true, deactivationReason: null } as User);
  }

  /** Admin reset: temporary password (generated unless given), must change at next sign-in, all sessions revoked. */
  async resetPassword(id: string, dto: ResetPasswordDto, actor: AuthUser, ctx: RequestContext) {
    const u = await this.repo.findOne({ where: { id } });
    if (!u) throw Errors.notFound('User');
    const generated = !dto.temporaryPassword;
    const password = dto.temporaryPassword ?? temporaryPassword();
    await this.repo.update({ id }, { passwordHash: bcrypt.hashSync(password, BCRYPT_ROUNDS), mustChangePassword: true, tokensValidAfter: new Date() });
    await this.audit.record(actor, 'USER_PASSWORD_RESET', id, { generated }, ctx);
    return { id, mustChangePassword: true, sessionsRevoked: true, ...(generated ? { temporaryPassword: password, note: 'Shown once. Share it securely.' } : {}) };
  }

  async revokeSessions(id: string, actor: AuthUser, ctx: RequestContext) {
    const res = await this.repo.update({ id }, { tokensValidAfter: new Date() });
    if (!res.affected) throw Errors.notFound('User');
    await this.audit.record(actor, 'USER_SESSIONS_REVOKED', id, null, ctx);
    return { id, sessionsRevoked: true };
  }

  /** Self-service password change (also clears mustChangePassword); other sessions are signed out. */
  async changeOwnPassword(actor: AuthUser, dto: ChangePasswordDto, ctx: RequestContext) {
    if (!PASSWORD_RULE.test(dto.newPassword)) throw Errors.unprocessable(PASSWORD_MESSAGE);
    const u = await this.findWithSecrets({ id: actor.id });
    if (!u || !bcrypt.compareSync(dto.currentPassword, u.passwordHash)) throw Errors.unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
    if (bcrypt.compareSync(dto.newPassword, u.passwordHash)) throw Errors.unprocessable('The new password must be different from the current one');
    // tokensValidAfter = now → every session, including this one, must sign in again with the new password.
    await this.repo.update({ id: actor.id }, { passwordHash: bcrypt.hashSync(dto.newPassword, BCRYPT_ROUNDS), mustChangePassword: false, passwordChangedAt: new Date(), tokensValidAfter: new Date() });
    await this.audit.record(actor, 'PASSWORD_CHANGED', actor.id, null, ctx);
    return { changed: true, signInAgain: true };
  }

  async userAudit(id: string) {
    // Changes made TO this user, and the user's own security events (logins, password changes).
    const rows: Array<{ id: string; timestamp: string; actorId: string | null; actorName: string; role: string | null; action: string; details: string | null }> = await this.ds.query(
      `SELECT id, timestamp, user_id AS "actorId", user_name AS "actorName", role, action, details FROM audit_log
        WHERE target = $1 OR (user_id = $1 AND action IN ('LOGIN', 'LOGOUT', 'PASSWORD_CHANGED', 'ESIGNATURE_PIN_CHANGED'))
        ORDER BY seq DESC LIMIT 200`, [id]
    );
    return rows.map(r => {
      let details: unknown = r.details;
      try { details = r.details ? JSON.parse(r.details) : null; } catch { /* plain text */ }
      return { ...r, details };
    });
  }
}
