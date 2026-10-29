// Backend architecture Stage B: platform modules (seasons, admin-units, workflow, outbox).
import { DataSource } from 'typeorm';
import { SettingsService } from '../src/modules/settings/settings.service';
import { SEED_USERS, startTestApi, TestApi } from './helpers/e2e';
import { registerTestWorkflows } from './helpers/workflow-fixtures';
import { DomainEvents } from '../src/common/events';
import { DEMO_PIN } from '../src/database/seeds/seed.service';
import { ApprovalsService } from '../src/modules/workflow/approvals.service';
import { WorkflowRegistry } from '../src/modules/workflow/workflow.registry';
import { WorkflowService } from '../src/modules/workflow/workflow.service';
import { WorkflowAdvanced } from '../src/modules/workflow/workflow.types';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { OutboxService } from '../src/modules/outbox/outbox.service';
import { OutboxMessage } from '../src/modules/outbox/entities/outbox-message.entity';
import { ChannelAdapter } from '../src/modules/outbox/outbox.types';

describe('Architecture Stage B (e2e)', () => {
  let t: TestApi;

  beforeAll(async () => {
    t = await startTestApi();
    registerTestWorkflows(t.app.get(WorkflowRegistry));
  });

  afterAll(async () => {
    await t?.close();
  });

  describe('seasons', () => {
    it('seeds the current season from settings and lists all seasons', async () => {
      const token = await t.loginAsUser(SEED_USERS.WONJI_KEBELE);
      const cur = await t.call('get', '/v1/seasons/current', token);
      expect(cur.status).toBe(200);
      expect(cur.body).toMatchObject({ id: 'MEHER-2026', name: 'Meher 2026', type: 'MEHER', year: 2026, status: 'OPEN', isCurrent: true });

      const list = await t.call('get', '/v1/seasons', token);
      expect(list.status).toBe(200);
      expect(list.body.map((s: any) => [s.id, s.status])).toEqual([
        ['IRRIGATION-2026', 'PLANNING'], ['MEHER-2026', 'OPEN'], ['BELG-2026', 'CLOSED']
      ]);
      expect((await t.call('get', '/v1/seasons/BELG-2026', token)).body.collectionDeadline).toBe('2025-11-30');
      expect((await t.call('get', '/v1/seasons/NOPE', token)).status).toBe(404);
      expect((await t.call('get', '/v1/seasons')).status).toBe(401);
    });

    it('SettingsService.currentSeason() wraps the seasons table', async () => {
      expect(await t.app.get(SettingsService).currentSeason()).toBe('Meher 2026');
    });

    it('changing systemMetadata.currentSeason switches the current season', async () => {
      const admin = await t.loginAs('ADMIN');
      const put = (currentSeason: string) =>
        t.call('put', '/settings/systemMetadata', admin).send({ value: { currentSeason }, justification: 'Season rollover test' });

      expect((await put('Irrigation 2026-27')).status).toBe(200);
      expect((await t.call('get', '/v1/seasons/current', admin)).body).toMatchObject({ id: 'IRRIGATION-2026', status: 'OPEN' });
      expect(await t.app.get(SettingsService).currentSeason()).toBe('Irrigation 2026-27');

      expect((await put('Winter 2027')).status).toBe(400);
      expect((await t.call('get', '/v1/seasons/current', admin)).body.id).toBe('IRRIGATION-2026');

      expect((await put('Meher 2026')).status).toBe(200);
      expect((await t.call('get', '/v1/seasons/current', admin)).body.id).toBe('MEHER-2026');
    });
  });

  describe('admin-units', () => {
    it('backfills the legacy hierarchy with the same IDs and ltree paths', async () => {
      const ds = t.app.get(DataSource);
      const [counts] = await ds.query(`
        SELECT (SELECT count(*) FROM admin_units WHERE type = 'REGION')::int AS regions, (SELECT count(*) FROM regions)::int AS legacy_regions,
               (SELECT count(*) FROM admin_units WHERE type = 'KEBELE')::int AS kebeles, (SELECT count(*) FROM kebeles)::int AS legacy_kebeles,
               (SELECT count(*) FROM kebeles k JOIN admin_units a ON a.id = k.id AND a.parent_id = k.woreda_id)::int AS kebeles_same_parent`);
      expect(counts.regions).toBe(counts.legacy_regions);
      expect(counts.kebeles).toBe(counts.legacy_kebeles);
      expect(counts.kebeles_same_parent).toBe(counts.legacy_kebeles);
      const [wonji] = await ds.query(`SELECT path::text FROM admin_units WHERE id = 'KEB-01'`);
      expect(wonji.path).toBe('ET.REG_OROMIA.ZONE_OR_ESHEWA.WOR_OR_ADAMA.KEB_01');
      const users = await ds.query(`SELECT email, admin_unit_id FROM users WHERE email = ANY($1) ORDER BY email`, [[SEED_USERS.ADAMA_WOREDA, SEED_USERS.DA_WONJI, SEED_USERS.MOA, SEED_USERS.OROMIA_REGION]]);
      expect(Object.fromEntries(users.map((u: any) => [u.email, u.admin_unit_id]))).toEqual({
        [SEED_USERS.ADAMA_WOREDA]: 'WOR-OR-ADAMA', [SEED_USERS.DA_WONJI]: 'KEB-01', [SEED_USERS.MOA]: null, [SEED_USERS.OROMIA_REGION]: 'REG-OROMIA'
      });
    });

    it('the principal carries its unit and path', async () => {
      const me = await t.call('get', '/auth/me', await t.loginAsUser(SEED_USERS.ADAMA_WOREDA));
      expect(me.body).toMatchObject({ adminUnitId: 'WOR-OR-ADAMA', unitPath: 'ET.REG_OROMIA.ZONE_OR_ESHEWA.WOR_OR_ADAMA' });
    });

    it('tree: national roles get the country, officers only their own subtree', async () => {
      const national = await t.call('get', '/v1/admin-units/tree', await t.loginAs('MOA'));
      expect(national.status).toBe(200);
      expect(national.body).toHaveLength(1);
      expect(national.body[0]).toMatchObject({ id: 'ET', type: 'COUNTRY' });
      expect(national.body[0].children.map((r: any) => r.id)).toContain('REG-AMHARA');

      const adama = (await t.call('get', '/v1/admin-units/tree', await t.loginAsUser(SEED_USERS.ADAMA_WOREDA))).body;
      expect(adama.map((u: any) => u.id)).toEqual(['WOR-OR-ADAMA']);
      expect(adama[0].children.every((k: any) => k.type === 'KEBELE' && k.parentId === 'WOR-OR-ADAMA')).toBe(true);
      expect(adama[0].children.map((k: any) => k.id)).toContain('KEB-01');

      expect((await t.call('get', '/v1/admin-units/tree', await t.loginAs('DRIVER'))).body).toEqual([]);
    });

    it('detail: own subtree and ancestors are readable, other areas are 403', async () => {
      const token = await t.loginAsUser(SEED_USERS.ADAMA_WOREDA);
      const keb = await t.call('get', '/v1/admin-units/KEB-01', token);
      expect(keb.status).toBe(200);
      expect(keb.body.ancestors.map((a: any) => a.id)).toEqual(['ET', 'REG-OROMIA', 'ZONE-OR-ESHEWA', 'WOR-OR-ADAMA']);
      expect((await t.call('get', '/v1/admin-units/REG-OROMIA', token)).status).toBe(200);
      expect((await t.call('get', '/v1/admin-units/WOR-OR-LUME', token)).status).toBe(403);
      expect((await t.call('get', '/v1/admin-units/KEB-04', token)).status).toBe(403);
      expect((await t.call('get', '/v1/admin-units/NOPE', token)).status).toBe(404);
    });

    it('children: only inside the user unit', async () => {
      const token = await t.loginAsUser(SEED_USERS.ADAMA_WOREDA);
      const kids = await t.call('get', '/v1/admin-units/WOR-OR-ADAMA/children', token);
      expect(kids.status).toBe(200);
      expect(kids.body.length).toBeGreaterThan(0);
      expect((await t.call('get', '/v1/admin-units/WOR-OR-LUME/children', token)).status).toBe(403);
      expect((await t.call('get', '/v1/admin-units/ZONE-OR-ESHEWA/children', token)).status).toBe(403);
    });

    it('users created or moved by an administrator get their scope unit', async () => {
      const admin = await t.loginAs('ADMIN');
      const created = await t.call('post', '/users', admin).send({
        name: 'Scope Test DA', email: 'scope.da@efmis.gov.et', role: 'DA', kebeleId: 'KEB-04', password: 'Scope@2026x', mustChangePassword: false
      });
      expect(created.status).toBe(201);
      expect(created.body.user.adminUnitId).toBe('KEB-04');
      const moved = await t.call('patch', `/users/${created.body.user.id}`, admin).send({ role: 'WOREDA', woredaId: 'WOR-OR-ADAMA' });
      expect(moved.status).toBe(200);
      expect(moved.body.adminUnitId ?? moved.body.user?.adminUnitId).toBe('WOR-OR-ADAMA');
    });
  });

  describe('workflow', () => {
    const PIN = DEMO_PIN;
    let wf: WorkflowService;
    let tok: Record<string, string>;
    let caseId: string;
    const act = (who: string, id: string, body: Record<string, unknown>) => t.call('post', `/v1/workflow/cases/${id}/actions`, tok[who]).send(body);
    const get = (who: string, id: string) => t.call('get', `/v1/workflow/cases/${id}`, tok[who]);

    beforeAll(async () => {
      wf = t.app.get(WorkflowService);
      tok = {
        ADAMA: await t.loginAsUser(SEED_USERS.ADAMA_WOREDA), LUME: await t.loginAsUser(SEED_USERS.LUME_WOREDA),
        ZONE: await t.loginAsUser(SEED_USERS.EAST_SHEWA_ZONE), WONJI: await t.loginAsUser(SEED_USERS.WONJI_KEBELE),
        KOKA: await t.loginAsUser(SEED_USERS.KOKA_KEBELE), MOA: await t.loginAs('MOA')
      };
    });

    it('opens one case per unit and season', async () => {
      const c = await wf.open('TEST_PACKAGE_REVIEW', { id: 'WOR-OR-ADAMA' }, 'WOR-OR-ADAMA', 'MEHER-2026');
      caseId = c.id;
      expect(c).toMatchObject({ entityType: 'WOREDA', entityId: 'WOR-OR-ADAMA', level: 'WOREDA', status: 'PENDING_WOREDA', version: 1 });
      expect(c.dueAt).toBeTruthy();
      await expect(wf.open('TEST_PACKAGE_REVIEW', { id: 'WOR-OR-ADAMA' }, 'WOR-OR-ADAMA', 'MEHER-2026')).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(wf.open('TEST_PACKAGE_REVIEW', { id: 'WOR-OR-ADAMA' }, 'WOR-OR-ADAMA', null)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      // another season is another case
      expect((await wf.open('TEST_PACKAGE_REVIEW', { id: 'WOR-OR-ADAMA' }, 'WOR-OR-ADAMA', 'BELG-2026')).id).not.toBe(caseId);
    });

    it('available(): only actions the user may take, only for cases in scope', async () => {
      const adama = await get('ADAMA', caseId);
      expect(adama.status).toBe(200);
      expect(adama.body.available).toEqual([{ action: 'FORWARD', toStatus: 'PENDING_ZONE', signatureRequired: true, commentsRequired: false }]);
      expect(adama.body.history.map((h: any) => h.action)).toContain('OPEN');
      // the zone above can read it but has nothing to do yet; another woreda cannot read it
      expect((await get('ZONE', caseId)).body.available).toEqual([]);
      expect((await get('LUME', caseId)).body.error.code).toBe('OUT_OF_SCOPE');
      expect((await t.call('get', `/v1/workflow/cases/${caseId}/available`, tok.ADAMA)).body.map((a: any) => a.action)).toEqual(['FORWARD']);
    });

    it('act(): scope, permission, signature, transition and version are enforced', async () => {
      expect((await act('LUME', caseId, { action: 'FORWARD', pin: PIN })).body.error.code).toBe('OUT_OF_SCOPE');
      expect((await act('ADAMA', caseId, { action: 'FORWARD' })).status).toBe(400);
      expect((await act('ADAMA', caseId, { action: 'FORWARD', pin: '0000' })).status).toBe(401);
      expect((await act('ADAMA', caseId, { action: 'APPROVE', pin: PIN })).status).toBe(409);
      expect((await act('ADAMA', caseId, { action: 'FORWARD', pin: PIN, expectedVersion: 7 })).status).toBe(409);

      const fwd = await act('ADAMA', caseId, { action: 'FORWARD', pin: PIN, expectedVersion: 1, comments: 'Package complete' });
      expect(fwd.status).toBe(200);
      expect(fwd.body).toMatchObject({ status: 'PENDING_ZONE', level: 'ZONE', assigneeUnitId: 'ZONE-OR-ESHEWA', originUnitId: 'WOR-OR-ADAMA', version: 2, closed: false });
      // now the woreda may only watch; the zone acts
      expect((await get('ADAMA', caseId)).body.available).toEqual([]);
      expect((await get('ZONE', caseId)).body.available.map((a: any) => a.action)).toEqual(['RETURN', 'APPROVE']);
      expect((await act('ADAMA', caseId, { action: 'RETURN', comments: 'x' })).body.error.code).toBe('FORBIDDEN'); // lacks zone:review
    });

    it('notifies the roles that act next, in the new assignee unit', async () => {
      const zone = await t.call('get', '/notifications', tok.ZONE);
      expect(zone.body.some((n: any) => n.title === 'TEST_PACKAGE_REVIEW: PENDING_ZONE')).toBe(true);
      const lume = await t.call('get', '/notifications', tok.LUME);
      expect(lume.body.some((n: any) => n.title === 'TEST_PACKAGE_REVIEW: PENDING_ZONE')).toBe(false);
    });

    it('return goes back to the origin unit; comments required', async () => {
      expect((await act('ZONE', caseId, { action: 'RETURN' })).status).toBe(400);
      const ret = await act('ZONE', caseId, { action: 'RETURN', comments: 'Kebele 3 totals missing' });
      expect(ret.body).toMatchObject({ status: 'PENDING_WOREDA', level: 'WOREDA', assigneeUnitId: 'WOR-OR-ADAMA', version: 3 });
    });

    it('publishes WorkflowAdvanced in the same transaction (a failing handler rolls the action back)', async () => {
      const events = t.app.get(DomainEvents);
      const seen: WorkflowAdvanced[] = [];
      const off = events.subscribe(WorkflowAdvanced, e => {
        seen.push(e);
        if (e.toStatus === 'PENDING_ZONE') throw new Error('domain handler refused');
      });
      try {
        expect((await act('ADAMA', caseId, { action: 'FORWARD', pin: PIN })).status).toBe(500);
        const after = await get('ADAMA', caseId);
        expect(after.body.case).toMatchObject({ status: 'PENDING_WOREDA', version: 3 });
        expect(after.body.history.filter((h: any) => h.action === 'FORWARD')).toHaveLength(1);
      } finally {
        off();
      }
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ caseId, action: 'FORWARD', fromStatus: 'PENDING_WOREDA', entityType: 'WOREDA', entityId: 'WOR-OR-ADAMA' });
    });

    it('closes on a terminal status, with signature and audit', async () => {
      expect((await act('ADAMA', caseId, { action: 'FORWARD', pin: PIN })).status).toBe(200);
      const ok = await act('ZONE', caseId, { action: 'APPROVE', pin: PIN });
      expect(ok.body).toMatchObject({ status: 'APPROVED', closed: true, dueAt: null });
      expect((await get('ZONE', caseId)).body.available).toEqual([]);
      expect((await act('ZONE', caseId, { action: 'RETURN', comments: 'too late' })).status).toBe(409);
      const ds = t.app.get(DataSource);
      const [audit] = await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE target = 'WOREDA:WOR-OR-ADAMA' AND action LIKE 'WORKFLOW_%'`);
      expect(audit.n).toBe(4); // FORWARD, RETURN, FORWARD, APPROVE (the rolled-back FORWARD left nothing)
      const [sig] = await ds.query(`SELECT count(*)::int AS n FROM signatures WHERE target_type = 'WORKFLOW:TEST_PACKAGE_REVIEW' AND target_id = $1`, [caseId]);
      expect(sig.n).toBe(3);
    });

    it('workflow_actions are write-once', async () => {
      const ds = t.app.get(DataSource);
      await expect(ds.query(`UPDATE workflow_actions SET comments = 'tampered' WHERE case_id = $1`, [caseId])).rejects.toThrow(/immutable/);
      await expect(ds.query(`DELETE FROM workflow_actions WHERE case_id = $1`, [caseId])).rejects.toThrow(/immutable/);
    });

    it('history merges legacy approval_actions with workflow actions (in time order)', async () => {
      const legacyUser = { id: 'U-WOR-01', name: 'Adama Woreda Agronomist', role: 'WOREDA' } as any;
      await t.app.get(ApprovalsService).record(legacyUser, { entityType: 'WOREDA', entityId: 'WOR-OR-ADAMA', level: 'WOREDA', action: 'HOLD', comments: 'legacy decision' });
      const h = await t.call('get', '/v1/workflow/history?entityType=WOREDA&entityId=WOR-OR-ADAMA', tok.ADAMA);
      expect(h.status).toBe(200);
      expect(new Set(h.body.map((e: any) => e.source))).toEqual(new Set(['LEGACY', 'WORKFLOW']));
      expect(h.body.find((e: any) => e.source === 'LEGACY' && e.action === 'HOLD').comments).toBe('legacy decision');
      expect(h.body.map((e: any) => e.at)).toEqual([...h.body.map((e: any) => e.at)].sort());
      expect((await t.call('get', '/v1/workflow/history?entityType=WOREDA&entityId=WOR-OR-ADAMA', tok.LUME)).body.error.code).toBe('OUT_OF_SCOPE');
      // a unit without cases: legacy history, scope by unit
      expect((await t.call('get', '/v1/workflow/history?entityType=ZONE&entityId=ZONE-OR-ESHEWA', tok.ADAMA)).status).toBe(200);
      expect((await t.call('get', '/v1/workflow/history?entityType=FARMER&entityId=NOPE', tok.ADAMA)).status).toBe(404);
      const cases = await t.call('get', '/v1/workflow/cases?entityType=WOREDA&entityId=WOR-OR-ADAMA', tok.ADAMA);
      expect(cases.body.map((c: any) => c.seasonId).sort()).toEqual(['BELG-2026', 'MEHER-2026']);
      expect((await t.call('get', '/v1/workflow/cases?entityType=WOREDA&entityId=WOR-OR-ADAMA', tok.LUME)).body).toEqual([]);
    });

    it('per-record cases at a kebele', async () => {
      const c = await wf.open('TEST_RECORD_REVIEW', { id: 'REC-1' }, 'KEB-01', null);
      expect(c).toMatchObject({ entityType: 'TEST_RECORD', level: 'KEBELE' });
      await expect(wf.open('TEST_RECORD_REVIEW', { id: 'REC-1' }, 'KEB-01', null)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await act('KOKA', c.id, { action: 'APPROVE' })).body.error.code).toBe('OUT_OF_SCOPE');
      expect((await act('WONJI', c.id, { action: 'REJECT' })).status).toBe(400);
      expect((await act('WONJI', c.id, { action: 'APPROVE' })).body).toMatchObject({ status: 'APPROVED', closed: true });
    });

    it('scheduler: overdue cases escalate up the chain, then get reminders', async () => {
      const ds = t.app.get(DataSource);
      const c = await wf.open('TEST_PACKAGE_REVIEW', { id: 'WOR-OR-LUME' }, 'WOR-OR-LUME', 'MEHER-2026');
      const r = await wf.open('TEST_RECORD_REVIEW', { id: 'REC-2' }, 'KEB-04', null);
      const overdue = () => ds.query(`UPDATE workflow_cases SET due_at = now() - interval '1 hour' WHERE id = ANY($1)`, [[c.id, r.id]]);
      const level = async () => (await ds.query(`SELECT escalation_level FROM workflow_cases WHERE id = $1`, [c.id]))[0].escalation_level;

      await overdue();
      expect(await wf.processDeadlines()).toEqual({ reminders: 1, escalations: 1 });
      expect(await level()).toBe(1);
      const zone = await t.call('get', '/notifications', tok.ZONE);
      expect(zone.body.some((n: any) => n.title === 'Escalation: TEST_PACKAGE_REVIEW overdue')).toBe(true);
      expect(await wf.processDeadlines()).toEqual({ reminders: 0, escalations: 0 }); // not due again yet

      await overdue();
      await wf.processDeadlines();
      expect(await level()).toBe(2); // region
      await overdue();
      expect(await wf.processDeadlines()).toEqual({ reminders: 2, escalations: 0 }); // max level reached: reminders
      const esc = await ds.query(`SELECT details FROM workflow_actions WHERE case_id = $1 AND action = 'ESCALATE' ORDER BY id`, [c.id]);
      expect(esc.map((a: any) => a.details.notifiedUnitId)).toEqual(['ZONE-OR-ESHEWA', 'REG-OROMIA']);
    });
  });

  describe('outbox', () => {
    let outbox: OutboxService;
    let ds: DataSource;
    const row = (id: string) => ds.getRepository(OutboxMessage).findOneByOrFail({ id });
    const makeDue = (id: string) => ds.query(`UPDATE outbox_messages SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);

    beforeAll(() => {
      outbox = t.app.get(OutboxService);
      ds = t.app.get(DataSource);
    });

    it('a message exists only if the business transaction commits; dedupe keys are idempotent', async () => {
      let rolledBack: string | null = null;
      await expect(ds.transaction(async m => {
        rolledBack = await outbox.enqueue({ channel: 'EMAIL', payload: { to: ['a@x.et'], title: 'rolled back' } }, m);
        throw new Error('business rule failed');
      })).rejects.toThrow('business rule failed');
      expect(await ds.getRepository(OutboxMessage).findOneBy({ id: rolledBack! })).toBeNull();

      const first = await ds.transaction(m => outbox.enqueue({ channel: 'SMS', payload: { to: ['0911000000'] }, dedupeKey: 'test-dedupe-1' }, m));
      const again = await ds.transaction(m => outbox.enqueue({ channel: 'SMS', payload: { to: ['0911000000'] }, dedupeKey: 'test-dedupe-1' }, m));
      expect(first).toEqual(expect.any(String));
      expect(again).toBeNull();
      expect((await row(first!)).status).toBe('PENDING');
    });

    it('notify() keeps the in-app row and enqueues EMAIL / SMS for the recipients', async () => {
      const before = await ds.getRepository(OutboxMessage).count();
      await t.app.get(NotificationsService).notify({ role: 'WOREDA', unitId: 'WOR-OR-ADAMA', title: 'Outbox test', message: 'hello', channels: ['IN_APP', 'EMAIL', 'SMS'] });
      const inApp = await t.call('get', '/notifications', await t.loginAsUser(SEED_USERS.ADAMA_WOREDA));
      expect(inApp.body.some((n: any) => n.title === 'Outbox test')).toBe(true);
      const msgs = await ds.getRepository(OutboxMessage).find({ order: { createdAt: 'DESC' }, take: 2 });
      expect(await ds.getRepository(OutboxMessage).count()).toBe(before + 2);
      const email = msgs.find(m => m.channel === 'EMAIL')!;
      expect(email.payload).toMatchObject({ kind: 'NOTIFICATION', title: 'Outbox test' });
      expect(email.payload.to).toEqual(expect.arrayContaining([SEED_USERS.ADAMA_WOREDA]));
      expect(email.payload.to).not.toContain(SEED_USERS.LUME_WOREDA);
      expect(msgs.find(m => m.channel === 'SMS')!.payload.to).toContain('0911000012');
      // no recipient → nothing to send
      await t.app.get(NotificationsService).notify({ role: 'WOREDA', unitId: 'KEB-99-NOWHERE', title: 'nobody', message: 'x', channels: ['EMAIL'] });
      expect(await ds.getRepository(OutboxMessage).count()).toBe(before + 2);

      expect(await outbox.drain()).toBeGreaterThanOrEqual(2);
      expect((await row(email.id))).toMatchObject({ status: 'SENT', attempts: 1, providerRef: `stub-${email.id}` });
    });

    it('failed sends back off exponentially, then go DEAD with one alert per channel per day', async () => {
      const calls: string[] = [];
      const failing: ChannelAdapter = { channel: 'WEBHOOK', send: async (_p, id) => { calls.push(id); throw new Error('receiver down'); } };
      outbox.registerAdapter(failing);
      const ids = await ds.transaction(async m => [
        await outbox.enqueue({ channel: 'WEBHOOK', payload: { url: 'https://example.test/a' }, maxAttempts: 2 }, m),
        await outbox.enqueue({ channel: 'WEBHOOK', payload: { url: 'https://example.test/b' }, maxAttempts: 2 }, m)
      ]);
      await outbox.drain();
      const failed = await row(ids[0]!);
      expect(failed).toMatchObject({ status: 'FAILED', attempts: 1, lastError: 'receiver down' });
      expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
      expect(await outbox.drain()).toBe(0); // backing off

      for (const id of ids) await makeDue(id!);
      await outbox.drain();
      expect((await row(ids[0]!)).status).toBe('DEAD');
      expect((await row(ids[1]!)).status).toBe('DEAD');
      expect(calls).toHaveLength(4);
      const [alerts] = await ds.query(`SELECT count(*)::int AS n FROM alerts WHERE dedupe_key LIKE 'OUTBOX-DEAD-WEBHOOK-%'`);
      expect(alerts.n).toBe(1);
    });

    it('acknowledgements: ACKED on confirmation, alert when overdue', async () => {
      outbox.registerAdapter({ channel: 'EXTERNAL_API', send: async () => ({ providerRef: 'ext-1' }) });
      const [a, b] = await ds.transaction(async m => [
        await outbox.enqueue({ channel: 'EXTERNAL_API', payload: { op: 'po' }, ackWithinHours: 48 }, m),
        await outbox.enqueue({ channel: 'EXTERNAL_API', payload: { op: 'po' }, ackWithinHours: 48 }, m)
      ]);
      await outbox.drain();
      expect(await row(a!)).toMatchObject({ status: 'SENT', providerRef: 'ext-1' });
      expect((await row(a!)).ackDueAt).toBeTruthy();
      await outbox.ack(a!);
      expect((await row(a!)).status).toBe('ACKED');
      await expect(outbox.ack(a!)).rejects.toMatchObject({ code: 'CONFLICT' });

      expect(await outbox.checkAckOverdue()).toBe(0);
      await ds.query(`UPDATE outbox_messages SET ack_due_at = now() - interval '1 minute' WHERE id = $1`, [b]);
      expect(await outbox.checkAckOverdue()).toBe(1);
      const [alerts] = await ds.query(`SELECT count(*)::int AS n FROM alerts WHERE dedupe_key LIKE 'OUTBOX-ACK-EXTERNAL_API-%'`);
      expect(alerts.n).toBe(1);
    });
  });
});
