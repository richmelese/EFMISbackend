// User, role and permission management (REQ-1.7-001): database-backed RBAC, custom roles, scope validation,
// temporary passwords, forced password change, session revocation, lockout protection and audit.
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { SeedService } from '../src/database/seeds/seed.service';

describe('RBAC: users, roles and permissions (e2e)', () => {
  let app: NestExpressApplication;
  let http: any;
  const t: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const api = (method: 'get' | 'post' | 'patch' | 'delete', url: string, token?: string) => {
    const r = request(http)[method](`/api${url}`);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  const login = (email: string, password: string) => api('post', '/auth/login').send({ email, password });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    const seeder = app.get(SeedService);
    await seeder.reset();
    await seeder.seed();
    t.ADMIN = (await api('post', '/auth/demo-login').send({ role: 'ADMIN' })).body.token;
    t.DISPATCHER = (await api('post', '/auth/demo-login').send({ role: 'DISPATCHER' })).body.token;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('permission catalogue and system roles come from the database', async () => {
    const perms = await api('get', '/permissions', t.ADMIN).expect(200);
    expect(perms.body.find((p: any) => p.key === 'roles:manage')).toMatchObject({ group: 'Administration', sensitive: true });
    const roles = await api('get', '/roles', t.ADMIN).expect(200);
    const disp = roles.body.find((r: any) => r.id === 'DISPATCHER');
    expect(disp).toMatchObject({ isSystem: true, baseRole: 'DISPATCHER' });
    expect(disp.permissions).toEqual(expect.arrayContaining(['shipments:manage', 'trips:dispatch']));
    const me = await api('get', '/auth/me', t.DISPATCHER).expect(200);
    expect(me.body.permissions).toEqual(expect.arrayContaining(['trips:dispatch']));
    // only administrators manage users/roles
    await api('get', '/roles', t.DISPATCHER).expect(403);
    await api('get', '/users', t.DISPATCHER).expect(403);
  });

  it('custom role: based on DISPATCHER (data scope) with a reduced permission set', async () => {
    const bad = await api('post', '/roles', t.ADMIN).send({ id: 'X_ROLE', name: 'Bad role', baseRole: 'DISPATCHER', permissions: ['nope:never'] });
    expect(bad.status).toBe(422);
    const r = await api('post', '/roles', t.ADMIN).send({
      id: 'regional_logistics_officer', name: 'Regional Logistics Officer', baseRole: 'DISPATCHER', level: 'Region',
      permissions: ['shipments:read', 'tracking:read']
    }).expect(201);
    expect(r.body).toMatchObject({ id: 'REGIONAL_LOGISTICS_OFFICER', isSystem: false, baseRole: 'DISPATCHER', permissions: ['shipments:read', 'tracking:read'] });
    expect((await api('post', '/roles', t.ADMIN).send({ id: 'REGIONAL_LOGISTICS_OFFICER', name: 'Dup', baseRole: 'DISPATCHER', permissions: [] })).status).toBe(409);
  });

  it('user creation validates scope and uniqueness; temporary password shown once', async () => {
    const noScope = await api('post', '/users', t.ADMIN).send({ name: 'Kebele Officer X', email: 'kx@efmis.test', role: 'KEBELE' });
    expect(noScope.status).toBe(422);
    expect(JSON.stringify(noScope.body)).toContain('kebele');
    const weak = await api('post', '/users', t.ADMIN).send({ name: 'Weak Pw', email: 'weak@efmis.test', role: 'DISPATCHER', password: 'password' });
    expect(weak.status).toBe(422);
    const u = await api('post', '/users', t.ADMIN).send({ name: 'Almaz Tesfaye', email: 'Almaz.T@efmis.test', phone: '0911555001', role: 'REGIONAL_LOGISTICS_OFFICER', title: 'Oromia logistics officer' }).expect(201);
    expect(u.body.user).toMatchObject({ email: 'almaz.t@efmis.test', role: 'REGIONAL_LOGISTICS_OFFICER', roleName: 'Regional Logistics Officer', baseRole: 'DISPATCHER', mustChangePassword: true });
    expect(u.body.temporaryPassword).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/);
    ids.ALMAZ = u.body.user.id;
    t.ALMAZ_TEMP_PW = u.body.temporaryPassword;
    const dup = await api('post', '/users', t.ADMIN).send({ name: 'Someone', email: 'ALMAZ.T@efmis.test', role: 'AUDITOR' });
    expect(dup.status).toBe(409);
    const list = await api('get', '/users?q=almaz', t.ADMIN).expect(200);
    expect(list.body.total).toBe(1);
  });

  it('temporary password: everything blocked until the user changes it; old sessions die', async () => {
    const l = await login('almaz.t@efmis.test', t.ALMAZ_TEMP_PW).expect(200);
    expect(l.body.user.mustChangePassword).toBe(true);
    const tmp = l.body.token;
    const blocked = await api('get', '/v1/shipments', tmp).expect(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await api('get', '/auth/me', tmp).expect(200);
    await new Promise(r => setTimeout(r, 1100)); // iat has 1 s resolution
    await api('post', '/auth/me/password', tmp).send({ currentPassword: t.ALMAZ_TEMP_PW, newPassword: 'Oromia-Logistics-2026' }).expect(200);
    await api('get', '/auth/me', tmp).expect(401); // that session is now invalid
    await new Promise(r => setTimeout(r, 1100));
    t.ALMAZ = (await login('almaz.t@efmis.test', 'Oromia-Logistics-2026').expect(200)).body.token;
  });

  it('permissions enforced from the role and changed live by the administrator', async () => {
    await api('get', '/v1/shipments', t.ALMAZ).expect(200);
    const denied = await api('post', '/v1/shipments', t.ALMAZ).send({});
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain('Regional Logistics Officer');
    const upd = await api('patch', '/roles/REGIONAL_LOGISTICS_OFFICER', t.ADMIN).send({ permissions: ['shipments:read', 'tracking:read', 'shipments:manage'] }).expect(200);
    expect(upd.body.permissions).toContain('shipments:manage');
    // now authorised (body validation fails instead → 422, not 403)
    expect((await api('post', '/v1/shipments', t.ALMAZ).send({})).status).toBe(422);
    // data scope follows the base role: fleet-wide like a dispatcher
    expect((await api('get', '/v1/trips?active=true', t.ALMAZ)).status).toBe(200);
  });

  it('lockout protection: ADMIN keeps user/role administration; no self-deactivation', async () => {
    const admin = await api('get', '/roles/ADMIN', t.ADMIN).expect(200);
    const strip = await api('patch', '/roles/ADMIN', t.ADMIN).send({ permissions: admin.body.permissions.filter((p: string) => p !== 'users:manage') });
    expect(strip.status).toBe(422);
    const me = await api('get', '/auth/me', t.ADMIN).expect(200);
    expect((await api('post', `/users/${me.body.id}/deactivate`, t.ADMIN).send({ reason: 'test' })).status).toBe(422);
    expect((await api('patch', '/roles/DISPATCHER', t.ADMIN).send({ active: false })).status).toBe(422);
    expect((await api('delete', '/roles/DISPATCHER', t.ADMIN)).status).toBe(422);
  });

  it('deactivation and password reset revoke sessions immediately', async () => {
    await new Promise(r => setTimeout(r, 1100));
    await api('post', `/users/${ids.ALMAZ}/deactivate`, t.ADMIN).send({ reason: 'Transferred to another agency' }).expect(200);
    await api('get', '/v1/shipments', t.ALMAZ).expect(401);
    expect((await login('almaz.t@efmis.test', 'Oromia-Logistics-2026')).status).toBe(401);
    await api('post', `/users/${ids.ALMAZ}/reactivate`, t.ADMIN).expect(200);
    const reset = await api('post', `/users/${ids.ALMAZ}/reset-password`, t.ADMIN).send({}).expect(200);
    expect(reset.body).toMatchObject({ mustChangePassword: true, sessionsRevoked: true });
    expect((await login('almaz.t@efmis.test', 'Oromia-Logistics-2026')).status).toBe(401);
    expect((await login('almaz.t@efmis.test', reset.body.temporaryPassword)).status).toBe(200);
  });

  it('scope moves up/across the hierarchy: DA in a kebele → WOREDA officer of another woreda', async () => {
    const regions = (await api('get', '/regions', t.ADMIN).expect(200)).body;
    const list = Array.isArray(regions) ? regions : regions.items;
    const woredas = list.flatMap((r: any) => (r.zones || []).flatMap((z: any) => z.woredas || []));
    const withKebele = woredas.find((w: any) => (w.kebeles || []).length);
    const other = woredas.find((w: any) => w.id !== withKebele.id);
    const da = await api('post', '/users', t.ADMIN).send({ name: 'Scope Mover', email: 'scope.mover@efmis.test', role: 'DA', kebeleId: withKebele.kebeles[0].id }).expect(201);
    expect(da.body.user.kebeleId).toBe(withKebele.kebeles[0].id);
    const moved = await api('patch', `/users/${da.body.user.id}`, t.ADMIN).send({ role: 'WOREDA', woredaId: other.id }).expect(200);
    expect(moved.body).toMatchObject({ role: 'WOREDA', woredaId: other.id, kebeleId: null });
    // role change alone keeps the scope
    const kept = await api('patch', `/users/${da.body.user.id}`, t.ADMIN).send({ title: 'Woreda crop officer' });
    expect(kept.status).toBe(200);
    expect(kept.body.woredaId).toBe(other.id);
  });

  it('brute-force lockout: 5 failures lock the account for 15 minutes, even with the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await login('almaz.t@efmis.test', 'Wrong-Password-1')).status).toBe(401);
    const locked = await login('almaz.t@efmis.test', 'Oromia-Logistics-2026');
    expect(locked.status).toBe(429);
  });

  it('role in use cannot be deleted; role change and every admin action is audited', async () => {
    expect((await api('delete', '/roles/REGIONAL_LOGISTICS_OFFICER', t.ADMIN)).status).toBe(409);
    await api('patch', `/users/${ids.ALMAZ}`, t.ADMIN).send({ role: 'AUDITOR' }).expect(200);
    await api('delete', '/roles/REGIONAL_LOGISTICS_OFFICER', t.ADMIN).expect(200);
    const audit = await api('get', `/users/${ids.ALMAZ}/audit`, t.ADMIN).expect(200);
    const actions = audit.body.map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['USER_CREATED', 'PASSWORD_CHANGED', 'USER_DEACTIVATED', 'USER_REACTIVATED', 'USER_PASSWORD_RESET', 'USER_ROLE_CHANGED']));
    const roleChange = audit.body.find((a: any) => a.action === 'USER_ROLE_CHANGED');
    expect(roleChange.details).toMatchObject({ old: { role: 'REGIONAL_LOGISTICS_OFFICER' }, new: { role: 'AUDITOR' } });
  });
});
