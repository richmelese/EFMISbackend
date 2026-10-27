import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, MoreThan } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { nowStamp, sha256 } from '../../common/utils/helpers';
import { RequestContext } from '../../common/types/auth-user';

const GENESIS = 'sha256:' + '0'.repeat(64);
const CHAIN_LOCK = 4_242_001; // pg advisory lock key serialising chain appends

export interface Actor {
  id?: string | null;
  name?: string;
  role?: string;
}

export interface AuditQuery {
  user?: string;
  action?: string;
  target?: string;
  role?: string;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
}

/** Immutable, hash-chained audit trail (REQ-1.7-002). */
@Injectable()
export class AuditService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  private canonical(e: Partial<AuditLog>): string {
    return JSON.stringify([e.id, e.timestamp, e.userId, e.userName, e.role, e.action, e.target, e.details, e.source, e.ip, e.prevHash]);
  }

  /**
   * Append an entry. Pass `manager` when inside a transaction so the audit row commits atomically with the change.
   * details typically carries { old, new, reason, ... }.
   */
  async record(actor: Actor | null, action: string, target: string | null, details: unknown = null, ctx: RequestContext & { timestamp?: string } = {}, manager?: EntityManager): Promise<AuditLog> {
    const work = async (m: EntityManager) => {
      await m.query('SELECT pg_advisory_xact_lock($1)', [CHAIN_LOCK]);
      const last = await m.getRepository(AuditLog).find({ order: { seq: 'DESC' }, take: 1 });
      const nextSeq = (last[0]?.seq ?? 0) + 1;
      const entry: Partial<AuditLog> = {
        id: `AUD-${89000 + nextSeq}`,
        timestamp: ctx.timestamp || nowStamp(),
        userId: actor?.id || null,
        userName: actor?.name || 'system',
        role: actor?.role || 'SYSTEM',
        action,
        target: target ?? null,
        details: details === null || details === undefined ? null : JSON.stringify(details),
        source: ctx.source || 'API',
        ip: ctx.ip || null,
        sessionId: ctx.sessionId || null,
        prevHash: last[0]?.hash || GENESIS
      };
      entry.hash = 'sha256:' + sha256(this.canonical(entry));
      return m.getRepository(AuditLog).save(entry as AuditLog);
    };
    return manager ? work(manager) : this.ds.transaction(work);
  }

  toFrontend(r: AuditLog) {
    return {
      id: r.id, timestamp: r.timestamp, user: r.userName, role: r.role, action: r.action, target: r.target,
      hash: r.hash, ip: r.ip, source: r.source, details: r.details ? JSON.parse(r.details) : null
    };
  }

  async list(q: AuditQuery = {}) {
    const qb = this.ds.getRepository(AuditLog).createQueryBuilder('a');
    if (q.user) qb.andWhere('a.userName ILIKE :user', { user: `%${q.user}%` });
    if (q.action) qb.andWhere('a.action = :action', { action: q.action });
    if (q.target) qb.andWhere('a.target = :target', { target: q.target });
    if (q.role) qb.andWhere('a.role = :role', { role: q.role });
    if (q.from) qb.andWhere('a.timestamp >= :from', { from: q.from });
    if (q.to) qb.andWhere('a.timestamp <= :to', { to: q.to });
    if (q.q) qb.andWhere('(a.action ILIKE :q OR a.target ILIKE :q OR a.userName ILIKE :q)', { q: `%${q.q}%` });
    const rows = await qb.orderBy('a.seq', 'DESC').take(Math.min(Number(q.limit) || 500, 5000)).getMany();
    return rows.map(r => this.toFrontend(r));
  }

  /** Walk the chain in bounded batches (the log is append-only and unbounded, so never load it all at once); report the first broken link. */
  async verifyChain() {
    const BATCH = 5_000;
    const repo = this.ds.getRepository(AuditLog);
    const entries = await repo.count();
    let prev = GENESIS;
    let lastSeq = 0;
    for (;;) {
      const batch = await repo.find({ where: { seq: MoreThan(lastSeq) }, order: { seq: 'ASC' }, take: BATCH });
      if (!batch.length) break;
      for (const r of batch) {
        if (r.prevHash !== prev) return { valid: false, entries, brokenAt: r.id, reason: 'prev_hash mismatch' };
        if ('sha256:' + sha256(this.canonical(r)) !== r.hash) return { valid: false, entries, brokenAt: r.id, reason: 'hash mismatch (entry altered)' };
        prev = r.hash;
      }
      lastSeq = batch[batch.length - 1].seq;
      if (batch.length < BATCH) break;
    }
    return { valid: true, entries, headHash: prev };
  }
}
