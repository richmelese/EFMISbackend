import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { AuthUser } from '../../common/types/auth-user';
import { stamp } from '../../common/utils/helpers';

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

/** Notification centre (in-app + outbox for EMAIL/SMS/PUSH delivery workers). */
@Injectable()
export class NotificationsService {
  constructor(@InjectRepository(Notification) private readonly repo: Repository<Notification>) {}

  async notify(n: NotifyInput, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(Notification) : this.repo;
    const channels = n.channels?.length ? n.channels : ['IN_APP'];
    await repo.insert(channels.map(channel => ({
      recipientUserId: n.userId ?? null, recipientRole: n.role ?? null, recipientUnitId: n.unitId ?? null,
      channel, title: n.title.slice(0, 240), message: n.message, link: n.link ?? null
    })));
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
