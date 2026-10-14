// Logistics & Driver Management e2e — follows the spec's §22 example scenario end to end:
// driver onboarding → truck + GPS device → Traccar ingestion → SH 20 MT → eligible assignment (double-booking blocked)
// → acceptance, checklist, loading, idempotent dispatch → GPS to destination geofence (auto ARRIVED) → 19.8 MT delivered
// with proof (0.2 MT discrepancy) → inventory reconciled → trip completed, truck & driver released. Plus WebSocket auth & RBAC.
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { SeedService, DEMO_PASSWORD, DEMO_PIN } from '../src/database/seeds/seed.service';
import { RealtimeService } from '../src/modules/logistics/realtime/realtime.service';
import { TrackingService } from '../src/modules/logistics/tracking/tracking.service';
import { JobFailure } from '../src/modules/logistics/jobs/entities/job-failure.entity';

const SECRET = process.env.TRACCAR_WEBHOOK_SECRET!;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const items = (body: any) => (Array.isArray(body) ? body : body.items);

describe('Logistics & Driver Management (e2e)', () => {
  let app: NestExpressApplication;
  let http: any;
  let baseUrl: string;
  const t: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, token?: string) => {
    const r = request(http)[method](`/api${url}`);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  const login = async (email: string) => (await api('post', '/auth/login').send({ email, password: DEMO_PASSWORD }).expect(200)).body.token;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.listen(0);
    http = app.getHttpServer();
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    const seeder = app.get(SeedService);
    await seeder.reset();
    await seeder.seed();
    t.MANAGER = await login('logistics.manager@eslse.gov.et');
    t.DISPATCHER = await login('dispatch@eslse.gov.et');
    t.FLEET = await login('fleet@eslse.gov.et');
    t.STORE_MOJO = await login('store.mojo@eslse.gov.et');
    t.SOLOMON = await login('solomon.kebede@eslse.gov.et');
    t.MOA = (await api('post', '/auth/demo-login').send({ role: 'MOA' })).body.token;
    t.ADMIN = (await api('post', '/auth/demo-login').send({ role: 'ADMIN' })).body.token;

    const whs = items((await api('get', '/v1/warehouses?pageSize=50', t.MANAGER).expect(200)).body);
    for (const w of whs) ids[w.code] = w.id;
    const products = items((await api('get', '/v1/products', t.MANAGER).expect(200)).body);
    ids.NPSB = products.find((p: any) => p.sku === 'NPSB').id;
    const types = items((await api('get', '/v1/vehicle-types', t.FLEET).expect(200)).body);
    ids.HGV = types.find((v: any) => v.code === 'HGV-40').id;
    const routes = items((await api('get', '/v1/routes', t.DISPATCHER).expect(200)).body);
    ids.ROUTE = routes.find((r: any) => r.code === 'RT-MOJO-ADU').id;
    ids.SOLOMON = items((await api('get', '/v1/drivers?q=Solomon', t.MANAGER).expect(200)).body)[0].id;
    ids.HANA = items((await api('get', '/v1/drivers?q=Hana', t.MANAGER).expect(200)).body)[0].id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('frontend contract: /api/integrations/logistics keeps the EFMIS gpsFleet / warehouseUtilization shapes', async () => {
    const r = await api('get', '/integrations/logistics', t.MOA).expect(200);
    const trk = r.body.gpsFleet.find((f: any) => f.truckId === 'ESLSE-TRK-8819');
    for (const k of ['truckId', 'driver', 'vehicleNo', 'cargo', 'lat', 'lng', 'speedKmH', 'route', 'eta', 'status', 'qrLot']) expect(trk).toHaveProperty(k);
    expect(trk.driver).toBe('Tadesse Hailu');
    expect(trk.status).toBe('NORMAL_MOVING');
    expect(r.body.gpsFleet.find((f: any) => f.truckId === 'PRIVATE-TRK-381').status).toBe('STOPPED_ALERT');
    const mojo = r.body.warehouseUtilization.find((w: any) => w.name === 'Mojo Central Mega-Hub');
    expect(mojo).toMatchObject({ capacityMT: 150000, status: 'CAPACITY_ALERT_80' });
    expect(mojo.currentStockMT).toBeGreaterThan(120000);
  });

  it('driver onboarding: verification requires a verified licence document', async () => {
    const d = await api('post', '/v1/drivers', t.MANAGER).send({
      employeeNumber: 'ESLSE-DRV-0999', firstName: 'Meseret', lastName: 'Alemu', phone: '0911809999',
      licenceNumber: 'ET-DL-0999-2024', licenceClass: 'CE', licenceExpiryDate: '2029-12-31', employer: 'ESLSE'
    }).expect(201);
    expect(d.body.verificationStatus).toBe('PENDING_VERIFICATION');
    expect(d.body.licenceNumber).toBe('ET-DL-0999-2024'); // manager has drivers:sensitive
    expect((await api('post', `/v1/drivers/${d.body.id}/verify`, t.MANAGER).send({})).status).toBe(422);
    const doc = await api('post', `/v1/drivers/${d.body.id}/documents`, t.MANAGER)
      .field('documentType', 'LICENCE').field('expiresAt', '2029-12-31').attach('file', PDF, { filename: 'licence.pdf', contentType: 'application/pdf' }).expect(201);
    await api('patch', `/v1/driver-documents/${doc.body.id}/verification`, t.MANAGER).send({ status: 'VERIFIED' }).expect(200);
    const v = await api('post', `/v1/drivers/${d.body.id}/verify`, t.MANAGER).send({}).expect(200);
    expect(v.body.verificationStatus).toBe('VERIFIED');
    expect(v.body.availabilityStatus).toBe('AVAILABLE');
    // dispatcher can read drivers but not licence numbers
    const asDispatcher = await api('get', `/v1/drivers/${d.body.id}`, t.DISPATCHER).expect(200);
    expect(asDispatcher.body.licenceNumber).toMatch(/^\*+/);
  });

  it('fleet: register a 30 MT truck and pair a Teltonika GPS device (one device per truck)', async () => {
    const truck = await api('post', '/v1/trucks', t.FLEET).send({ fleetCode: 'TRK-E2E-30', plateNumber: '3-ET-30030', vehicleTypeId: ids.HGV, capacityValue: 30 }).expect(201);
    ids.TRUCK = truck.body.id;
    const dev = await api('post', '/v1/gps-devices', t.FLEET).send({ providerDeviceId: '352093100777777', imei: '352093100777777', model: 'Teltonika FMB920' }).expect(201);
    ids.DEVICE = dev.body.id;
    await api('post', `/v1/gps-devices/${dev.body.id}/assign-truck`, t.FLEET).send({ truckId: ids.TRUCK, reason: 'Installation at Mojo workshop' }).expect(200);
    const dev2 = await api('post', '/v1/gps-devices', t.FLEET).send({ providerDeviceId: '352093100888888', imei: '352093100888888' }).expect(201);
    expect((await api('post', `/v1/gps-devices/${dev2.body.id}/assign-truck`, t.FLEET).send({ truckId: ids.TRUCK, reason: 'second device' })).status).toBe(409);
  });

  it('Traccar webhook: secret required, knots → km/h, duplicates and out-of-order handled idempotently', async () => {
    const now = Date.now();
    const pos = (id: number, ms: number, uniqueId = '352093100777777') => ({
      position: { id, deviceId: 77, latitude: 8.5873, longitude: 39.1213, speed: 10, course: 90, fixTime: new Date(ms).toISOString() },
      device: { id: 77, uniqueId }
    });
    expect((await api('post', '/v1/integrations/traccar/positions').send(pos(9001, now - 60_000))).status).toBe(401);
    const send = (body: object) => api('post', '/v1/integrations/traccar/positions').set('X-Traccar-Secret', SECRET).send(body);
    expect(JSON.stringify((await send(pos(9001, now - 60_000))).body)).toContain('ACCEPTED');
    expect(JSON.stringify((await send(pos(9001, now - 60_000))).body)).toContain('DUPLICATE');
    expect(JSON.stringify((await send(pos(9000, now - 120_000))).body)).toContain('OUT_OF_ORDER');
    expect(JSON.stringify((await send(pos(1, now, '999999999999999'))).body)).toMatch(/REJECTED|UNKNOWN_DEVICE/);
    const live = await api('get', `/v1/tracking/trucks/${ids.TRUCK}`, t.DISPATCHER).expect(200);
    expect(JSON.stringify(live.body)).toContain('18.52'); // 10 knots = 18.52 km/h
  });

  it('real Traccar forwarding: id 0 positions all ingested, webhook + poller copies deduplicated, link close does not flap', async () => {
    const send = (body: object) => api('post', '/v1/integrations/traccar/positions').set('X-Traccar-Secret', SECRET).send(body);
    const base = Date.now() - 30_000;
    // Traccar pushes before persisting: every forwarded position has id 0
    const fwd = (ms: number, lng: number) => ({
      position: { id: 0, deviceId: 77, latitude: 8.5873, longitude: lng, speed: 20, course: 90, fixTime: new Date(ms).toISOString() },
      device: { id: 77, uniqueId: '352093100777777' }
    });
    const results: string[] = [];
    for (let i = 0; i < 3; i++) results.push(JSON.stringify((await send(fwd(base + i * 5_000, 39.1213 + i * 0.001))).body));
    for (const r of results) expect(r).toContain('ACCEPTED');
    // the same fix later pulled by the poller with its persisted id → duplicate, not a second row
    const pulled = { ...fwd(base + 10_000, 39.1233), position: { ...fwd(base + 10_000, 39.1233).position, id: 555001 } };
    expect(JSON.stringify((await send(pulled)).body)).toContain('DUPLICATE');
    // tracker closes its link right after sending → platform says offline → connectivity unchanged
    const ev = await api('post', '/v1/integrations/traccar/events').set('X-Traccar-Secret', SECRET)
      .send({ event: { id: 9901, type: 'deviceOffline', deviceId: 77, eventTime: new Date().toISOString() }, device: { id: 77, uniqueId: '352093100777777' } }).expect(200);
    expect(JSON.stringify(ev.body)).toContain('RECENTLY_SEEN');
    const dev = await api('get', `/v1/gps-devices/${ids.DEVICE}`, t.FLEET).expect(200);
    expect(dev.body.connectivity).not.toBe('OFFLINE');
  });

  it('shipment SH-xxxx: validation and stock reservation at origin', async () => {
    const before = items((await api('get', `/v1/warehouses/${ids['WH-MOJO']}/inventory`, t.MANAGER).expect(200)).body ?? []);
    const reservedBefore = (before.find?.((b: any) => b.productId === ids.NPSB || b.sku === 'NPSB')?.reserved) ?? 0;
    const base = {
      originWarehouseId: ids['WH-MOJO'], destinationWarehouseId: ids['WH-ADAMA-UNION'], productId: ids.NPSB, cargoDescription: '20 MT NPSB bagged',
      plannedQuantity: 20, plannedPickupAt: new Date(Date.now() + 3600e3).toISOString(), plannedDeliveryAt: new Date(Date.now() + 6 * 3600e3).toISOString()
    };
    expect((await api('post', '/v1/shipments', t.DISPATCHER).send({ ...base, destinationWarehouseId: ids['WH-MOJO'] })).status).toBe(422);
    const s = await api('post', '/v1/shipments', t.DISPATCHER).send(base).expect(201);
    ids.SHIPMENT = s.body.id;
    expect(s.body.shipmentNumber).toMatch(/^SH-\d{4,}$/);
    expect(s.body.status).toBe('DRAFT');
    await api('post', `/v1/shipments/${ids.SHIPMENT}/plan`, t.DISPATCHER).send({ routeId: ids.ROUTE }).expect(200);
    const after = items((await api('get', `/v1/warehouses/${ids['WH-MOJO']}/inventory`, t.MANAGER).expect(200)).body ?? []);
    const reservedAfter = after.find((b: any) => b.productId === ids.NPSB || b.sku === 'NPSB').reserved;
    expect(reservedAfter - reservedBefore).toBeCloseTo(20);
  });

  it('assignment: ineligible driver blocked with reasons; truck/driver double booking prevented', async () => {
    const start = new Date(Date.now() + 3600e3).toISOString();
    const bad = await api('post', '/v1/trips', t.DISPATCHER).send({ shipmentIds: [ids.SHIPMENT], truckId: ids.TRUCK, driverId: ids.HANA, routeId: ids.ROUTE, plannedStartAt: start });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body).toLowerCase()).toContain('licence');
    // assignment modal: eligible trucks for the load, and why the others cannot be selected
    const fits = await api('get', '/v1/trucks/eligible?quantity=20&cargoType=BAGGED_FERTILIZER', t.DISPATCHER).expect(200);
    expect(fits.body.eligible.map((x: any) => x.id)).toContain(ids.TRUCK);
    const tooBig = await api('get', '/v1/trucks/eligible?quantity=35', t.DISPATCHER).expect(200);
    const ours = tooBig.body.ineligible.find((x: any) => x.truck.id === ids.TRUCK);
    expect(ours.reasons.join(' ')).toContain('capacity');
    const trip = await api('post', '/v1/trips', t.DISPATCHER).send({ shipmentIds: [ids.SHIPMENT], truckId: ids.TRUCK, driverId: ids.SOLOMON, routeId: ids.ROUTE, plannedStartAt: start }).expect(201);
    ids.TRIP = trip.body.id;
    // reassignment: the trip's own (now RESERVED) truck stays eligible when re-validating that trip
    const own = await api('get', `/v1/trucks/eligible?quantity=20&excludeTripId=${ids.TRIP}`, t.DISPATCHER).expect(200);
    expect(own.body.eligible.map((x: any) => x.id)).toContain(ids.TRUCK);
    const other = await api('get', '/v1/trucks/eligible?quantity=20', t.DISPATCHER).expect(200);
    expect(other.body.eligible.map((x: any) => x.id)).not.toContain(ids.TRUCK);
    expect(trip.body.tripNumber).toMatch(/^TR-\d{4,}$/);
    // second shipment, same driver + truck → rejected
    const s2 = await api('post', '/v1/shipments', t.DISPATCHER).send({
      originWarehouseId: ids['WH-MOJO'], destinationWarehouseId: ids['WH-NAZRET'], productId: ids.NPSB, cargoDescription: '5 MT NPSB', plannedQuantity: 5,
      plannedPickupAt: start, plannedDeliveryAt: new Date(Date.now() + 5 * 3600e3).toISOString()
    }).expect(201);
    await api('post', `/v1/shipments/${s2.body.id}/plan`, t.DISPATCHER).send({}).expect(200);
    const dbl = await api('post', '/v1/trips', t.DISPATCHER).send({ shipmentIds: [s2.body.id], truckId: ids.TRUCK, driverId: ids.SOLOMON, plannedStartAt: start });
    expect([409, 422]).toContain(dbl.status);
  });

  it('driver acceptance, pre-trip checklist, loading, idempotent dispatch', async () => {
    await api('post', `/v1/trips/${ids.TRIP}/accept`, t.SOLOMON).send({}).expect(200);
    const failed = await api('post', `/v1/trips/${ids.TRIP}/checklist`, t.SOLOMON).send({ items: [{ item: 'Brakes', ok: true }, { item: 'Tyres', ok: false, note: 'worn' }], driverAcknowledged: true });
    expect(failed.status).toBe(422);
    await api('post', `/v1/trips/${ids.TRIP}/checklist`, t.SOLOMON).send({ items: [{ item: 'Brakes', ok: true }, { item: 'Tyres', ok: true }, { item: 'Tarpaulin & seals', ok: true }], driverAcknowledged: true }).expect(200);
    await api('post', `/v1/trips/${ids.TRIP}/loading/start`, t.STORE_MOJO).send({}).expect(200);
    const loaded = await api('post', `/v1/trips/${ids.TRIP}/loading`, t.STORE_MOJO).send({ lines: [{ shipmentId: ids.SHIPMENT, loadedQuantity: 20 }] }).expect(200);
    expect(JSON.stringify(loaded.body)).toContain('READY');
    const d1 = await api('post', `/v1/trips/${ids.TRIP}/dispatch`, t.DISPATCHER).set('Idempotency-Key', 'dispatch-e2e-1').send({}).expect(200);
    const d2 = await api('post', `/v1/trips/${ids.TRIP}/dispatch`, t.DISPATCHER).set('Idempotency-Key', 'dispatch-e2e-1').send({}).expect(200);
    expect(JSON.stringify(d1.body)).toContain('DISPATCHED');
    expect(d2.body).toEqual(d1.body);
    const s = await api('get', `/v1/shipments/${ids.SHIPMENT}`, t.DISPATCHER).expect(200);
    expect(s.body.status).toBe('IN_TRANSIT');
    expect(s.body.waybillNumber).toMatch(/^WB-\d{4}-\d{6}$/); // issued at dispatch
  });

  it('GPS fixes recorded before dispatch (late upload) do not move the trip lifecycle', async () => {
    const started = new Date((await api('get', `/v1/trips/${ids.TRIP}`, t.DISPATCHER).expect(200)).body.actualStartAt).getTime();
    await api('post', '/v1/tracking/simulate', t.FLEET).send({
      truckId: ids.TRUCK,
      points: [
        { lat: 8.5850, lng: 39.1300, speedKmh: 30, recordedAt: new Date(started - 20_000).toISOString() },
        { lat: 8.5830, lng: 39.1400, speedKmh: 30, recordedAt: new Date(started - 10_000).toISOString() }
      ]
    }).expect(res => expect([200, 201]).toContain(res.status));
    expect((await api('get', `/v1/trips/${ids.TRIP}`, t.DISPATCHER).expect(200)).body.status).toBe('DISPATCHED');
  });

  it('GPS → IN_PROGRESS on movement → destination geofence (hysteresis) → ARRIVED; realtime events published', async () => {
    const t0 = Date.now() + 5_000;
    await api('post', '/v1/tracking/simulate', t.FLEET).send({
      truckId: ids.TRUCK,
      points: [
        { lat: 8.5600, lng: 39.2000, speedKmh: 45, recordedAt: new Date(t0).toISOString() },
        { lat: 8.5450, lng: 39.2600, speedKmh: 40, recordedAt: new Date(t0 + 60_000).toISOString() },
        { lat: 8.5512, lng: 39.2888, speedKmh: 8, recordedAt: new Date(t0 + 120_000).toISOString() },
        { lat: 8.5511, lng: 39.2891, speedKmh: 2, recordedAt: new Date(t0 + 180_000).toISOString() }
      ]
    }).expect(res => expect([200, 201]).toContain(res.status));
    const trip = await api('get', `/v1/trips/${ids.TRIP}`, t.DISPATCHER).expect(200);
    expect(trip.body.status).toBe('ARRIVED');
    const types = app.get(RealtimeService).recent.map(e => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['truck.location.updated', 'trip.status.updated', 'geofence.entered']));
    expect(await app.get(DataSource).getRepository(JobFailure).count()).toBe(0); // tracking processor handled every job
    const milestones = await api('get', `/v1/trips/${ids.TRIP}/milestones`, t.DISPATCHER).expect(200);
    expect(JSON.stringify(milestones.body)).toContain('REACHED');
  });

  it('delivery confirmation: authorised staff only, proof required for discrepancy, idempotent, inventory reconciled', async () => {
    const destBefore = items((await api('get', `/v1/warehouses/${ids['WH-ADAMA-UNION']}/inventory`, t.MANAGER).expect(200)).body);
    const onHandBefore = destBefore.find((b: any) => b.productId === ids.NPSB || b.sku === 'NPSB').onHand;
    await api('post', `/v1/trips/${ids.TRIP}/unloading`, t.DISPATCHER).send({}).expect(200);
    // origin storekeeper is not authorised for the destination warehouse
    expect((await api('post', `/v1/shipments/${ids.SHIPMENT}/delivery-confirmations`, t.STORE_MOJO).field('receiverName', 'X').field('receivedQuantity', '19.8').field('condition', 'GOOD')).status).toBe(403);
    // discrepancy without proof → 422
    expect((await api('post', `/v1/shipments/${ids.SHIPMENT}/delivery-confirmations`, t.DISPATCHER)
      .field('receiverName', 'Adama Union storekeeper').field('receivedQuantity', '19.8').field('condition', 'SHORT').field('finalDelivery', 'true')).status).toBe(422);
    const confirm = () => api('post', `/v1/shipments/${ids.SHIPMENT}/delivery-confirmations`, t.DISPATCHER).set('Idempotency-Key', 'delivery-e2e-1')
      .field('receiverName', 'Adama Union storekeeper').field('receivedQuantity', '19.8').field('condition', 'SHORT').field('finalDelivery', 'true')
      .field('notes', '4 bags torn').attach('proof', PDF, { filename: 'pod.pdf', contentType: 'application/pdf' });
    const first = await confirm().expect(201);
    expect(JSON.stringify(first.body)).toMatch(/-0\.2\b|-0\.19999/);
    const again = await confirm();
    expect(again.status).toBe(200);
    expect(again.body.id ?? again.body.delivery?.id).toBe(first.body.id ?? first.body.delivery?.id);
    const s = await api('get', `/v1/shipments/${ids.SHIPMENT}`, t.DISPATCHER).expect(200);
    expect(s.body.status).toBe('DELIVERED');
    const destAfter = items((await api('get', `/v1/warehouses/${ids['WH-ADAMA-UNION']}/inventory`, t.MANAGER).expect(200)).body);
    expect(destAfter.find((b: any) => b.productId === ids.NPSB || b.sku === 'NPSB').onHand - onHandBefore).toBeCloseTo(19.8);
  });

  it('trip completion releases truck and driver; shipment closed', async () => {
    const c = await api('post', `/v1/trips/${ids.TRIP}/complete`, t.DISPATCHER).send({}).expect(200);
    expect(JSON.stringify(c.body)).toContain('COMPLETED');
    expect((await api('get', `/v1/shipments/${ids.SHIPMENT}`, t.DISPATCHER)).body.status).toBe('CLOSED');
    expect((await api('get', `/v1/trucks/${ids.TRUCK}`, t.FLEET)).body.availabilityStatus).toBe('AVAILABLE');
    expect((await api('get', `/v1/drivers/${ids.SOLOMON}`, t.MANAGER)).body.availabilityStatus).toBe('AVAILABLE');
  });

  it('RBAC & scoping: drivers see only their trips, storekeepers only their warehouse', async () => {
    expect((await api('post', '/v1/shipments', t.SOLOMON).send({})).status).toBe(403);
    const mine = items((await api('get', '/v1/shipments', t.SOLOMON).expect(200)).body);
    expect(mine.every((s: any) => s.id === ids.SHIPMENT)).toBe(true);
    expect((await api('get', `/v1/warehouses/${ids['WH-ADAMA-UNION']}/inventory`, t.STORE_MOJO)).status).toBe(403);
    expect((await api('get', '/v1/drivers', t.STORE_MOJO)).status).toBe(403);
  });

  it('WebSocket: JWT required, fleet room for dispatchers, drivers cannot subscribe to other trucks', async () => {
    const connect = (token?: string) => io(`${baseUrl}/realtime`, { auth: token ? { token } : {}, transports: ['websocket'], forceNew: true, reconnection: false });
    const anon: Socket = connect();
    await new Promise<void>(resolve => { anon.on('disconnect', () => resolve()); anon.on('connect_error', () => resolve()); });
    anon.close();

    const disp = connect(t.DISPATCHER);
    const hello: any = await new Promise(resolve => disp.on('connected', resolve));
    expect(hello.rooms).toContain('fleet:all');
    const seededTruck = items((await api('get', '/v1/trucks?q=ESLSE-TRK-8819', t.FLEET)).body)[0].id;
    const evt = new Promise<any>(resolve => disp.on('truck.location.updated', resolve));
    await api('post', '/v1/tracking/simulate', t.FLEET).send({ truckId: seededTruck, points: [{ lat: 9.1, lng: 40.2, speedKmh: 60 }] });
    const received = await evt;
    expect(received).toMatchObject({ eventType: 'truck.location.updated', payloadVersion: 1 });
    expect(received.entities.truckId).toBe(seededTruck);
    disp.close();

    const drv = connect(t.SOLOMON);
    await new Promise(resolve => drv.on('connected', resolve));
    const ack: any = await drv.emitWithAck('subscribe', { type: 'truck', id: seededTruck });
    expect(ack.ok).toBe(false);
    drv.close();
  });

  it('operations: dashboard summary, v1 alerts, jobs, connectivity scan, driver compliance scan', async () => {
    const summary = await api('get', '/v1/dashboard/summary', t.MANAGER).expect(200);
    expect(JSON.stringify(summary.body)).toContain('AVAILABLE');
    await api('get', '/v1/alerts', t.DISPATCHER).expect(200);
    const jobs = await api('get', '/v1/jobs/stats', t.ADMIN).expect(200);
    expect(jobs.body.mode).toBe('inline');
    await app.get(TrackingService).runConnectivityScan();
    const expiring = await api('get', '/v1/drivers/expiring?days=30', t.MANAGER).expect(200);
    expect(JSON.stringify(expiring.body)).toContain('Hana');
    await api('get', '/v1/reports/trips', t.MANAGER).expect(200);
    await api('get', '/v1/reports/stock-discrepancies', t.MANAGER).expect(200);
  });
});
