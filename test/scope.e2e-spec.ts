// Unified data scope (Stage B3): every endpoint of the area-scoped modules is called by an officer of a DIFFERENT unit
// (Lume vs Adama woreda, Koka vs Wonji kebele, Amhara vs Oromia region) and must answer 403 OUT_OF_SCOPE, or leave the
// other unit's rows out of a list. The coverage test at the end fails when a route of these modules has no case here
// and no written exemption — so a new endpoint cannot ship without a scope test.
import * as crypto from 'crypto';
import { buildOpenApiDocument } from '../src/main';
import { DEMO_PIN } from '../src/database/seeds/seed.service';
import { SEED_USERS, startTestApi, TestApi } from './helpers/e2e';
import { registerTestWorkflows } from './helpers/workflow-fixtures';
import { WorkflowRegistry } from '../src/modules/workflow/workflow.registry';
import { WorkflowService } from '../src/modules/workflow/workflow.service';
import { DataSource } from 'typeorm';
import { AlertsService } from '../src/modules/alerts/alerts.service';

const PIN = DEMO_PIN;
/** Adama woreda farmer (Wonji kebele KEB-01) and Lume woreda farmer (Koka kebele KEB-04). */
const ADAMA_FARMER = 'FARM-2026-04821';
const LUME_FARMER = 'FARM-2026-04823';

/** Route prefixes whose data is segmented by administrative unit. */
const SCOPED = /^\/api\/(farmers|integrations\/(fayda|nrlais|nsis)|kebele|reviews|aggregation|regions|quota|meta|bootstrap|dashboard|copilot|v1\/admin-units|v1\/workflow|(v1\/)?alerts|national|integrations\/(procurement|quality|logistics|financials)|reports)(\/|$)/;

/** Routes of those modules that are intentionally not unit-scoped, with the reason. */
const EXEMPT: Record<string, string> = {
  'GET /api/farmers/recommendation': 'agronomic formula preview; no unit data',
  'GET /api/farmers/check-duplicate': 'REQ-1.1-004: a farmer is registered once nationally, so the check searches every unit',
  'POST /api/integrations/fayda/verify': 'national ID registry lookup; no unit-owned record',
  'POST /api/integrations/nrlais/verify': 'national land registry lookup; no unit-owned record',
  'POST /api/regions/{id}/submissions/{sid}/acknowledge': 'national:edit only (MoA acknowledges every region)',
  'GET /api/quota/weights': 'national quota formula weights (Phase 8 decides regional visibility of the model)',
  'PUT /api/quota/weights': 'quota:generate, national only',
  'GET /api/quota/provisional': 'national quota model preview (Phase 8)',
  'POST /api/quota/runs': 'quota:generate, national only',
  'GET /api/quota/runs': 'national quota runs (Phase 8)',
  'GET /api/quota/runs/compare': 'national quota runs (Phase 8)',
  'GET /api/quota/runs/{id}': 'national quota runs (Phase 8)',
  'POST /api/quota/runs/{id}/publish': 'quota:generate, national only',
  'POST /api/quota/adjustment-requests/{id}/review': 'quota:decide, national only',
  'POST /api/quota/adjustment-requests/{id}/decide': 'quota:decide, national only',
  'POST /api/quota/adjustment-requests/{id}/appeal-decision': 'quota:decide, national only',
  'POST /api/quota/letters': 'quota:letter, national only',
  'POST /api/quota/procurement-requests': 'po:transmit, national procurement',
  'GET /api/quota/procurement-requests': 'national procurement (MoA / EABC)',
  'GET /api/quota/procurement-requests/{id}': 'national procurement (MoA / EABC)',
  'POST /api/quota/procurement-requests/{id}/status': 'po:acknowledge, EABC',
  'GET /api/meta': 'system metadata, no unit data',
  // alerts: lifecycle actions are alerts:manage (national roles), who see every alert
  ...Object.fromEntries(['assign', 'resolve', 'close', 'reopen', 'snooze', 'toggle'].flatMap(a => [
    [`POST /api/alerts/{id}/${a}`, 'alerts:manage, national roles only'], [`POST /api/v1/alerts/{id}/${a}`, 'alerts:manage, national roles only']
  ])),
  // national: national totals and the FTWG committee have no per-area rows; edits are national roles
  'GET /api/national/net-import': 'national total, no per-area rows',
  'GET /api/national/carry-over': 'national stock by facility tier, no per-area rows',
  'PATCH /api/national/carry-over/{type}': 'national:edit, national roles only',
  'GET /api/national/ftwg/sessions': 'national technical committee record, no per-area rows',
  'GET /api/national/ftwg/sessions/{id}': 'national technical committee record, no per-area rows',
  'GET /api/national/ftwg/sessions/{id}/minutes': 'national technical committee record, no per-area rows',
  'POST /api/national/ftwg/sessions': 'ftwg:manage, national roles only',
  'POST /api/national/ftwg/sessions/{id}/vote': 'ftwg:vote, national roles only',
  'POST /api/national/ftwg/sessions/{id}/close': 'ftwg:manage, national roles only',
  'POST /api/national/ftwg/sessions/{id}/action-items': 'ftwg:manage, national roles only',
  'PATCH /api/national/ftwg/action-items/{itemId}': 'ftwg:participate, national roles only',
  'POST /api/national/documents': 'national:edit, national roles only',
  'POST /api/national/documents/{id}/sign': 'document:sign, national roles only',
  'POST /api/national/documents/{id}/reject': 'document:sign, national roles only',
  'GET /api/national/documents/{id}/verify': 'signature verification result, no area data',
  // integrations: national procurement / quality feeds have no area; writes are partner feeds
  'GET /api/integrations/procurement': 'national tenders and vessels, no area',
  'GET /api/integrations/quality': 'national quality inspections, no area',
  'GET /api/integrations/quality/coc/{code}/verify': 'public certificate verification, no area',
  'PUT /api/integrations/procurement/tenders/{tenderNo}': 'integrations:write, national partner feed',
  'PUT /api/integrations/procurement/vessels/{imo}': 'integrations:write, national partner feed',
  'POST /api/integrations/quality/inspections': 'integrations:write, national partner feed',
  'PUT /api/integrations/logistics/trucks/{truckId}': 'integrations:write, national partner feed',
  'PUT /api/integrations/logistics/warehouses/{name}': 'integrations:write, national partner feed',
  'PUT /api/integrations/financials/ecx-prices/{commodity}': 'integrations:write, national partner feed',
  // reports: date labels carry no data; edits are reports:edit (national roles)
  'GET /api/reports/daily-summary/dates': 'report date labels only',
  'POST /api/reports/daily-summary/dates': 'reports:edit, national roles only',
  'PUT /api/reports/daily-summary/{date}/{regionId}/{fertilizerType}': 'reports:edit, national roles only',
  'POST /api/reports/regional/lots': 'reports:edit, national roles only',
  'PATCH /api/reports/regional/lots/{lotId}/unions/{unionId}/loads': 'reports:edit, national roles only',
  'POST /api/reports/regional/lots/{lotId}/dispatches': 'reports:edit, national roles only',
  'POST /api/reports/regional/lots/{lotId}/dates': 'reports:edit, national roles only',
  'POST /api/reports/regional/lots/{lotId}/unions': 'reports:edit, national roles only',
  'GET /api/dashboard/overview': 'national headline figures; rebuilt on scoped totals in Phase 10',
  'POST /api/copilot/ask': 'answers from national figures; scoped in Phase 10'
};

describe('Unified scope: wrong unit → 403 (e2e)', () => {
  let t: TestApi;
  const tok: Record<string, string> = {};
  /** Records created in beforeAll by the RIGHT unit, then attacked by the wrong one. */
  const rec: Record<string, string> = {};

  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, who: string) => t.call(method, url, tok[who]);
  const outOfScope = (r: { status: number; body: any }) => {
    expect({ status: r.status, code: r.body?.error?.code }).toEqual({ status: 403, code: 'OUT_OF_SCOPE' });
  };

  beforeAll(async () => {
    t = await startTestApi();
    const users: Record<string, string> = {
      ADAMA: SEED_USERS.ADAMA_WOREDA, LUME: SEED_USERS.LUME_WOREDA, WONJI: SEED_USERS.WONJI_KEBELE, KOKA: SEED_USERS.KOKA_KEBELE,
      DA_WONJI: SEED_USERS.DA_WONJI, DA_KOKA: SEED_USERS.DA_KOKA, ZONE: SEED_USERS.EAST_SHEWA_ZONE,
      OROMIA: SEED_USERS.OROMIA_REGION, AMHARA: SEED_USERS.AMHARA_REGION
    };
    for (const [k, email] of Object.entries(users)) tok[k] = await t.loginAsUser(email);
    tok.MOA = await t.loginAs('MOA');

    const doc = await t.call('post', `/farmers/${ADAMA_FARMER}/documents`, tok.DA_WONJI)
      .field('docType', 'PHOTO').field('consent', 'true')
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...crypto.randomBytes(64)]), { filename: 'farmer.jpg', contentType: 'image/jpeg' });
    expect(doc.status).toBe(201);
    rec.doc = doc.body.id;

    const req = await api('post', '/quota/adjustment-requests', 'OROMIA')
      .send({ direction: 'INCREASE', amountMT: 1000, justificationType: 'NEW_IRRIGATION_SCHEME', justification: 'Scope test: new irrigation scheme' });
    expect(req.status).toBe(201);
    rec.request = req.body.id;

    const amd = await api('post', '/quota/allocations/QA-OR-ADAMA/amendments', 'ADAMA')
      .send({ type: 'QUANTITY_REDUCTION', proposed: { npsbMT: 100 }, justification: 'Scope test: supply shortfall' });
    expect(amd.status).toBe(201);
    rec.amendment = amd.body.id;

    const letters = await api('post', '/quota/letters', 'MOA').send({ regionIds: ['REG-OROMIA', 'REG-AMHARA'], pin: PIN });
    expect(letters.status).toBe(201);
    rec.oromiaLetter = letters.body.find((l: any) => l.regionId === 'REG-OROMIA').id;

    const ds = t.app.get(DataSource);
    // an alert sourced from a kebele gets that kebele as its unit
    const koka = await t.app.get(AlertsService).raise({
      severity: 'MEDIUM_YELLOW', title: 'Kebele approvals overdue in Koka Negewo', category: 'Pending Approvals', sourceType: 'KEBELE', sourceId: 'KEB-04'
    });
    expect(koka.unitId).toBe('KEB-04');
    rec.kokaAlert = koka.id;
    rec.nationalAlert = (await ds.query(`SELECT id FROM alerts WHERE unit_id IS NULL LIMIT 1`))[0].id;
    rec.oromiaLot = (await ds.query(`SELECT lot_id FROM vessel_lots WHERE region_id = 'oromia' LIMIT 1`))[0].lot_id;

    registerTestWorkflows(t.app.get(WorkflowRegistry));
    rec.case = (await t.app.get(WorkflowService).open('TEST_PACKAGE_REVIEW', { id: 'WOR-OR-ADAMA' }, 'WOR-OR-ADAMA', 'MEHER-2026')).id;
  });

  afterAll(async () => {
    await t?.close();
  });

  const CASES: Record<string, () => Promise<void>> = {
    // ---------------------------------------------------------------- farmers
    'GET /api/farmers': async () => {
      const lume = (await api('get', '/farmers', 'LUME')).body;
      expect(lume.some((f: any) => f.id === LUME_FARMER)).toBe(true);
      expect(lume.every((f: any) => f.woredaId === 'WOR-OR-LUME')).toBe(true);
      expect((await api('get', '/farmers', 'ADAMA')).body.some((f: any) => f.id === ADAMA_FARMER)).toBe(true);
    },
    'GET /api/farmers/{id}': async () => {
      outOfScope(await api('get', `/farmers/${ADAMA_FARMER}`, 'LUME'));
      expect((await api('get', `/farmers/${ADAMA_FARMER}`, 'ADAMA')).status).toBe(200);
    },
    'GET /api/farmers/{id}/history': async () => {
      outOfScope(await api('get', `/farmers/${ADAMA_FARMER}/history`, 'LUME'));
      expect((await api('get', `/farmers/${ADAMA_FARMER}/history`, 'ADAMA')).status).toBe(200);
    },
    'POST /api/farmers': async () => {
      outOfScope(await api('post', '/farmers', 'DA_KOKA').send({
        firstName: 'Scope', lastName: 'Test', phone: '0911000999', landCertNumber: 'NRLAIS-OR-AD-SCOPE-1', farmSizeHa: 1, kebeleId: 'KEB-01',
        reqNpsb: 1, reqUrea: 1, consent: true
      }));
    },
    'POST /api/farmers/sync': async () => {
      const data = { firstName: 'Scope', lastName: 'Sync', phone: '0911000998', landCertNumber: 'NRLAIS-OR-AD-SCOPE-2', farmSizeHa: 1, kebeleId: 'KEB-01', reqNpsb: 1, reqUrea: 1 };
      const checksum = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
      const r = await api('post', '/farmers/sync', 'DA_KOKA')
        .send({ deviceId: 'DEV-SCOPE', records: [{ clientUuid: 'scope-sync-1', operation: 'CREATE', clientUpdatedAt: '2026-08-25 08:00:00', checksum, data }] });
      expect(r.status).toBe(200);
      expect(r.body.results[0]).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/outside your assigned administrative area/) });
    },
    'PATCH /api/farmers/{id}': async () => {
      outOfScope(await api('patch', `/farmers/${ADAMA_FARMER}`, 'DA_KOKA').send({ farmSizeHa: 2 }));
    },
    'DELETE /api/farmers/{id}': async () => {
      outOfScope(await api('delete', `/farmers/${ADAMA_FARMER}`, 'DA_KOKA').send({ reason: 'Scope test delete' }));
    },
    'POST /api/farmers/{id}/documents': async () => {
      outOfScope(await t.call('post', `/farmers/${ADAMA_FARMER}/documents`, tok.DA_KOKA).field('docType', 'PHOTO').field('consent', 'true')
        .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { filename: 'x.jpg', contentType: 'image/jpeg' }));
    },
    'GET /api/farmers/{id}/documents': async () => {
      outOfScope(await api('get', `/farmers/${ADAMA_FARMER}/documents`, 'LUME'));
      expect((await api('get', `/farmers/${ADAMA_FARMER}/documents`, 'ADAMA')).status).toBe(200);
    },
    'GET /api/farmers/{id}/documents/{docId}/file': async () => {
      outOfScope(await api('get', `/farmers/${ADAMA_FARMER}/documents/${rec.doc}/file`, 'DA_KOKA'));
      expect((await api('get', `/farmers/${ADAMA_FARMER}/documents/${rec.doc}/file`, 'ADAMA')).status).toBe(200);
    },
    'GET /api/integrations/nsis/{regionId}': async () => {
      outOfScope(await api('get', '/integrations/nsis/REG-OROMIA', 'AMHARA'));
      expect((await api('get', '/integrations/nsis/REG-OROMIA', 'ADAMA')).status).toBe(200);
    },

    // ---------------------------------------------------------------- kebele review
    'GET /api/kebele/queue': async () => {
      const koka = (await api('get', '/kebele/queue', 'KOKA')).body;
      expect(koka.farmers.length).toBeGreaterThan(0);
      expect(koka.farmers.every((f: any) => f.kebeleId === 'KEB-04')).toBe(true);
    },
    'POST /api/kebele/farmers/{id}/approve': async () => {
      outOfScope(await api('post', `/kebele/farmers/${ADAMA_FARMER}/approve`, 'KOKA').send({ pin: PIN }));
    },
    'POST /api/kebele/farmers/{id}/reject': async () => {
      outOfScope(await api('post', `/kebele/farmers/${ADAMA_FARMER}/reject`, 'KOKA').send({ pin: PIN, reason: 'Scope test' }));
    },
    'POST /api/kebele/farmers/{id}/request-revision': async () => {
      outOfScope(await api('post', `/kebele/farmers/${ADAMA_FARMER}/request-revision`, 'KOKA').send({ pin: PIN, comments: 'Scope test' }));
    },
    'POST /api/kebele/farmers/{id}/partial': async () => {
      outOfScope(await api('post', `/kebele/farmers/${ADAMA_FARMER}/partial`, 'KOKA')
        .send({ pin: PIN, approve: [{ type: 'NPSB' }], revise: [{ type: 'UREA', comment: 'Scope test' }] }));
    },
    'POST /api/kebele/bulk': async () => {
      const before = (await api('get', `/farmers/${ADAMA_FARMER}`, 'ADAMA')).body.approvalLevel;
      const r = await api('post', '/kebele/bulk', 'KOKA').send({ pin: PIN, action: 'REJECT', reason: 'Scope test', farmerIds: [ADAMA_FARMER] });
      expect(r.status).toBe(400);
      expect((await api('get', `/farmers/${ADAMA_FARMER}`, 'ADAMA')).body.approvalLevel).toBe(before);
    },

    // ---------------------------------------------------------------- woreda & zone review
    'GET /api/reviews/adjustments': async () => {
      const adama = (await api('get', '/reviews/adjustments', 'ADAMA')).body;
      expect(adama.length).toBeGreaterThan(0);
      const lume = (await api('get', '/reviews/adjustments', 'LUME')).body;
      expect(lume.filter((a: any) => adama.some((b: any) => b.id === a.id))).toEqual([]);
      outOfScope(await api('get', '/reviews/adjustments?unitId=KEB-01', 'LUME'));
    },
    'POST /api/reviews/adjustments': async () => {
      outOfScope(await api('post', '/reviews/adjustments', 'LUME').send({ unitId: 'KEB-01', changePct: -1, justification: 'Scope test adjustment' }));
    },
    'GET /api/reviews/comments': async () => {
      outOfScope(await api('get', '/reviews/comments?scopeType=WOREDA&scopeId=WOR-OR-ADAMA', 'LUME'));
      expect((await api('get', '/reviews/comments?scopeType=WOREDA&scopeId=WOR-OR-ADAMA', 'ADAMA')).status).toBe(200);
      // the zone thread above the woreda is shared with its woredas
      expect((await api('get', '/reviews/comments?scopeType=ZONE&scopeId=ZONE-OR-ESHEWA', 'ADAMA')).status).toBe(200);
      outOfScope(await api('get', '/reviews/comments?scopeType=REGION&scopeId=REG-OROMIA', 'AMHARA'));
    },
    'POST /api/reviews/comments': async () => {
      outOfScope(await api('post', '/reviews/comments', 'LUME').send({ scopeType: 'WOREDA', scopeId: 'WOR-OR-ADAMA', text: 'Scope test comment' }));
    },
    'POST /api/reviews/scenario': async () => {
      outOfScope(await api('post', '/reviews/scenario', 'LUME').send({ level: 'WOREDA', unitId: 'WOR-OR-ADAMA', adjustments: [] }));
      outOfScope(await api('post', '/reviews/scenario', 'AMHARA').send({ level: 'REGION', unitId: 'REG-OROMIA', adjustments: [] }));
    },
    'GET /api/reviews/{level}/{unitId}': async () => {
      outOfScope(await api('get', '/reviews/woreda/WOR-OR-ADAMA', 'LUME'));
      expect((await api('get', '/reviews/woreda/WOR-OR-ADAMA', 'ADAMA')).status).toBe(200);
    },
    'POST /api/reviews/{level}/{unitId}/decision': async () => {
      outOfScope(await api('post', '/reviews/woreda/WOR-OR-ADAMA/decision', 'LUME').send({ action: 'HOLD', comments: 'Scope test', pin: PIN }));
    },

    // ---------------------------------------------------------------- aggregation
    'GET /api/aggregation/drilldown': async () => {
      outOfScope(await api('get', '/aggregation/drilldown?level=WOREDA&id=WOR-OR-ADAMA', 'LUME'));
      outOfScope(await api('get', '/aggregation/drilldown?level=KEBELE&id=KEB-01', 'LUME'));
      outOfScope(await api('get', '/aggregation/drilldown?level=REGION&id=REG-OROMIA', 'AMHARA'));
      // roll-up view of the areas above the user stays available
      expect((await api('get', '/aggregation/drilldown?level=ZONE&id=ZONE-OR-ESHEWA', 'ADAMA')).status).toBe(200);
      // national level: field officers see only their own region (IMPLEMENTATION_ROADMAP §5 decision 4)
      const amhara = (await api('get', '/aggregation/drilldown?level=NATIONAL', 'AMHARA')).body;
      expect(amhara.children.map((c: any) => c.id)).toEqual(['REG-AMHARA']);
      expect((await api('get', '/aggregation/drilldown?level=NATIONAL', 'MOA')).body.children).toHaveLength(7);
    },
    'GET /api/aggregation/national': async () => {
      const amhara = (await api('get', '/aggregation/national', 'AMHARA')).body;
      expect(amhara.regions.map((r: any) => r.id)).toEqual(['REG-AMHARA']);
      expect(amhara.regionsWithPartialData.every((r: any) => r.id === 'REG-AMHARA')).toBe(true);
      expect((await api('get', '/aggregation/national', 'MOA')).body.regions).toHaveLength(7);
    },

    // ---------------------------------------------------------------- regions
    'GET /api/regions': async () => {
      expect((await api('get', '/regions', 'AMHARA')).body.map((r: any) => r.id)).toEqual(['REG-AMHARA']);
      expect((await api('get', '/regions', 'ADAMA')).body.map((r: any) => r.id)).toEqual(['REG-OROMIA']);
    },
    'GET /api/regions/{id}': async () => {
      outOfScope(await api('get', '/regions/REG-OROMIA', 'AMHARA'));
      expect((await api('get', '/regions/REG-OROMIA', 'ADAMA')).status).toBe(200);
    },
    'GET /api/regions/{id}/soil': async () => {
      outOfScope(await api('get', '/regions/REG-OROMIA/soil', 'AMHARA'));
      expect((await api('get', '/regions/REG-OROMIA/soil', 'ZONE')).status).toBe(200);
    },
    'GET /api/regions/{id}/analysis': async () => {
      outOfScope(await api('get', '/regions/REG-OROMIA/analysis', 'AMHARA'));
      expect((await api('get', '/regions/REG-OROMIA/analysis', 'ZONE')).status).toBe(200);
    },
    'GET /api/regions/{id}/pre-submission-check': async () => {
      outOfScope(await api('get', '/regions/REG-OROMIA/pre-submission-check', 'AMHARA'));
      expect((await api('get', '/regions/REG-OROMIA/pre-submission-check', 'OROMIA')).status).toBe(200);
    },
    'POST /api/regions/{id}/submit': async () => {
      outOfScope(await api('post', '/regions/REG-OROMIA/submit', 'AMHARA').send({ pin: PIN, finalComments: 'Scope test' }));
    },
    'GET /api/regions/{id}/submissions': async () => {
      outOfScope(await api('get', '/regions/REG-OROMIA/submissions', 'AMHARA'));
      expect((await api('get', '/regions/REG-OROMIA/submissions', 'OROMIA')).status).toBe(200);
    },
    'GET /api/regions/{id}/submissions/compare': async () => {
      outOfScope(await api('get', '/regions/REG-OROMIA/submissions/compare?from=1&to=2', 'AMHARA'));
    },

    // ---------------------------------------------------------------- quota
    'GET /api/quota/regions': async () => {
      expect((await api('get', '/quota/regions', 'AMHARA')).body.map((r: any) => r.id)).toEqual(['REG-AMHARA']);
    },
    'GET /api/quota/adjustment-requests': async () => {
      expect((await api('get', '/quota/adjustment-requests', 'OROMIA')).body.some((r: any) => r.id === rec.request)).toBe(true);
      expect((await api('get', '/quota/adjustment-requests', 'AMHARA')).body.some((r: any) => r.id === rec.request)).toBe(false);
    },
    'GET /api/quota/adjustment-requests/stats': async () => {
      const amhara = (await api('get', '/quota/adjustment-requests/stats', 'AMHARA')).body;
      expect(amhara.byRegion.every((r: any) => r.regionId === 'REG-AMHARA')).toBe(true);
      expect((await api('get', '/quota/adjustment-requests/stats', 'MOA')).body.byRegion.some((r: any) => r.regionId === 'REG-OROMIA')).toBe(true);
    },
    'POST /api/quota/adjustment-requests': async () => {
      // always filed for the caller's own region
      const r = await api('post', '/quota/adjustment-requests', 'AMHARA')
        .send({ direction: 'DECREASE', amountMT: 10, justificationType: 'NEW_IRRIGATION_SCHEME', justification: 'Scope test: own region only' });
      expect(r.status).toBe(201);
      expect(r.body.regionId).toBe('REG-AMHARA');
    },
    'POST /api/quota/adjustment-requests/{id}/appeal': async () => {
      outOfScope(await api('post', `/quota/adjustment-requests/${rec.request}/appeal`, 'AMHARA').send({ reason: 'Scope test appeal reason' }));
    },
    'GET /api/quota/allocations': async () => {
      const ids = (await api('get', '/quota/allocations', 'LUME')).body.map((a: any) => a.id);
      expect(ids).toEqual(expect.arrayContaining(['QA-OR-REGION', 'QA-OR-ESHEWA', 'QA-OR-LUME']));
      expect(ids).not.toContain('QA-OR-ADAMA');
      expect(ids).not.toContain('QA-OR-PC882');
      expect(ids).not.toContain('QA-AM-REGION');
    },
    'GET /api/quota/allocations/downward': async () => {
      const ids = (await api('get', '/quota/allocations/downward?regionId=REG-OROMIA', 'LUME')).body.map((a: any) => a.id);
      expect(ids).toContain('QA-OR-LUME');
      expect(ids).not.toContain('QA-OR-ADAMA');
      expect(ids).not.toContain('QA-OR-PC882');
    },
    'GET /api/quota/my-allocation': async () => {
      const units = (await api('get', '/quota/my-allocation', 'LUME')).body.map((a: any) => a.unitId);
      expect(units).toContain('WOR-OR-LUME');
      expect(units).not.toContain('WOR-OR-ADAMA');
    },
    'GET /api/quota/allocations/{id}': async () => {
      outOfScope(await api('get', '/quota/allocations/QA-OR-ADAMA', 'LUME'));
      outOfScope(await api('get', '/quota/allocations/QA-OR-PC882', 'LUME'));
      expect((await api('get', '/quota/allocations/QA-OR-ESHEWA', 'LUME')).status).toBe(200);
      expect((await api('get', '/quota/allocations/QA-OR-PC882', 'ADAMA')).status).toBe(200);
    },
    'GET /api/quota/allocations/{id}/recommendation': async () => {
      outOfScope(await api('get', '/quota/allocations/QA-OR-ADAMA/recommendation', 'LUME'));
      expect((await api('get', '/quota/allocations/QA-OR-ADAMA/recommendation', 'ADAMA')).status).toBe(200);
    },
    'POST /api/quota/allocations/{id}/children': async () => {
      outOfScope(await api('post', '/quota/allocations/QA-OR-ADAMA/children', 'LUME').send({ unitId: 'KEB-02', recipientName: 'Scope Test', npsbMT: 1, ureaMT: 1, justification: 'Scope test' }));
    },
    'POST /api/quota/allocations/{id}/approve': async () => {
      outOfScope(await api('post', '/quota/allocations/QA-OR-PC882/approve', 'KOKA').send({ pin: PIN }));
    },
    'POST /api/quota/allocations/{id}/acknowledge': async () => {
      outOfScope(await api('post', '/quota/allocations/QA-OR-ADAMA/acknowledge', 'LUME'));
    },
    'PATCH /api/quota/allocations/{id}/delivery': async () => {
      outOfScope(await api('patch', '/quota/allocations/QA-OR-ADAMA/delivery', 'LUME').send({ receivedMT: 1 }));
    },
    'GET /api/quota/amendments': async () => {
      expect((await api('get', '/quota/amendments', 'ADAMA')).body.some((m: any) => m.id === rec.amendment)).toBe(true);
      expect((await api('get', '/quota/amendments', 'LUME')).body.some((m: any) => m.id === rec.amendment)).toBe(false);
    },
    'POST /api/quota/allocations/{id}/amendments': async () => {
      outOfScope(await api('post', '/quota/allocations/QA-OR-ADAMA/amendments', 'LUME').send({ type: 'QUANTITY_REDUCTION', proposed: { npsbMT: 1 }, justification: 'Scope test amendment' }));
    },
    'POST /api/quota/amendments/{id}/decide': async () => {
      // Amhara's bureau head outranks the zone approver but the Adama line is not in Amhara
      outOfScope(await api('post', `/quota/amendments/${rec.amendment}/decide`, 'AMHARA').send({ approve: true, pin: PIN }));
    },
    'GET /api/quota/letters': async () => {
      expect((await api('get', '/quota/letters', 'AMHARA')).body.every((l: any) => l.regionId === 'REG-AMHARA')).toBe(true);
    },
    'GET /api/quota/letters/{id}': async () => {
      outOfScope(await api('get', `/quota/letters/${rec.oromiaLetter}`, 'AMHARA'));
      expect((await api('get', `/quota/letters/${rec.oromiaLetter}`, 'ADAMA')).status).toBe(200);
    },
    'GET /api/quota/letters/{id}/print': async () => {
      outOfScope(await api('get', `/quota/letters/${rec.oromiaLetter}/print`, 'AMHARA'));
    },
    'POST /api/quota/letters/{id}/acknowledge': async () => {
      outOfScope(await api('post', `/quota/letters/${rec.oromiaLetter}/acknowledge`, 'AMHARA'));
    },

    // ---------------------------------------------------------------- dashboard
    'GET /api/bootstrap': async () => {
      const lume = (await api('get', '/bootstrap', 'LUME')).body;
      expect(lume.farmerRegistry.every((f: any) => f.woredaId === 'WOR-OR-LUME')).toBe(true);
      expect(lume.regions.map((r: any) => r.id)).toEqual(['REG-OROMIA']);
      expect((await api('get', '/bootstrap', 'AMHARA')).body.regions.map((r: any) => r.id)).toEqual(['REG-AMHARA']);
    },
    'GET /api/dashboard': async () => {
      const lumeFarmers = (await api('get', '/farmers', 'LUME')).body.length;
      expect((await api('get', '/dashboard', 'LUME')).body.widgets.farmers.total).toBe(lumeFarmers);
    },

    // ---------------------------------------------------------------- admin units
    'GET /api/v1/admin-units/tree': async () => {
      expect((await api('get', '/v1/admin-units/tree', 'LUME')).body.map((u: any) => u.id)).toEqual(['WOR-OR-LUME']);
    },
    'GET /api/v1/admin-units/{id}': async () => {
      outOfScope(await api('get', '/v1/admin-units/KEB-01', 'LUME'));
      expect((await api('get', '/v1/admin-units/KEB-01', 'ADAMA')).status).toBe(200);
    },
    'GET /api/v1/admin-units/{id}/children': async () => {
      outOfScope(await api('get', '/v1/admin-units/WOR-OR-ADAMA/children', 'LUME'));
    },

    // ---------------------------------------------------------------- alerts (field roles see their area; unit-less = national)
    ...Object.fromEntries(['/api', '/api/v1'].flatMap(base => {
      const p = base.replace('/api', '');
      return [
        [`GET ${base}/alerts`, async () => {
          const ids = (who: string) => api('get', `${p}/alerts`, who).then(r => r.body.map((a: any) => a.id));
          expect(await ids('LUME')).toContain(rec.kokaAlert);
          expect(await ids('ZONE')).toContain(rec.kokaAlert);
          const adama = await ids('ADAMA');
          expect(adama).not.toContain(rec.kokaAlert);
          expect(adama).not.toContain(rec.nationalAlert);
          expect(await ids('MOA')).toEqual(expect.arrayContaining([rec.kokaAlert, rec.nationalAlert]));
        }],
        [`GET ${base}/alerts/summary`, async () => {
          const open = (await api('get', `${p}/alerts`, 'ADAMA')).body.filter((a: any) => !a.resolved).length;
          expect((await api('get', `${p}/alerts/summary`, 'ADAMA')).body.open).toBe(open);
          expect((await api('get', `${p}/alerts/summary`, 'MOA')).body.open).toBeGreaterThan(open);
        }],
        [`GET ${base}/alerts/{id}`, async () => {
          outOfScope(await api('get', `${p}/alerts/${rec.kokaAlert}`, 'ADAMA'));
          outOfScope(await api('get', `${p}/alerts/${rec.nationalAlert}`, 'LUME'));
          expect((await api('get', `${p}/alerts/${rec.kokaAlert}`, 'LUME')).status).toBe(200);
        }],
        [`POST ${base}/alerts/{id}/acknowledge`, async () => {
          outOfScope(await api('post', `${p}/alerts/${rec.kokaAlert}/acknowledge`, 'ADAMA'));
        }],
        [`POST ${base}/alerts`, async () => {
          const body = { severity: 'LOW_BLUE', title: 'Scope test alert', category: 'Demand Anomaly' };
          outOfScope(await api('post', `${p}/alerts`, 'AMHARA').send({ ...body, unitId: 'REG-OROMIA' }));
          const own = await api('post', `${p}/alerts`, 'AMHARA').send(body);
          expect(own.status).toBe(201);
          expect(own.body.unitId).toBe('REG-AMHARA');
        }]
      ];
    })),

    // ---------------------------------------------------------------- national (regional officers: own region's rows)
    'GET /api/national/summary': async () => {
      const s = (await api('get', '/national/summary', 'AMHARA')).body;
      expect(s.national.regions.map((r: any) => r.id)).toEqual(['REG-AMHARA']);
      expect(s.national.grossNationalDemandMT).toBeGreaterThan(0); // national total stays
      expect(s.demandDocument.content.regionalBreakdown.map((r: any) => r.id)).toEqual(['REG-AMHARA']);
      expect((await api('get', '/national/summary', 'MOA')).body.national.regions).toHaveLength(7);
    },
    'GET /api/national/gross-demand': async () => {
      expect((await api('get', '/national/gross-demand', 'AMHARA')).body.regions.map((r: any) => r.id)).toEqual(['REG-AMHARA']);
    },
    'GET /api/national/export': async () => {
      expect((await api('get', '/national/export', 'AMHARA')).body.regions.map((r: any) => r.id)).toEqual(['REG-AMHARA']);
      expect((await api('get', '/national/export?format=csv', 'AMHARA')).text).not.toMatch(/Oromia/);
    },
    'GET /api/national/documents': async () => {
      const docs = (await api('get', '/national/documents', 'AMHARA')).body;
      expect(docs.every((d: any) => (d.content.regionalBreakdown ?? []).every((r: any) => r.id === 'REG-AMHARA'))).toBe(true);
    },
    'GET /api/national/documents/latest': async () => {
      expect((await api('get', '/national/documents/latest', 'AMHARA')).body.content.regionalBreakdown.map((r: any) => r.id)).toEqual(['REG-AMHARA']);
    },
    'GET /api/national/documents/{id}': async () => {
      const id = (await api('get', '/national/documents/latest', 'MOA')).body.id;
      expect((await api('get', `/national/documents/${id}`, 'AMHARA')).body.content.regionalBreakdown.map((r: any) => r.id)).toEqual(['REG-AMHARA']);
    },

    // ---------------------------------------------------------------- integrations
    'GET /api/integrations/logistics': async () => {
      const wh = (await api('get', '/integrations/logistics', 'AMHARA')).body.warehouseUtilization;
      expect(wh.every((w: any) => w.regionId === null || w.regionId === 'REG-AMHARA')).toBe(true);
      expect((await api('get', '/integrations/logistics', 'MOA')).body.warehouseUtilization.some((w: any) => w.regionId === 'REG-OROMIA')).toBe(true);
    },
    'GET /api/integrations/financials': async () => {
      expect((await api('get', '/integrations/financials', 'AMHARA')).body.creditArrearsByRegion.map((r: any) => r.regionId)).toEqual(['REG-AMHARA']);
      expect((await api('get', '/integrations/financials', 'MOA')).body.creditArrearsByRegion).toHaveLength(7);
    },

    // ---------------------------------------------------------------- daily reports (report regions mapped to units)
    'GET /api/reports/daily-summary/all': async () => {
      const recs = Object.values((await api('get', '/reports/daily-summary/all', 'AMHARA')).body.recordsByDate).flat() as any[];
      expect(recs.length).toBeGreaterThan(0);
      expect(recs.every(r => r.regionId === 'amhara')).toBe(true);
    },
    'GET /api/reports/daily-summary': async () => {
      expect((await api('get', '/reports/daily-summary', 'AMHARA')).body.records.every((r: any) => r.regionId === 'amhara')).toBe(true);
      outOfScope(await api('get', '/reports/daily-summary?regionId=oromia', 'AMHARA'));
    },
    'GET /api/reports/daily-summary/export': async () => {
      const csv = (await api('get', '/reports/daily-summary/export', 'AMHARA')).text;
      expect(csv).toMatch(/Amhara/);
      expect(csv).not.toMatch(/Oromia/);
    },
    'GET /api/reports/regional/regions': async () => {
      expect((await api('get', '/reports/regional/regions', 'AMHARA')).body.map((r: any) => r.id)).toEqual(['amhara']);
    },
    'GET /api/reports/regional/lots': async () => {
      expect(Object.keys((await api('get', '/reports/regional/lots', 'AMHARA')).body)).toEqual(['amhara']);
      outOfScope(await api('get', '/reports/regional/lots?regionId=oromia', 'AMHARA'));
    },
    'GET /api/reports/regional/lots/{lotId}/dispatches': async () => {
      outOfScope(await api('get', `/reports/regional/lots/${rec.oromiaLot}/dispatches`, 'AMHARA'));
      expect((await api('get', `/reports/regional/lots/${rec.oromiaLot}/dispatches`, 'OROMIA')).status).toBe(200);
    },
    'GET /api/reports/regional/export': async () => {
      outOfScope(await api('get', '/reports/regional/export?regionId=oromia', 'AMHARA'));
    },

    // ---------------------------------------------------------------- workflow
    'GET /api/v1/workflow/cases': async () => {
      expect((await api('get', '/v1/workflow/cases?entityType=WOREDA&entityId=WOR-OR-ADAMA', 'ADAMA')).body).toHaveLength(1);
      expect((await api('get', '/v1/workflow/cases?entityType=WOREDA&entityId=WOR-OR-ADAMA', 'LUME')).body).toEqual([]);
    },
    'GET /api/v1/workflow/cases/{id}': async () => {
      outOfScope(await api('get', `/v1/workflow/cases/${rec.case}`, 'LUME'));
      expect((await api('get', `/v1/workflow/cases/${rec.case}`, 'ZONE')).status).toBe(200);
    },
    'GET /api/v1/workflow/cases/{id}/available': async () => {
      outOfScope(await api('get', `/v1/workflow/cases/${rec.case}/available`, 'LUME'));
    },
    'POST /api/v1/workflow/cases/{id}/actions': async () => {
      outOfScope(await api('post', `/v1/workflow/cases/${rec.case}/actions`, 'LUME').send({ action: 'FORWARD', pin: PIN }));
    },
    'GET /api/v1/workflow/history': async () => {
      outOfScope(await api('get', '/v1/workflow/history?entityType=WOREDA&entityId=WOR-OR-ADAMA', 'LUME'));
      expect((await api('get', '/v1/workflow/history?entityType=WOREDA&entityId=WOR-OR-ADAMA', 'ADAMA')).status).toBe(200);
    }
  };

  for (const [route, run] of Object.entries(CASES)) it(route, run);

  it('every route of the scoped modules has a scope case or a written exemption', () => {
    const doc = buildOpenApiDocument(t.app);
    const routes = Object.entries(doc.paths)
      .flatMap(([path, ops]) => Object.keys(ops as object).map(method => `${method.toUpperCase()} ${path}`))
      .filter(r => SCOPED.test(r.split(' ')[1]));
    expect(routes.length).toBeGreaterThan(50);
    const covered = new Set([...Object.keys(CASES), ...Object.keys(EXEMPT)]);
    expect(routes.filter(r => !covered.has(r))).toEqual([]);
    expect([...covered].filter(r => !routes.includes(r))).toEqual([]);
  });
});
