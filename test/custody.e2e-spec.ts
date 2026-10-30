// Stock lots + QC hold, exact decimal ledger, QR chain of custody, security incidents.
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { SeedService } from '../src/database/seeds/seed.service';
import { InventoryService } from '../src/modules/logistics/warehouses/inventory.service';
import { StorageService } from '../src/modules/storage/storage.service';

describe('Lots, QC, custody chain and security incidents (e2e)', () => {
  let app: NestExpressApplication;
  let http: any;
  const t: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const items = (b: any) => (Array.isArray(b) ? b : b.items);
  const api = (method: 'get' | 'post' | 'patch', url: string, token?: string) => {
    const r = request(http)[method](`/api${url}`);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    const seeder = app.get(SeedService);
    await app.get(StorageService).emptyTestBuckets();
    await seeder.reset();
    await seeder.seed();
    for (const role of ['LOGISTICS_MANAGER', 'DISPATCHER', 'WAREHOUSE_OPERATOR', 'ECAE', 'DRIVER']) {
      t[role] = (await api('post', '/auth/demo-login').send({ role })).body.token;
    }
    const whs = items((await api('get', '/v1/warehouses?pageSize=50', t.LOGISTICS_MANAGER).expect(200)).body);
    for (const w of whs) ids[w.code] = w.id;
    const products = items((await api('get', '/v1/products', t.LOGISTICS_MANAGER).expect(200)).body);
    ids.NPSB = products.find((p: any) => p.sku === 'NPSB').id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('existing stock was migrated into PASSED opening lots that sum to the balance', async () => {
    const inv = await api('get', `/v1/warehouses/${ids['WH-MOJO']}/inventory`, t.LOGISTICS_MANAGER).expect(200);
    const lots = await api('get', `/v1/warehouses/${ids['WH-MOJO']}/lots`, t.LOGISTICS_MANAGER).expect(200);
    for (const line of inv.body.items) {
      const sum = lots.body.filter((l: any) => l.productId === line.productId).reduce((s: number, l: any) => s + l.onHand, 0);
      expect(sum).toBeCloseTo(line.onHand, 3);
    }
    expect(lots.body.every((l: any) => l.qcStatus === 'PASSED')).toBe(true);
  });

  it('receipts create lots; PENDING-QC stock is on hand but not available', async () => {
    const before = (await api('get', `/v1/warehouses/${ids['WH-MOJO']}/inventory`, t.LOGISTICS_MANAGER).expect(200)).body.items.find((i: any) => i.productId === ids.NPSB);
    await api('post', '/v1/inventory/transactions', t.WAREHOUSE_OPERATOR).send({ type: 'RECEIPT', warehouseId: ids['WH-MOJO'], productId: ids.NPSB, quantity: 30, lotNumber: 'lot-npsb-a', expiryDate: future(300), notes: 'Vessel MV Abbay II discharge' }).expect(201);
    await api('post', '/v1/inventory/transactions', t.WAREHOUSE_OPERATOR).send({ type: 'RECEIPT', warehouseId: ids['WH-MOJO'], productId: ids.NPSB, quantity: 10, lotNumber: 'LOT-NPSB-B', qcStatus: 'PENDING', notes: 'Awaiting ECAE sampling' }).expect(201);
    const after = (await api('get', `/v1/warehouses/${ids['WH-MOJO']}/inventory`, t.LOGISTICS_MANAGER).expect(200)).body.items.find((i: any) => i.productId === ids.NPSB);
    expect(after.onHand).toBeCloseTo(before.onHand + 40, 3);
    expect(after.available).toBeCloseTo(before.available + 30, 3); // pending lot excluded
    expect(after.qualityBlocked).toBeCloseTo(10, 3);
    const lots = (await api('get', `/v1/warehouses/${ids['WH-MOJO']}/lots?productId=${ids.NPSB}`, t.LOGISTICS_MANAGER).expect(200)).body;
    ids.LOT_A = lots.find((l: any) => l.lotNumber === 'LOT-NPSB-A').id;
    ids.LOT_B = lots.find((l: any) => l.lotNumber === 'LOT-NPSB-B').id;
    expect(lots.find((l: any) => l.id === ids.LOT_B)).toMatchObject({ qcStatus: 'PENDING', usable: false, available: 0 });
  });

  it('shipment naming its QR lot reserves exactly that lot', async () => {
    const s = await api('post', '/v1/shipments', t.DISPATCHER).send({
      originWarehouseId: ids['WH-MOJO'], destinationWarehouseId: ids['WH-NAZRET'], productId: ids.NPSB, qrLot: 'LOT-NPSB-A', waybillNumber: 'tr-wb-55001',
      cargoDescription: '25 MT NPSB lot A', plannedQuantity: 25,
      plannedPickupAt: new Date(Date.now() + 3600e3).toISOString(), plannedDeliveryAt: new Date(Date.now() + 8 * 3600e3).toISOString()
    }).expect(201);
    ids.SH = s.body.id;
    expect(s.body.waybillNumber).toBe('TR-WB-55001');
    const lotA = (await api('get', `/v1/warehouses/${ids['WH-MOJO']}/lots`, t.LOGISTICS_MANAGER).expect(200)).body.find((l: any) => l.id === ids.LOT_A);
    expect(lotA).toMatchObject({ reserved: 25, available: 5 });
    // a second shipment may not take the pending lot, nor more than lot A has left
    const dup = await api('post', '/v1/shipments', t.DISPATCHER).send({
      originWarehouseId: ids['WH-MOJO'], destinationWarehouseId: ids['WH-NAZRET'], productId: ids.NPSB, waybillNumber: 'TR-WB-55001',
      cargoDescription: 'dup waybill', plannedQuantity: 1, plannedPickupAt: new Date(Date.now() + 3600e3).toISOString(), plannedDeliveryAt: new Date(Date.now() + 8 * 3600e3).toISOString()
    });
    expect(dup.status).toBe(409);
    const pending = await api('post', '/v1/shipments', t.DISPATCHER).send({
      originWarehouseId: ids['WH-MOJO'], destinationWarehouseId: ids['WH-NAZRET'], productId: ids.NPSB, qrLot: 'LOT-NPSB-B',
      cargoDescription: 'pending lot', plannedQuantity: 1, plannedPickupAt: new Date(Date.now() + 3600e3).toISOString(), plannedDeliveryAt: new Date(Date.now() + 8 * 3600e3).toISOString()
    });
    expect(pending.status).toBe(422);
    expect(JSON.stringify(pending.body)).toContain('PENDING');
  });

  it('QC hold blocks loading of the reserved lot and alerts; release re-enables it', async () => {
    expect((await api('post', `/v1/inventory/lots/${ids.LOT_A}/qc`, t.WAREHOUSE_OPERATOR).send({ status: 'HELD', notes: 'operator cannot' })).status).toBe(403);
    const hold = await api('post', `/v1/inventory/lots/${ids.LOT_A}/qc`, t.ECAE).send({ status: 'HELD', reference: 'ECAE-NC-2026-17', notes: 'Nitrogen below spec in sample 3' }).expect(201);
    expect(hold.body.blockedShipments.length).toBe(1);
    const alerts = await api('get', '/v1/alerts?category=Inventory', t.LOGISTICS_MANAGER).expect(200);
    expect(JSON.stringify(alerts.body)).toContain('LOT-NPSB-A');
    const inventory = app.get(InventoryService);
    await expect(inventory.dispatchLoaded(ids['WH-MOJO'], ids.NPSB, 25, 25, { type: 'SHIPMENT', id: ids.SH }, 'test')).rejects.toThrow(/Loading blocked/);
    await api('post', `/v1/inventory/lots/${ids.LOT_A}/qc`, t.ECAE).send({ status: 'PASSED', reference: 'ECAE-COC-2026-88' }).expect(201);
    const moved = await inventory.dispatchLoaded(ids['WH-MOJO'], ids.NPSB, 24.5, 25, { type: 'SHIPMENT', id: ids.SH }, 'test');
    expect(moved).toEqual([expect.objectContaining({ lotNumber: 'LOT-NPSB-A', quantity: 24.5 })]);
    const lotA = (await api('get', `/v1/warehouses/${ids['WH-MOJO']}/lots`, t.LOGISTICS_MANAGER).expect(200)).body.find((l: any) => l.id === ids.LOT_A);
    expect(lotA).toMatchObject({ onHand: 5.5, reserved: 0 });
    // receipt at the destination keeps the lot number and links the source lot
    const inc = await inventory.receive(ids['WH-NAZRET'], ids.NPSB, 24.3, 'DELIVERY_RECEIPT', { type: 'DELIVERY', id: 'test-delivery' }, 'test', undefined, { fromShipment: { id: ids.SH } });
    expect(inc).toEqual([expect.objectContaining({ lotNumber: 'LOT-NPSB-A', quantity: 24.3 })]);
    const naz = (await api('get', `/v1/warehouses/${ids['WH-NAZRET']}/lots`, t.LOGISTICS_MANAGER).expect(200)).body.find((l: any) => l.lotNumber === 'LOT-NPSB-A');
    expect(naz).toMatchObject({ sourceLotId: ids.LOT_A, qcStatus: 'PASSED' });
  });

  it('decimal ledger: 10 × 0.1 MT is exactly 1 MT (no floating-point drift)', async () => {
    const before = (await api('get', `/v1/warehouses/${ids['WH-MOJO']}/inventory`, t.LOGISTICS_MANAGER).expect(200)).body.items.find((i: any) => i.productId === ids.NPSB).onHand;
    for (let i = 0; i < 10; i++) {
      await api('post', '/v1/inventory/transactions', t.WAREHOUSE_OPERATOR).send({ type: 'RETURN', warehouseId: ids['WH-MOJO'], productId: ids.NPSB, quantity: 0.1, lotNumber: 'LOT-NPSB-A' }).expect(201);
    }
    const after = (await api('get', `/v1/warehouses/${ids['WH-MOJO']}/inventory`, t.LOGISTICS_MANAGER).expect(200)).body.items.find((i: any) => i.productId === ids.NPSB).onHand;
    expect(Math.round((after - before) * 1000)).toBe(1000);
    expect(String(after - before)).not.toMatch(/0000000|9999999/);
  });

  it('chain of custody: matching scans, mismatch alert, idempotent replay', async () => {
    const inTransit = items((await api('get', '/v1/shipments?status=IN_TRANSIT', t.DISPATCHER).expect(200)).body)[0];
    const chain = await api('get', `/v1/shipments/${inTransit.id}/scans`, t.DISPATCHER).expect(200);
    expect(chain.body.expectedLots.length).toBeGreaterThan(0);
    const good = chain.body.expectedLots[0];
    const ok = await api('post', `/v1/shipments/${inTransit.id}/scans`, t.DISPATCHER).send({ scanType: 'CHECKPOINT', lotNumber: good, bagCount: 800, locationLabel: 'Awash weighbridge', clientScanId: 'scan-test-1' }).expect(201);
    expect(ok.body.result).toBe('MATCH');
    const again = await api('post', `/v1/shipments/${inTransit.id}/scans`, t.DISPATCHER).send({ scanType: 'CHECKPOINT', lotNumber: good, clientScanId: 'scan-test-1' }).expect(201);
    expect(again.body).toMatchObject({ id: ok.body.id, replayed: true });
    const bad = await api('post', `/v1/shipments/${inTransit.id}/scans`, t.DISPATCHER).send({ scanType: 'CHECKPOINT', lotNumber: 'LOT-FOREIGN-999', locationLabel: 'Adama checkpoint' }).expect(201);
    expect(bad.body.result).toBe('MISMATCH');
    const alerts = await api('get', '/v1/alerts', t.LOGISTICS_MANAGER).expect(200);
    expect(JSON.stringify(alerts.body)).toContain('QR lot mismatch');
    const early = await api('post', `/v1/shipments/${ids.SH}/scans`, t.DISPATCHER).send({ scanType: 'CHECKPOINT', lotNumber: 'LOT-NPSB-A' });
    expect(early.status).toBe(409); // not in transit yet
    const summary = (await api('get', `/v1/shipments/${inTransit.id}/scans`, t.DISPATCHER).expect(200)).body.summary;
    expect(summary).toMatchObject({ checkpoints: 2, mismatches: 1 });
  });

  it('security incident: theft needs a police report to resolve; audited lifecycle', async () => {
    const inTransit = items((await api('get', '/v1/shipments?status=IN_TRANSIT', t.DISPATCHER).expect(200)).body)[0];
    const inc = await api('post', '/v1/security-incidents', t.DISPATCHER).send({
      incidentType: 'THEFT', shipmentId: inTransit.id, description: 'Seals broken; about 12 bags missing at Mojo junction stop', quantityAffectedMt: 0.6, locationLabel: 'Mojo junction'
    }).expect(201);
    expect(inc.body).toMatchObject({ incidentNumber: expect.stringMatching(/^SI-\d{4}$/), severity: 'CRITICAL', status: 'OPEN', shipmentNumber: inTransit.shipmentNumber });
    expect(inc.body.alertId).toBeTruthy();
    expect((await api('post', `/v1/security-incidents/${inc.body.id}/resolve`, t.DISPATCHER).send({ resolution: 'Recovered all bags' })).status).toBe(403);
    expect((await api('post', `/v1/security-incidents/${inc.body.id}/resolve`, t.LOGISTICS_MANAGER).send({ resolution: 'Recovered all bags at the depot' })).status).toBe(422);
    await api('patch', `/v1/security-incidents/${inc.body.id}`, t.LOGISTICS_MANAGER).send({ status: 'INVESTIGATING', policeReportNo: 'FPC-ADM-2026-4411', policeStation: 'Adama Federal Police' }).expect(200);
    const res = await api('post', `/v1/security-incidents/${inc.body.id}/resolve`, t.LOGISTICS_MANAGER).send({ resolution: 'Bags recovered by Federal Police; driver cleared' }).expect(200);
    expect(res.body).toMatchObject({ status: 'RESOLVED', policeReportNo: 'FPC-ADM-2026-4411' });
    await api('post', `/v1/security-incidents/${inc.body.id}/close`, t.LOGISTICS_MANAGER).expect(200);
    const list = await api('get', `/v1/security-incidents?shipmentId=${inTransit.id}`, t.LOGISTICS_MANAGER).expect(200);
    expect(list.body.items[0].status).toBe('CLOSED');
  });
});
