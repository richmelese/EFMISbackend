import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestResult } from '../tracking.types';
import { TrackingService } from '../tracking.service';
import { TraccarDevice, TraccarMapper, TraccarPosition } from './traccar.mapper';

const DEVICE_CACHE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Optional pull mode: when TRACCAR_URL is set, polls GET {url}/api/positions (latest position per device) every
 * TRACCAR_POLL_SECONDS with a least-privilege, read-only Traccar service account (Basic auth). Credentials stay server-side:
 * they are never logged, returned by an API or sent to the browser. Duplicates are absorbed by the ingest idempotency.
 */
@Injectable()
export class TraccarPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('TraccarPoller');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private deviceCache: { at: number; byId: Map<string, TraccarDevice> } | null = null;
  lastPollAt: Date | null = null;
  lastSuccessAt: Date | null = null;
  lastError: string | null = null;
  lastSummary: Record<string, number> | null = null;

  constructor(private readonly config: ConfigService, private readonly tracking: TrackingService) {}

  private get baseUrl(): string {
    return (this.config.get<string>('logistics.traccar.url') || '').replace(/\/+$/, '');
  }

  get configured(): boolean {
    return !!this.baseUrl;
  }

  get webhookConfigured(): boolean {
    return !!this.config.get<string>('logistics.traccar.webhookSecret');
  }

  onModuleInit() {
    if (!this.configured) {
      this.logger.log('TRACCAR_URL not set — Traccar polling disabled (webhook ingestion only)');
      return;
    }
    const seconds = Math.max(Number(this.config.get<number>('logistics.traccar.pollSeconds')) || 30, 5);
    this.timer = setInterval(() => void this.pollOnce(), seconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Traccar polling enabled every ${seconds}s (${this.safeHost()})`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Host only — never the full URL (it could embed credentials). */
  private safeHost(): string {
    try { return new URL(this.baseUrl).host; } catch { return 'invalid-url'; }
  }

  private authHeader(): Record<string, string> {
    const user = this.config.get<string>('logistics.traccar.user') || '';
    const password = this.config.get<string>('logistics.traccar.password') || '';
    return user ? { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } : {};
  }

  private async getJson<T>(path: string): Promise<T> {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json', ...this.authHeader() }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`Traccar ${path} responded HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      const err = e as Error;
      // never include URL credentials / auth headers in the message
      throw new Error(err.name === 'AbortError' ? `Traccar ${path} timed out` : err.message?.startsWith('Traccar ') ? err.message : `Traccar ${path} request failed (${err.name || 'Error'})`);
    } finally {
      clearTimeout(to);
    }
  }

  private async devices(force = false): Promise<Map<string, TraccarDevice>> {
    if (!force && this.deviceCache && Date.now() - this.deviceCache.at < DEVICE_CACHE_MS) return this.deviceCache.byId;
    const list = await this.getJson<TraccarDevice[]>('/api/devices');
    const byId = new Map((Array.isArray(list) ? list : []).filter(d => d && d.id !== undefined).map(d => [String(d.id), d]));
    this.deviceCache = { at: Date.now(), byId };
    return byId;
  }

  /** One polling cycle (also callable from tests / admin tooling). */
  async pollOnce(): Promise<IngestResult[]> {
    if (!this.configured || this.running) return [];
    this.running = true;
    this.lastPollAt = new Date();
    try {
      const positions = await this.getJson<TraccarPosition[]>('/api/positions');
      const list = Array.isArray(positions) ? positions : [];
      let devices = await this.devices();
      if (list.some(p => p.deviceId !== undefined && !devices.has(String(p.deviceId)))) devices = await this.devices(true);
      const normalized = list.map(p => TraccarMapper.toNormalized(p, devices.get(String(p.deviceId)) ?? null));
      const results = await this.tracking.ingest(normalized, 'TRACCAR_POLL');
      this.lastSummary = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
      this.lastSuccessAt = new Date();
      this.lastError = null;
      return results;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.logger.warn(`Traccar poll failed: ${this.lastError}`);
      return [];
    } finally {
      this.running = false;
    }
  }

  status() {
    return {
      configured: this.configured,
      mode: this.configured ? 'POLL_AND_WEBHOOK' : 'WEBHOOK_ONLY',
      pollSeconds: this.configured ? Math.max(Number(this.config.get<number>('logistics.traccar.pollSeconds')) || 30, 5) : null,
      lastPollAt: this.lastPollAt ? this.lastPollAt.toISOString() : null,
      lastSuccessAt: this.lastSuccessAt ? this.lastSuccessAt.toISOString() : null,
      lastError: this.lastError,
      lastSummary: this.lastSummary,
      webhookConfigured: this.webhookConfigured
    };
  }
}
