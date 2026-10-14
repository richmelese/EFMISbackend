import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { PERMISSIONS, Permission, Role, defaultGrant } from '../../common/constants/permissions';
import { ADMIN_LOCKED_PERMISSIONS, PERMISSION_CATALOG, SYSTEM_ROLE_META } from '../../common/constants/permission-catalog';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { AuditService } from '../audit/audit.service';
import { PermissionEntity, RoleEntity, RolePermission } from './entities/role.entity';
import { User } from './entities/user.entity';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';

const SYSTEM_ROLES = Object.values(Role) as string[];
const CACHE_MS = 5_000;

interface ResolvedRole { id: string; name: string; baseRole: string; active: boolean; permissions: string[] }

/**
 * Database-backed role → permission model (REQ-1.7-001).
 * - The permission catalogue comes from the code (PERMISSIONS + PERMISSION_CATALOG) and is synced at startup; a permission
 *   seen for the first time is granted to its default roles once. After that, grants are owned by administrators.
 * - Lookups are cached ≤ 5 s and refreshed when a cheap version probe changes, so edits apply to every instance quickly.
 */
@Injectable()
export class RbacService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Rbac');
  private cache: { at: number; version: string; roles: Map<string, ResolvedRole> } | null = null;

  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly audit: AuditService) {}

  async onApplicationBootstrap() {
    try {
      await this.syncCatalog();
    } catch (e) {
      // Tables may not exist yet when migrations are run separately; the next start syncs.
      this.logger.warn(`Permission catalogue sync skipped: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ catalogue sync

  /** Ensure system roles and every code permission exist; grant defaults for permissions new to the catalogue. */
  async syncCatalog(): Promise<{ newPermissions: string[] }> {
    const result = await this.ds.transaction(async m => {
      const roles = m.getRepository(RoleEntity);
      const existingRoles = new Map((await roles.find()).map(r => [r.id, r]));
      for (const id of SYSTEM_ROLES) {
        const r = existingRoles.get(id);
        const meta = SYSTEM_ROLE_META[id];
        if (!r) await roles.insert({ id, name: meta?.name ?? id, level: meta?.level ?? 'National', description: meta?.description ?? null, baseRole: id, isSystem: true, active: true });
        else if (!r.isSystem || r.baseRole !== id) await roles.update({ id }, { isSystem: true, baseRole: id, active: true });
      }
      const perms = m.getRepository(PermissionEntity);
      const known = new Set((await perms.find({ select: { key: true } })).map(p => p.key));
      const fresh = (Object.keys(PERMISSIONS) as Permission[]).filter(k => !known.has(k));
      for (const key of Object.keys(PERMISSIONS) as Permission[]) {
        const meta = PERMISSION_CATALOG[key];
        if (fresh.includes(key)) await perms.insert({ key, group: meta.group, description: meta.description, sensitive: !!meta.sensitive });
        else await perms.update({ key }, { group: meta.group, description: meta.description, sensitive: !!meta.sensitive });
      }
      if (fresh.length) {
        const grants = fresh.flatMap(key => SYSTEM_ROLES.filter(r => defaultGrant(r, key)).map(roleId => ({ roleId, permissionKey: key, grantedBy: 'system' })));
        if (grants.length) await m.getRepository(RolePermission).createQueryBuilder().insert().values(grants).orIgnore().execute();
      }
      // The built-in administrator can never lose user/role administration.
      await m.getRepository(RolePermission).createQueryBuilder().insert()
        .values(ADMIN_LOCKED_PERMISSIONS.map(permissionKey => ({ roleId: Role.ADMIN, permissionKey, grantedBy: 'system' }))).orIgnore().execute();
      return { newPermissions: fresh };
    });
    if (result.newPermissions.length) this.logger.log(`Permission catalogue: ${result.newPermissions.length} new permission(s) granted to their default roles`);
    this.invalidate();
    return result;
  }

  // ------------------------------------------------------------------ resolution (hot path)

  invalidate() {
    this.cache = null;
  }

  private async load(): Promise<Map<string, ResolvedRole>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.roles;
    const probe = await this.ds.query(
      `SELECT (SELECT COALESCE(MAX(updated_at), 'epoch') FROM roles) AS r, (SELECT COUNT(*) FROM roles) AS rc,
              (SELECT COUNT(*) FROM role_permissions) AS pc, (SELECT COALESCE(MAX(granted_at), 'epoch') FROM role_permissions) AS pg`
    );
    const p = probe[0];
    const version = `${new Date(p.r).getTime()}:${p.rc}:${p.pc}:${new Date(p.pg).getTime()}`;
    if (this.cache && this.cache.version === version) {
      this.cache.at = Date.now();
      return this.cache.roles;
    }
    const [roles, grants] = await Promise.all([
      this.ds.getRepository(RoleEntity).find(),
      this.ds.getRepository(RolePermission).find({ select: { roleId: true, permissionKey: true } })
    ]);
    const byRole = new Map<string, string[]>();
    for (const g of grants) byRole.set(g.roleId, [...(byRole.get(g.roleId) || []), g.permissionKey]);
    const map = new Map<string, ResolvedRole>();
    for (const r of roles) {
      map.set(r.id, { id: r.id, name: r.name, baseRole: r.baseRole || r.id, active: r.active, permissions: (byRole.get(r.id) || []).sort() });
    }
    this.cache = { at: Date.now(), version, roles: map };
    return map;
  }

  /** Base role + permissions for an assigned role. Inactive or unknown roles resolve to no permissions. */
  async resolve(roleId: string): Promise<{ baseRole: string; roleName: string | null; permissions: string[] }> {
    const r = (await this.load()).get(roleId);
    if (!r) return { baseRole: roleId, roleName: null, permissions: [] };
    return { baseRole: r.baseRole, roleName: r.name, permissions: r.active ? r.permissions : [] };
  }

  // ------------------------------------------------------------------ administration

  async listPermissions() {
    const rows = await this.ds.getRepository(PermissionEntity).find({ order: { group: 'ASC', key: 'ASC' } });
    return rows.map(p => ({ key: p.key, group: p.group, description: p.description, sensitive: p.sensitive }));
  }

  async listRoles() {
    const [roles, map, counts] = await Promise.all([
      this.ds.getRepository(RoleEntity).find({ order: { isSystem: 'DESC', name: 'ASC' } }),
      this.load(),
      this.ds.getRepository(User).createQueryBuilder('u').select('u.role', 'role').addSelect('COUNT(*)', 'n').addSelect('COUNT(*) FILTER (WHERE u.active)', 'active').groupBy('u.role').getRawMany<{ role: string; n: string; active: string }>()
    ]);
    const byRole = new Map(counts.map(c => [c.role, c]));
    return roles.map(r => this.roleToFrontend(r, map.get(r.id)?.permissions ?? [], byRole.get(r.id)));
  }

  async getRole(id: string) {
    const r = await this.ds.getRepository(RoleEntity).findOne({ where: { id } });
    if (!r) throw Errors.notFound('Role');
    const perms = (await this.ds.getRepository(RolePermission).find({ where: { roleId: id } })).map(g => g.permissionKey).sort();
    const c = await this.ds.getRepository(User).createQueryBuilder('u').select('COUNT(*)', 'n').addSelect('COUNT(*) FILTER (WHERE u.active)', 'active').where('u.role = :id', { id }).getRawOne<{ n: string; active: string }>();
    return this.roleToFrontend(r, perms, c);
  }

  private roleToFrontend(r: RoleEntity, permissions: string[], count?: { n: string; active: string }) {
    return {
      id: r.id, name: r.name, level: r.level, description: r.description, baseRole: r.baseRole || r.id, isSystem: r.isSystem, active: r.active,
      permissions, userCount: Number(count?.n ?? 0), activeUserCount: Number(count?.active ?? 0),
      lockedPermissions: r.id === Role.ADMIN ? ADMIN_LOCKED_PERMISSIONS : [],
      createdAt: r.createdAt?.toISOString?.() ?? null, updatedAt: r.updatedAt?.toISOString?.() ?? null
    };
  }

  private async assertPermissionKeys(m: EntityManager, keys: string[]) {
    const unique = [...new Set(keys)];
    const found = await m.getRepository(PermissionEntity).count({ where: { key: In(unique.length ? unique : ['-']) } });
    if (found !== unique.length) {
      const known = new Set((await m.getRepository(PermissionEntity).find({ select: { key: true } })).map(p => p.key));
      throw Errors.unprocessable('Unknown permission(s)', { unknown: unique.filter(k => !known.has(k)) });
    }
    return unique;
  }

  async createRole(actor: AuthUser, dto: CreateRoleDto, ctx: RequestContext) {
    const id = dto.id.toUpperCase();
    if (!SYSTEM_ROLES.includes(dto.baseRole)) throw Errors.unprocessable('baseRole must be a system role', { allowed: SYSTEM_ROLES });
    const saved = await this.ds.transaction(async m => {
      if (await m.getRepository(RoleEntity).exist({ where: { id } })) throw Errors.conflict(`Role ${id} already exists`);
      const keys = await this.assertPermissionKeys(m, dto.permissions);
      const base = SYSTEM_ROLE_META[dto.baseRole];
      await m.getRepository(RoleEntity).insert({
        id, name: dto.name.trim(), level: dto.level?.trim() || base?.level || 'National', description: dto.description?.trim() || null,
        baseRole: dto.baseRole, isSystem: false, active: true
      });
      if (keys.length) await m.getRepository(RolePermission).insert(keys.map(permissionKey => ({ roleId: id, permissionKey, grantedBy: actor.id })));
      await this.audit.record(actor, 'ROLE_CREATED', id, { name: dto.name, baseRole: dto.baseRole, permissions: keys }, ctx, m);
      return id;
    });
    this.invalidate();
    return this.getRole(saved);
  }

  async updateRole(actor: AuthUser, id: string, dto: UpdateRoleDto, ctx: RequestContext) {
    await this.ds.transaction(async m => {
      const repo = m.getRepository(RoleEntity);
      const r = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!r) throw Errors.notFound('Role');
      const before = { name: r.name, description: r.description, level: r.level, active: r.active, permissions: (await m.getRepository(RolePermission).find({ where: { roleId: id } })).map(g => g.permissionKey).sort() };
      if (dto.active === false && r.isSystem) throw Errors.unprocessable('System roles cannot be deactivated');
      if (dto.baseRole !== undefined && dto.baseRole !== r.baseRole) {
        if (r.isSystem) throw Errors.unprocessable('The base role of a system role cannot change');
        if (!SYSTEM_ROLES.includes(dto.baseRole)) throw Errors.unprocessable('baseRole must be a system role', { allowed: SYSTEM_ROLES });
      }
      const patch: Partial<RoleEntity> = {};
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.description !== undefined) patch.description = dto.description?.trim() || null;
      if (dto.level !== undefined) patch.level = dto.level.trim();
      if (dto.active !== undefined) patch.active = dto.active;
      if (dto.baseRole !== undefined && !r.isSystem) patch.baseRole = dto.baseRole;
      patch.updatedAt = new Date(); // also bumps the cache version when only permissions change
      await repo.update({ id }, patch);
      let after = before.permissions;
      if (dto.permissions) {
        const keys = await this.assertPermissionKeys(m, dto.permissions);
        if (id === Role.ADMIN) {
          const missing = ADMIN_LOCKED_PERMISSIONS.filter(k => !keys.includes(k));
          if (missing.length) throw Errors.unprocessable('The System Administrator role must keep user and role administration', { required: missing });
        }
        const grants = m.getRepository(RolePermission);
        const toRemove = before.permissions.filter(k => !keys.includes(k));
        const toAdd = keys.filter(k => !before.permissions.includes(k));
        if (toRemove.length) await grants.delete({ roleId: id, permissionKey: In(toRemove) });
        if (toAdd.length) await grants.insert(toAdd.map(permissionKey => ({ roleId: id, permissionKey, grantedBy: actor.id })));
        after = keys.sort();
      }
      await this.assertAdministrable(m);
      const added = after.filter(k => !before.permissions.includes(k));
      const removed = before.permissions.filter(k => !after.includes(k));
      await this.audit.record(actor, 'ROLE_UPDATED', id, {
        old: { ...before, permissions: undefined }, new: { ...patch, updatedAt: undefined }, permissionsAdded: added, permissionsRemoved: removed
      }, ctx, m);
    });
    this.invalidate();
    return this.getRole(id);
  }

  async deleteRole(actor: AuthUser, id: string, ctx: RequestContext) {
    await this.ds.transaction(async m => {
      const r = await m.getRepository(RoleEntity).findOne({ where: { id } });
      if (!r) throw Errors.notFound('Role');
      if (r.isSystem) throw Errors.unprocessable('System roles cannot be deleted');
      const users = await m.getRepository(User).count({ where: { role: id } });
      if (users) throw Errors.conflict(`Role ${id} is assigned to ${users} user(s); reassign them first (or deactivate the role)`);
      await m.getRepository(RoleEntity).delete({ id });
      await this.audit.record(actor, 'ROLE_DELETED', id, { name: r.name, baseRole: r.baseRole }, ctx, m);
    });
    this.invalidate();
    return { deleted: true, id };
  }

  /** At least one active user must still be able to manage users AND roles after any change. */
  async assertAdministrable(m: EntityManager) {
    const n = await m.query(
      `SELECT COUNT(*)::int AS n FROM users u JOIN roles r ON r.id = u.role AND r.active
        WHERE u.active
          AND EXISTS (SELECT 1 FROM role_permissions g WHERE g.role_id = u.role AND g.permission_key = 'users:manage')
          AND EXISTS (SELECT 1 FROM role_permissions g WHERE g.role_id = u.role AND g.permission_key = 'roles:manage')`
    );
    if (!n[0]?.n) throw Errors.unprocessable('This change would leave no active user able to administer users and roles');
  }
}
