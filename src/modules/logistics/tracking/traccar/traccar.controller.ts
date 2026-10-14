import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import * as crypto from 'crypto';
import { Public, RequirePermissions } from '../../../../common/decorators';
import { AppError, Errors } from '../../../../common/utils/errors';
import { TrackingService } from '../tracking.service';
import { TraccarPollerService } from './traccar-poller.service';
import { TRACCAR_PROVIDER, TraccarDevice, TraccarEvent, TraccarMapper } from './traccar.mapper';

const MAX_BATCH = 1000;

/**
 * GPS Tracking Platform (Traccar) integration endpoints.
 * Webhooks are machine-to-machine: no JWT, authenticated by the shared secret header X-Traccar-Secret
 * (configure Traccar `forward.url` / `event.forward.url` with `forward.header = X-Traccar-Secret: <secret>`).
 */
@ApiTags('Logistics · Traccar integration')
@Controller({ path: 'integrations/traccar', version: '1' })
export class TraccarController {
  constructor(
    private readonly config: ConfigService,
    private readonly tracking: TrackingService,
    private readonly poller: TraccarPollerService
  ) {}

  private assertSecret(header: string | undefined) {
    const secret = this.config.get<string>('logistics.traccar.webhookSecret') || '';
    if (!secret) throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE', 'Traccar webhook is not configured');
    // hash both sides → equal-length buffers for timingSafeEqual (no length leak)
    const a = crypto.createHash('sha256').update(String(header ?? '')).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    if (!header || !crypto.timingSafeEqual(a, b)) throw Errors.unauthorized('Invalid webhook secret', 'INVALID_WEBHOOK_SECRET');
  }

  @Post('positions')
  @Public()
  @HttpCode(200)
  @ApiHeader({ name: 'X-Traccar-Secret', required: true })
  @ApiOperation({ summary: 'Traccar position forwarding webhook: { position, device } or an array of them → per-position ingest results' })
  async positions(@Headers('x-traccar-secret') secret: string | undefined, @Body() body: unknown) {
    this.assertSecret(secret);
    const items = TraccarMapper.unwrapForward(body);
    if (!items.length) throw Errors.unprocessable('Expected { position, device } or an array of them');
    if (items.length > MAX_BATCH) throw Errors.unprocessable(`At most ${MAX_BATCH} positions per request`);
    const normalized = items.map(it => TraccarMapper.toNormalized(it.position, it.device));
    const results = await this.tracking.ingest(normalized, 'TRACCAR_WEBHOOK');
    return {
      received: items.length,
      results: results.map((r, i) => ({ providerDeviceId: normalized[i].providerDeviceId, providerPositionId: normalized[i].providerPositionId, ...r }))
    };
  }

  @Post('events')
  @Public()
  @HttpCode(200)
  @ApiHeader({ name: 'X-Traccar-Secret', required: true })
  @ApiOperation({ summary: 'Traccar event forwarding webhook (deviceOffline → device OFFLINE, deviceUnknown → STALE, deviceOnline recorded; others ignored)' })
  async events(@Headers('x-traccar-secret') secret: string | undefined, @Body() body: unknown) {
    this.assertSecret(secret);
    const list = (Array.isArray(body) ? body : [body]).filter(x => x && typeof x === 'object') as Array<Record<string, unknown>>;
    if (!list.length) throw Errors.unprocessable('Expected { event, device } or an array of them');
    if (list.length > MAX_BATCH) throw Errors.unprocessable(`At most ${MAX_BATCH} events per request`);
    const results: Array<Record<string, unknown>> = [];
    for (const item of list) {
      const event = (item.event ?? item) as TraccarEvent;
      const device = (item.device ?? null) as TraccarDevice | null;
      const type = TraccarMapper.eventType(event?.type);
      if (!type) { results.push({ eventType: event?.type ?? null, status: 'IGNORED', reason: 'UNSUPPORTED_EVENT' }); continue; }
      const providerDeviceId = TraccarMapper.providerDeviceId({ deviceId: event.deviceId }, device);
      const r = await this.tracking.providerDeviceEvent({
        provider: TRACCAR_PROVIDER,
        providerDeviceId,
        type,
        occurredAt: event.eventTime ? new Date(event.eventTime) : new Date(),
        externalId: event.id !== undefined && event.id !== null ? String(event.id) : null,
        raw: { traccarEventType: event.type, traccarEventId: event.id ?? null }
      });
      results.push({ eventType: event.type, providerDeviceId, ...r });
    }
    return { received: list.length, results };
  }

  @Get('status')
  @ApiBearerAuth()
  @RequirePermissions('devices:manage')
  @ApiOperation({ summary: 'Traccar integration status (polling configured, last poll, last error, webhook configured) — no credentials' })
  status() {
    return this.poller.status();
  }
}
