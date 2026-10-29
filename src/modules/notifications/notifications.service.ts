import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { AuthUser } from '../../common/types/auth-user';
import { stamp } from '../../common/utils/helpers';
import { OutboxService } from '../outbox/outbox.service';
import { OutboxChannel } from '../outbox/outbox.types';
import { UsersService } from '../users/users.service';

export interface NotifyInput {
  userId?: string | null;
  role?: string | null;
  /** Restrict a role notification to one administrative unit id */
  unitId?: string | null;
  title: string;
  message: string;
  link?: string | null;
  channels?: Array<'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH'>;
}

/** Recipient address used by each outgoing channel. */
const ADDRESS: Record<Exclude<NonNullable<NotifyInput['channels']>[number], 'IN_APP'>, 'email' | 'phone' | 'id'> = { EMAIL: 'email', SMS: 'phone', PUSH: 'id' };

/**
 * Notification centre. Every notification keeps its notification rows (one per channel, as before; the in-app centre
 * reads the IN_APP row). EMAIL / SMS / PUSH are delivered through the outbox, enqueued in the caller's transaction.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification) private readonly repo: Repository<Notification>,
    private readonly outbox: OutboxService,
    private readonly users: UsersService
  ) {}

  async notify(n: NotifyInput, manager?: EntityManager): Promise<void> {
    if (!manager) return this.repo.manager.transaction(m => this.notify(n, m));
    const channels = n.channels?.length ? n.channels : ['IN_APP' as const];
    await manager.getRepository(Notification).insert(channels.map(channel => ({
      recipientUserId: n.userId ?? null, recipientRole: n.role ?? null, recipientUnitId: n.unitId ?? null,
      channel, title: n.title.slice(0, 240), message: n.message, link: n.link ?? null
    })));
    const outgoing = channels.filter((c): c is keyof typeof ADDRESS => c !== 'IN_APP');
    if (!outgoing.length) return;
    const contacts = await this.users.contactsFor({ userId: n.userId, role: n.role, unitId: n.unitId }, manager);
    for (const channel of outgoing) {
      const to = [...new Set(contacts.map(c => c[ADDRESS[channel]]).filter((v): v is string => !!v))];
      if (!to.length) continue;
      await this.outbox.enqueue({
        channel: channel as OutboxChannel,
        payload: { kind: 'NOTIFICATION', to, title: n.title, message: n.message, link: n.link ?? null, recipient: { userId: n.userId ?? null, role: n.role ?? null, unitId: n.unitId ?? null } }
      }, manager);
    }
  }

  /** In-app notifications visible to a user: addressed to them, or to their role (optionally limited to their unit). */
  async forUser(user: AuthUser, opts: { unreadOnly?: boolean; limit?: number } = {}) {
    const units = [user.regionId, user.zoneId, user.woredaId, user.kebeleId].filter(Boolean) as string[];
    const qb = this.repo.createQueryBuilder('n')
      .where(`n.channel = 'IN_APP'`)
      .andWhere(new Brackets(b => {
        b.where('n.recipientUserId = :uid', { uid: user.id }).orWhere(new Brackets(r => {
          r.where('n.recipientRole = :role', { role: user.role }).andWhere(
            units.length ? '(n.recipientUnitId IS NULL OR n.recipientUnitId IN (:...units))' : 'n.recipientUnitId IS NULL', { units });
        }));
      }));
    if (opts.unreadOnly) qb.andWhere('n.read = false');
    const rows = await qb.orderBy('n.id', 'DESC').take(opts.limit || 100).getMany();
    return rows.map(r => ({ id: r.id, title: r.title, message: r.message, link: r.link, read: r.read, createdAt: stamp(r.createdAt) }));
  }

  async markRead(user: AuthUser, id: number) {
    await this.repo.createQueryBuilder().update().set({ read: true })
      .where('id = :id AND (recipient_user_id = :uid OR recipient_role = :role)', { id, uid: user.id, role: user.role }).execute();
  }

  async markAllRead(user: AuthUser) {
    await this.repo.createQueryBuilder().update().set({ read: true })
      .where('recipient_user_id = :uid OR recipient_role = :role', { uid: user.id, role: user.role }).execute();
  }
}
