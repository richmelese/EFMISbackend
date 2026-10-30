// End-to-end workflow test: farmer registration -> kebele -> woreda -> zone -> region -> national -> quota -> EABC,
// plus integrations, alerts, reports, USSD, RBAC and the audit chain. Runs against the efmis_test database.
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { SeedService, DEMO_PASSWORD, DEMO_PIN } from '../src/database/seeds/seed.service';
import { StorageService } from '../src/modules/storage/storage.service';

const PIN = DEMO_PIN;
const ROLES = ['DA', 'KEBELE', 'WOREDA', 'ZONE', 'REGION', 'MOA', 'FTWG', 'ATI', 'EABC', 'PMO', 'ECAE', 'AUDITOR'];

describe('EFMIS API (e2e)', () => {
  let app: NestExpressApplication;
  let http: any;
  const t: Record<string, string> = {};
  let newFarmerId: string;

  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, token?: string) => {
    const r = request(http)[method](`/api${url}`);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    const seeder = app.get(SeedService);
    await app.get(StorageService).emptyTestBuckets();
    await seeder.reset();
    await seeder.seed();
    for (const role of ROLES) {
      const r = await api('post', '/auth/demo-login').send({ role });
      expect(r.status).toBe(200);
      t[role] = r.body.token;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('health and metadata', async () => {
    expect((await api('get', '/health')).body.status).toBe('UP');
    const meta = await api('get', '/meta');
    expect(meta.body.systemMetadata.nationalTargetMT).toBe(2350000);
    expect(meta.body.roles.find((r: any) => r.id === 'DA')).toBeTruthy();
  });

  it('credential and OTP login, logout revokes the token', async () => {
    expect((await api('post', '/auth/login').send({ email: 'admin.moa@efmis.gov.et', password: 'wrong' })).status).toBe(401);
    const ok = await api('post', '/auth/login').send({ email: 'admin.moa@efmis.gov.et', password: DEMO_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe('MOA');
    const otp = await api('post', '/auth/otp/request').send({ channel: 'FAYDA', identifier: 'FAYDA-ETH-8829-4921' });
    expect(otp.body.devOtp).toMatch(/^\d{6}$/);
    const v = await api('post', '/auth/otp/verify').send({ channel: 'FAYDA', identifier: 'FAYDA-ETH-8829-4921', otp: otp.body.devOtp });
    expect(v.status).toBe(200);
    expect((await api('post', '/auth/logout', v.body.token)).status).toBe(200);
    expect((await api('get', '/auth/me', v.body.token)).status).toBe(401);
  });

  it('bootstrap returns the frontend EFMIS_DATA shape', async () => {
    const r = await api('get', '/bootstrap', t.MOA);
    expect(r.status).toBe(200);
    for (const k of ['systemMetadata', 'roles', 'fertilizerTypes', 'regions', 'farmerRegistry', 'carryOverStocks', 'procurement', 'logistics', 'qualityControl', 'financials', 'criticalAlerts', 'auditTrail']) expect(r.body).toHaveProperty(k);
    expect(r.body.regions[0].zones[0].woredas[0].kebeles[0].name).toBe('Wonji Gefersa');
    expect(r.body.farmerRegistry).toHaveLength(4);
    expect(r.body.farmerRegistry[0].demands[0]).toHaveProperty('requestedQtl');
    expect(r.body.carryOverStocks.totalUsableMT).toBe(285400);
  });

  it('DA registers a farmer: validation, anomaly flagging and duplicate checks', async () => {
    const body = {
      firstName: 'Abebe', middleName: 'Kebede', lastName: 'Tadesse', faydaId: '123456789', phone: '0911223344', gender: 'Male', ageGroup: '36-45',
      householdSize: 6, educationLevel: 'Primary', primaryOccupation: 'Farming', cooperativeMember: true, cooperative: 'Wonji Farmers PC',
      landCertNumber: 'NRLAIS-OR-AD-99001-2025', farmSizeHa: 3.75, landTenure: 'Owner', irrigationAccess: true, irrigationType: 'River / Canal',
      crops: ['Teff', 'Wheat'], targetCrop: 'Teff (White Grade 1)', reqNpsb: 7.5, reqUrea: 9.0, consent: true, gps: { lat: 8.5, lng: 39.27 }
    };
    const r = await api('post', '/farmers', t.DA).send(body);
    expect(r.status).toBe(201);
    newFarmerId = r.body.id;
    expect(newFarmerId).toMatch(/^FARM-\d{4}-\d{5}$/);
    expect(r.body.faydaStatus).toBe('VERIFIED_ACTIVE');
    expect(r.body.demands.find((d: any) => d.type === 'NPSB').recommendedQtl).toBe(7.5);
    expect(r.body.demands.every((d: any) => d.status === 'PENDING_REVIEW')).toBe(true);

    const { faydaId, ...noFayda } = body;
    expect((await api('post', '/farmers', t.DA).send(noFayda)).status).toBe(409);
    expect((await api('post', '/farmers', t.DA).send({ ...noFayda, landCertNumber: 'NRLAIS-OR-AD-99002-2025', phone: '0811223344' })).status).toBe(422);
    expect((await api('post', '/farmers', t.DA).send({ ...noFayda, landCertNumber: 'NRLAIS-OR-AD-99003-2025', kebeleId: 'KEB-04' })).status).toBe(403);
    const anomaly = await api('post', '/farmers', t.DA).send({ ...noFayda, firstName: 'Kebede', landCertNumber: 'NRLAIS-OR-AD-99004-2025', reqNpsb: 20 });
    expect(anomaly.status).toBe(201);
    expect(anomaly.body.demands.find((d: any) => d.type === 'NPSB').status).toBe('FLAGGED_ANOMALY');
    expect(anomaly.body.qualityFlags.some((f: any) => f.code === 'DEMAND_ANOMALY')).toBe(true);
  });

  it('Fayda verification messages follow the spec', async () => {
    const invalid = await api('post', '/integrations/fayda/verify', t.DA).send({ faydaId: 'FAN-12-34' });
    expect(invalid.status).toBe(422);
    expect(JSON.stringify(invalid.body)).toContain('The Fayda ID provided is not valid. Please check the number and try again.');
    const dup = await api('post', '/integrations/fayda/verify', t.DA).send({ faydaId: 'FAN-9482-1049-3821' });
    expect(dup.body.duplicate.message).toMatch(/already registered/);
  });

  it('offline sync: create, idempotent replay and checksum rejection', async () => {
    const data = { firstName: 'Offline', lastName: 'Farmer', phone: '0722334455', landCertNumber: 'NRLAIS-OR-AD-77001-2025', farmSizeHa: 1.5, reqNpsb: 3, reqUrea: 3.6 };
    const checksum = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const records = [
      { clientUuid: 'uuid-1', operation: 'CREATE', clientUpdatedAt: '2026-08-25 08:00:00', checksum, data },
      { clientUuid: 'uuid-2', operation: 'CREATE', clientUpdatedAt: '2026-08-25 08:00:00', checksum: 'bad', data }
    ];
    const r = await api('post', '/farmers/sync', t.DA).send({ deviceId: 'DEV-DA-01', records });
    expect(r.body.results.find((x: any) => x.clientUuid === 'uuid-1').status).toBe('CREATED');
    expect(r.body.results.find((x: any) => x.clientUuid === 'uuid-2').status).toBe('REJECTED');
    const again = await api('post', '/farmers/sync', t.DA).send({ deviceId: 'DEV-DA-01', records: [records[0]] });
    expect(again.body.results[0].status).toBe('ALREADY_SYNCED');
  });

  it('kebele review: e-signature required, approve, bulk skips warnings, scope enforced', async () => {
    const queue = await api('get', '/kebele/queue', t.KEBELE);
    expect(queue.body.stats.pendingCount).toBeGreaterThanOrEqual(3);
    expect((await api('post', `/kebele/farmers/${newFarmerId}/approve`, t.KEBELE).send({})).status).toBe(400);
    expect((await api('post', `/kebele/farmers/${newFarmerId}/approve`, t.KEBELE).send({ pin: '0000' })).status).toBe(401);
    const ok = await api('post', `/kebele/farmers/${newFarmerId}/approve`, t.KEBELE).send({ pin: PIN });
    expect(ok.status).toBe(200);
    expect(ok.body.farmer.approvalLevel).toBe('Kebele Approved • Forwarded to Woreda');
    expect(ok.body.farmer.demands.every((d: any) => d.status === 'APPROVED')).toBe(true);
    const bulk = await api('post', '/kebele/bulk', t.KEBELE).send({ pin: PIN, action: 'APPROVE', reason: 'Seasonal batch approval' });
    expect(bulk.status).toBe(200);
    expect(bulk.body.skipped.some((s: any) => /DEMAND_ANOMALY/.test(s.reason))).toBe(true);
    expect((await api('post', '/kebele/farmers/FARM-2026-04823/approve', t.KEBELE).send({ pin: PIN })).status).toBe(403);
  });

  it('woreda & zone review: justification, comments with mentions, approval cascade, scenario', async () => {
    const view = await api('get', '/reviews/woreda/WOR-OR-ADAMA', t.WOREDA);
    expect(view.status).toBe(200);
    expect(view.body.adjustments.length).toBeGreaterThanOrEqual(3);
    expect((await api('post', '/reviews/adjustments', t.WOREDA).send({ unitId: 'KEB-02', changePct: -5 })).status).toBe(422);
    const adj = await api('post', '/reviews/adjustments', t.WOREDA).send({ unitId: 'KEB-02', changePct: -10, justification: 'Flooding in lowland area, reduce demand' });
    expect(adj.status).toBe(201);
    expect(adj.body.adjustedMT).toBe(1305);
    expect((await api('post', '/reviews/woreda/WOR-OR-ADAMA/decision', t.WOREDA).send({ action: 'APPROVE', pin: PIN })).status).toBe(200);
    expect((await api('get', `/farmers/${newFarmerId}`, t.WOREDA)).body.approvalLevel).toBe('Woreda Approved');
    const comment = await api('post', '/reviews/comments', t.ZONE).send({ scopeType: 'ZONE', scopeId: 'ZONE-OR-ESHEWA', text: 'Please check @Adama Woreda figures' });
    expect(comment.status).toBe(201);
    expect(comment.body.mentions).toEqual(['Adama Woreda Agronomist']);
    expect((await api('post', '/reviews/zone/ZONE-OR-ESHEWA/decision', t.ZONE).send({ action: 'APPROVE', pin: PIN })).status).toBe(200);
    const scenario = await api('post', '/reviews/scenario', t.ZONE).send({ level: 'ZONE', unitId: 'ZONE-OR-ESHEWA', adjustments: [{ childId: 'WOR-OR-ADAMA', changePct: -10 }] });
    expect(scenario.body.deltaMT).toBeLessThan(0);
  });

  it('region soil analysis and signed submission to MoA', async () => {
    const soil = await api('get', '/regions/REG-OROMIA/soil?layer=P_DEFICIENCY', t.REGION);
    expect(soil.body.layerValue).toBe(81);
    expect(soil.body.hafas.prescription).toMatch(/70% Boron-fortified NPSB/);
    expect((await api('get', '/regions/REG-AMHARA/soil', t.REGION)).status).toBe(403);
    const sub = await api('post', '/regions/REG-OROMIA/submit', t.REGION).send({ pin: PIN, finalComments: 'Final Meher demand' });
    expect(sub.status).toBe(201);
    expect(sub.body.receiptNo).toMatch(/^RCPT-MOA-OR-/);
    expect((await api('get', `/farmers/${newFarmerId}`, t.REGION)).body.approvalLevel).toBe('Region Approved');
  });

  it('drill-down National -> Region -> Zone -> Woreda -> Kebele -> Farmer', async () => {
    const n = await api('get', '/aggregation/drilldown?level=NATIONAL', t.MOA);
    expect(n.body.children).toHaveLength(7);
    const k = await api('get', '/aggregation/drilldown?level=KEBELE&id=KEB-01', t.MOA);
    expect(k.body.children.some((c: any) => c.id === newFarmerId)).toBe(true);
    expect(k.body.breadcrumb).toHaveLength(5);
    expect((await api('get', '/aggregation/drilldown?level=KEBELE&id=KEB-10', t.DA)).status).toBe(403);
  });

  it('national validation: net import, signed document, FTWG vote', async () => {
    const s = await api('get', '/national/summary', t.MOA);
    expect(s.body.netImport.grossNationalDemandMT).toBe(2350000);
    expect(s.body.netImport.usableCarryOverMT).toBe(285400);
    expect(s.body.netImport.netImportRequirementMT).toBe(2064600);
    expect(s.body.demandDocument.status).toBe('FINAL');
    expect(s.body.demandDocument.signatories.map((x: any) => x.signed)).toEqual([true, true, true]);
    expect(s.body.ftwg.inFavor).toBe(9);
    expect((await api('get', `/national/documents/${s.body.demandDocument.id}/verify`, t.MOA)).body.valid).toBe(true);
    const vote = await api('post', '/national/ftwg/sessions/FTWG-SESSION-MEHER-26/vote', t.FTWG).send({ vote: 'favor' });
    expect(vote.body.inFavor).toBe(10);
    expect((await api('post', '/national/ftwg/sessions/FTWG-SESSION-MEHER-26/vote', t.FTWG).send({ vote: 'oppose' })).status).toBe(409);
    expect((await api('post', '/national/ftwg/sessions/FTWG-SESSION-MEHER-26/vote', t.MOA).send({ vote: 'favor' })).status).toBe(403);
  });

  it('sequential document signing is enforced', async () => {
    const doc = await api('post', '/national/documents', t.MOA);
    expect(doc.status).toBe(201);
    expect((await api('post', `/national/documents/${doc.body.id}/sign`, t.MOA).send({ pin: PIN })).status).toBe(403);
    await api('post', `/national/documents/${doc.body.id}/sign`, t.FTWG).send({ pin: PIN }).expect(200);
    await api('post', `/national/documents/${doc.body.id}/sign`, t.ATI).send({ pin: PIN }).expect(200);
    const final = await api('post', `/national/documents/${doc.body.id}/sign`, t.MOA).send({ pin: PIN });
    expect(final.body.status).toBe('FINAL');
  });

  it('quota engine: transparent factors, weight validation, publish', async () => {
    const prev = await api('get', '/quota/provisional?historical=60&soilIndex=25&arrearsPenalty=15', t.MOA);
    expect(prev.body.validation.equalsNationalTotal).toBe(true);
    expect(prev.body.regions.reduce((s: number, r: any) => s + r.provisionalQuotaMT, 0)).toBe(2350000);
    expect(prev.body.regions[0].contributionsMT.historical).toBeGreaterThan(0);
    expect((await api('get', '/quota/provisional?historical=60&soilIndex=25&arrearsPenalty=30', t.MOA)).status).toBe(422);
    const run = await api('post', '/quota/runs', t.MOA).send({ label: 'Meher baseline' });
    expect(run.status).toBe(201);
    const pub = await api('post', `/quota/runs/${run.body.id}/publish`, t.MOA).send({ pin: PIN });
    expect(pub.body.status).toBe('PUBLISHED');
    const table = await api('get', '/quota/regions', t.MOA);
    expect(table.body.reduce((s: number, r: any) => s + r.quotaAllocationMT, 0)).toBe(2350000);
  });

  it('regional adjustment request, decision and binding appeal', async () => {
    const r = await api('post', '/quota/adjustment-requests', t.REGION).send({ direction: 'INCREASE', amountMT: 12000, justificationType: 'NEW_IRRIGATION_SCHEME', justification: 'New 4,000 ha Koka irrigation scheme commissioned' });
    expect(r.status).toBe(201);
    const d = await api('post', `/quota/adjustment-requests/${r.body.id}/decide`, t.MOA).send({ decision: 'PARTIALLY_APPROVED', decisionMT: 8000, comments: 'Phase 1 only', pin: PIN });
    expect(d.body.status).toBe('PARTIALLY_APPROVED');
    const a = await api('post', `/quota/adjustment-requests/${r.body.id}/appeal`, t.REGION).send({ reason: 'Phase 2 area already planted, evidence attached' });
    expect(a.body.status).toBe('APPEALED');
    const f = await api('post', `/quota/adjustment-requests/${r.body.id}/appeal-decision`, t.MOA).send({ decision: 'REJECTED', comments: 'Binding: phase 2 next season', pin: PIN });
    expect(f.body.status).toBe('APPEAL_REJECTED');
  });

  it('downward allocation, over-allocation guard, amendment approval rules', async () => {
    const down = await api('get', '/quota/allocations/downward?regionId=REG-OROMIA', t.MOA);
    expect(down.body).toHaveLength(7);
    expect(down.body[0].name).toBe('East Shewa Zonal Bureau');
    expect((await api('post', '/quota/allocations/QA-OR-ADAMA/children', t.WOREDA).send({ unitId: 'KEB-02', recipientName: 'Dungugi Boro Kebele', npsbMT: 99999, ureaMT: 10 })).status).toBe(422);
    const ok = await api('post', '/quota/allocations/QA-OR-ADAMA/children', t.WOREDA).send({ unitId: 'KEB-02', recipientName: 'Dungugi Boro Kebele', npsbMT: 900, ureaMT: 600, justification: 'Pilot irrigation cluster', deliveryWindow: 'Sep 10 - Sep 25' });
    expect(ok.status).toBe(201);
    const amd = await api('post', `/quota/allocations/${ok.body.id}/amendments`, t.WOREDA).send({ type: 'QUANTITY_REDUCTION', proposed: { npsbMT: 800 }, justification: 'Supply shortfall from MV Gibe delay' });
    expect(amd.status).toBe(201);
    expect((await api('post', `/quota/amendments/${amd.body.id}/decide`, t.KEBELE).send({ approve: true, pin: PIN })).status).toBe(403);
    expect((await api('post', `/quota/amendments/${amd.body.id}/decide`, t.WOREDA).send({ approve: true, pin: PIN })).body.status).toBe('APPROVED');
    const after = await api('get', `/quota/allocations/${ok.body.id}`, t.WOREDA);
    expect(after.body.npsbMT).toBe(800);
    expect(after.body.version).toBe(2);
  });

  it('quota letters and procurement request to EABC', async () => {
    const letters = await api('post', '/quota/letters', t.MOA).send({ regionIds: ['REG-OROMIA'], pin: PIN });
    expect(letters.status).toBe(201);
    expect((await api('post', `/quota/letters/${letters.body[0].id}/acknowledge`, t.REGION)).body.status).toBe('ACKNOWLEDGED');
    const print = await api('get', `/quota/letters/${letters.body[0].id}/print`, t.REGION);
    expect(print.text).toMatch(/Quota Allocation for Meher 2026 Planting Season/);
    const po = await api('post', '/quota/procurement-requests', t.MOA).send({ priority: 'URGENT', pin: PIN });
    expect(po.status).toBe(201);
    expect(po.body.payload.netImportRequirement.totalMT).toBe(2064600);
    expect((await api('post', `/quota/procurement-requests/${po.body.id}/status`, t.EABC).send({ status: 'ACKNOWLEDGED' })).body.status).toBe('ACKNOWLEDGED');
  });

  it('integration feeds raise automatic alerts; alert lifecycle', async () => {
    const q = await api('post', '/integrations/quality/inspections', t.ECAE).send({ sampleId: 'ECAE-LAB-2026-0900', vessel: 'MV Test', product: 'DAP', supplier: 'Trader ABC', inspectionDate: '2026-08-26', verdict: 'REJECTED_IMPOUNDED', nitrogenContent: '14.0% - DEFICIENT' });
    expect(q.status).toBe(201);
    expect(q.body.alert.severity).toBe('CRITICAL_RED');
    const quality = await api('get', '/integrations/quality', t.MOA);
    expect(quality.body.inspections.find((i: any) => i.sampleId === 'ECAE-LAB-2026-0900').nitrogenContent).toBe('14.0% - DEFICIENT');
    const w = await api('put', '/integrations/logistics/warehouses/Hawassa%20Buffer%20Depot', t.EABC).send({ currentStockMT: 55000 });
    expect(w.body.status).toBe('CAPACITY_ALERT_80');
    expect((await api('post', `/alerts/${q.body.alert.id}/snooze`, t.MOA).send({ hours: 4, reason: 'later' })).status).toBe(409);
    expect((await api('post', `/alerts/${q.body.alert.id}/resolve`, t.PMO).send({})).status).toBe(400);
    expect((await api('post', `/alerts/${q.body.alert.id}/resolve`, t.PMO).send({ resolutionNotes: 'Supplier debarred, LC bond drawn' })).body.resolved).toBe(true);
    const fleet = (await api('get', '/integrations/logistics', t.MOA)).body.gpsFleet;
    expect(fleet.map((f: any) => f.truckId)).toEqual(expect.arrayContaining(['ESLSE-TRK-8819', 'ESLSE-TRK-9042', 'PRIVATE-TRK-109', 'PRIVATE-TRK-381']));
  });

  it('daily reports: edit record, dispatch with waybill', async () => {
    const s = await api('get', '/reports/daily-summary?date=03.04.2016', t.MOA);
    expect(s.body.records.length).toBeGreaterThan(0);
    const rec = s.body.records[0];
    const upd = await api('put', `/reports/daily-summary/03.04.2016/${rec.regionId}/${rec.fertilizerType}`, t.EABC).send({ dispatchedMT: rec.dispatchedMT + 100 });
    expect(upd.body.dispatchedMT).toBe(rec.dispatchedMT + 100);
    const lots = await api('get', '/reports/regional/lots?regionId=southEthiopia', t.MOA);
    const lot = lots.body[0];
    expect(lot.unions[0].id).toBe('u1');
    const disp = await api('post', `/reports/regional/lots/${lot.lotId}/dispatches`, t.EABC).send({ unionId: 'u1', date: '17.06.24', mtLoaded: 45, truckPlate: 'ET-3-84910', driverName: 'Tesfaye Alemu', waybillNo: 'WB-2026-9481' });
    expect(disp.status).toBe(201);
    expect(disp.body.lot.unions[0].dailyLoadedMT['17.06.24']).toBe(45);
    expect((await api('post', `/reports/regional/lots/${lot.lotId}/dispatches`, t.EABC).send({ unionId: 'u1', date: '17.06.24', mtLoaded: 5, waybillNo: 'WB-2026-9481' })).status).toBe(409);
  });

  it('USSD *804# gateway and simulator', async () => {
    const menu = await request(http).post('/api/ussd').type('form').send('sessionId=s1&phoneNumber=0911458291&text=');
    expect(menu.text).toMatch(/^CON Welcome to FDRE EFMIS/);
    const quota = await api('post', '/ussd').send({ input: '1' });
    expect(quota.body.screen).toMatch(/Wonji Primary Cooperative \(PC-882\) Quota/);
    await api('post', '/ussd').send({ input: '4', sessionId: 'delay' });
    const delay = await api('post', '/ussd').send({ input: 'Truck stuck at Awash bridge', sessionId: 'delay' });
    expect(delay.body.sessionEnded).toBe(true);
    expect(delay.body.screen).toMatch(/Ref: ALT-/);
  });

  it('copilot answers from live data', async () => {
    const r = await api('post', '/copilot/ask', t.MOA).send({ message: 'What is the net import requirement?' });
    expect(r.status).toBe(200);
    expect(r.body.reply).toContain('2,064,600');
  });

  it('RBAC and data segmentation', async () => {
    expect((await api('get', '/audit', t.DA)).status).toBe(403);
    expect((await api('get', '/farmers', t.EABC)).status).toBe(403);
    const da = await api('get', '/farmers', t.DA);
    expect(da.body.every((f: any) => f.kebeleId === 'KEB-01')).toBe(true);
    expect((await api('get', '/farmers/FARM-2026-04822', t.DA)).status).toBe(403);
    expect((await api('get', '/farmers')).status).toBe(401);
  });

  it('audit trail is hash-chained, immutable and verifiable', async () => {
    const v = await api('get', '/audit/verify', t.AUDITOR);
    expect(v.body.valid).toBe(true);
    expect(v.body.entries).toBeGreaterThan(20);
    await expect(app.get(DataSource).query(`UPDATE audit_log SET action = 'X' WHERE seq = 1`)).rejects.toThrow(/immutable/);
    const list = await api('get', '/audit?page=1&pageSize=5', t.AUDITOR);
    expect(list.body).toHaveLength(5);
    expect(Number(list.headers['x-total-count'])).toBeGreaterThan(5);
  });
});
