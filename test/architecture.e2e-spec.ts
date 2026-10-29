// Backend architecture Stage A: realtime tickets, separate signature key, domain events wiring, OpenAPI export.
import * as crypto from 'crypto';
import { io } from 'socket.io-client';
import { DomainEvents } from '../src/common/events';
import { buildOpenApiDocument } from '../src/main';
import { Signature } from '../src/modules/signatures/entities/signature.entity';
import { CURRENT_SIGNATURE_KEY, SignaturesService } from '../src/modules/signatures/signatures.service';
import { sha256 } from '../src/common/utils/helpers';
import { DEMO_PIN } from '../src/database/seeds/seed.service';
import { DataSource } from 'typeorm';
import { SEED_USERS, startTestApi, TestApi } from './helpers/e2e';

describe('Architecture Stage A (e2e)', () => {
  let t: TestApi;

  beforeAll(async () => {
    t = await startTestApi({ listen: true });
  });

  afterAll(async () => {
    await t?.close();
  });

  const openSocket = (token: string) =>
    new Promise<{ event: string; payload: any }>(resolve => {
      const socket = io(`${t.baseUrl}/realtime`, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
      // Resolve before closing: close() fires 'disconnect' synchronously.
      const done = (event: string) => (payload: any) => {
        resolve({ event, payload });
        socket.close();
      };
      socket.on('connected', done('connected'));
      socket.on('error', done('error'));
      socket.on('disconnect', done('disconnect'));
    });

  describe('realtime ticket', () => {
    it('opens the socket but is refused by the REST API', async () => {
      const session = await t.loginAs('MOA');
      const r = await t.call('post', '/v1/auth/realtime-ticket', session);
      expect(r.status).toBe(200);
      expect(r.body.ticket).toEqual(expect.any(String));
      const ttl = new Date(r.body.expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);

      const rest = await t.call('get', '/auth/me', r.body.ticket);
      expect(rest.status).toBe(401);
      expect(rest.body.error.code).toBe('TICKET_NOT_FOR_API');

      const ws = await openSocket(r.body.ticket);
      expect(ws.event).toBe('connected');
      expect(ws.payload.role).toBe('MOA');
    });

    it('requires a signed-in session and dies with the session', async () => {
      expect((await t.call('post', '/v1/auth/realtime-ticket')).status).toBe(401);
      const session = await t.loginAsUser(SEED_USERS.ADAMA_WOREDA);
      const { ticket } = (await t.call('post', '/v1/auth/realtime-ticket', session)).body;
      expect((await t.call('post', '/auth/logout', session)).status).toBe(200);
      const ws = await openSocket(ticket);
      expect(ws.event).not.toBe('connected');
    });
  });

  describe('signature key', () => {
    it('signs with SIGNATURE_SECRET (key sig-v1), not the JWT secret', async () => {
      const signatures = t.app.get(SignaturesService);
      const user = { id: 'U-MOA-01', name: 'Dr. Melesse Mekonnen', role: 'MOA' } as any;
      const payload = { doc: 'ND-TEST', total: 1 };
      const sig = await signatures.sign(user, { pin: DEMO_PIN }, 'TEST_DOC', 'ND-TEST', payload);
      const row = (await signatures.findById(sig.id))!;
      expect(row.keyId).toBe(CURRENT_SIGNATURE_KEY);
      const withSigKey = crypto
        .createHmac('sha256', process.env.SIGNATURE_SECRET!)
        .update([row.userId, row.targetType, row.targetId, row.payloadHash, row.signedAt].join('|'))
        .digest('hex');
      expect(row.signatureHash).toBe(withSigKey);
      expect((await signatures.verify(sig.id, payload)).valid).toBe(true);
      expect((await signatures.verify(sig.id, { ...payload, total: 2 })).valid).toBe(false);
    });

    it('still verifies signatures made with the JWT secret before the key split', async () => {
      const signatures = t.app.get(SignaturesService);
      const payload = { legacy: true };
      const parts = ['U-MOA-01', 'TEST_DOC', 'LEGACY-1', sha256(payload), '2026-08-24 09:00:00'];
      await t.app.get(DataSource).getRepository(Signature).insert({
        id: 'SIG-LEGACY-TEST', userId: parts[0], signerName: 'Dr. Melesse Mekonnen', role: 'MOA', method: 'PIN',
        targetType: parts[1], targetId: parts[2], payloadHash: parts[3], signedAt: parts[4], keyId: 'jwt-legacy',
        signatureHash: crypto.createHmac('sha256', process.env.JWT_SECRET!).update(parts.join('|')).digest('hex')
      });
      expect((await signatures.verify('SIG-LEGACY-TEST', payload)).valid).toBe(true);
    });
  });

  it('domain events are available application-wide', () => {
    expect(t.app.get(DomainEvents)).toBeInstanceOf(DomainEvents);
  });

  it('the OpenAPI document includes versioned routes with typed responses', () => {
    const doc = buildOpenApiDocument(t.app);
    const op = doc.paths['/api/v1/auth/realtime-ticket']?.post;
    expect(op).toBeDefined();
    expect(JSON.stringify(op!.responses['200'])).toContain('RealtimeTicketDto');
  });
});
