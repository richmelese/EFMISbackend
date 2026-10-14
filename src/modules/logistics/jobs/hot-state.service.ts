import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

/**
 * Hot current-state cache (latest truck positions, ETA throttling markers, live counters).
 * Redis when REDIS_URL is configured, in-process Map otherwise. PostgreSQL remains the source of truth —
 * everything here can be rebuilt from the database (Logistics doc §2: "Redis is not the sole source of truth").
 */
@Injectable()
export class HotStateService implements OnModuleDestroy {
  private readonly logger = new Logger('HotState');
  private readonly redis: IORedis | null;
  private readonly memory = new Map<string, { value: string; expiresAt: number | null }>();

  constructor(config: ConfigService) {
    const url = config.get<string>('redisUrl');
    this.redis = url ? new IORedis(url, { lazyConnect: false, maxRetriesPerRequest: 2 }) : null;
    this.redis?.on('error', err => this.logger.warn(`Redis unavailable: ${err.message}`));
  }

  async onModuleDestroy() {
    this.redis?.disconnect();
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (this.redis) {
      try {
        if (ttlSeconds) await this.redis.set(key, raw, 'EX', ttlSeconds);
        else await this.redis.set(key, raw);
        return;
      } catch { /* fall through to memory */ }
    }
    this.memory.set(key, { value: raw, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (this.redis) {
      try {
        const v = await this.redis.get(key);
        return v ? (JSON.parse(v) as T) : null;
      } catch { /* fall through */ }
    }
    const m = this.memory.get(key);
    if (!m) return null;
    if (m.expiresAt && m.expiresAt < Date.now()) { this.memory.delete(key); return null; }
    return JSON.parse(m.value) as T;
  }

  async del(key: string): Promise<void> {
    if (this.redis) { try { await this.redis.del(key); } catch { /* ignore */ } }
    this.memory.delete(key);
  }

  /** Set-if-absent with TTL (throttles / de-duplication). Returns true when the key was set. */
  async setOnce(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.redis) {
      try { return (await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK'; } catch { /* fall through */ }
    }
    const existing = this.memory.get(key);
    if (existing && (!existing.expiresAt || existing.expiresAt > Date.now())) return false;
    this.memory.set(key, { value: '1', expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  get backend(): 'redis' | 'memory' {
    return this.redis ? 'redis' : 'memory';
  }
}
