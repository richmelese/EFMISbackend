import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, ILike, Repository } from 'typeorm';
import { Comment } from './entities/comment.entity';
import { User } from '../users/entities/user.entity';
import { AuthUser } from '../../common/types/auth-user';
import { stamp } from '../../common/utils/helpers';
import { NotificationsService } from '../notifications/notifications.service';

export const COMMENT_SCOPES = ['WOREDA', 'ZONE', 'REGION', 'KEBELE', 'FTWG', 'ALERT', 'QUOTA_REQUEST', 'DOCUMENT'] as const;

/** Collaboration threads with @mentions (mentioned users are notified). */
@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(Comment) private readonly repo: Repository<Comment>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly notifications: NotificationsService
  ) {}

  /** Frontend shape used by the WoredaZoneReview notes: { author, text, time } */
  toFrontend(c: Comment) {
    const created = stamp(c.createdAt)!;
    return { id: c.id, author: c.authorName, text: c.text, time: created.slice(11, 16), createdAt: created, parentId: c.parentId, mentions: c.mentions || [] };
  }

  async list(scopeType: string, scopeId: string) {
    const rows = await this.repo.find({ where: { scopeType, scopeId }, order: { id: 'ASC' } });
    return rows.map(r => this.toFrontend(r));
  }

  async add(user: AuthUser | { id: string | null; name: string }, scopeType: string, scopeId: string, text: string, parentId?: number | null, manager?: EntityManager) {
    const names = [...text.matchAll(/@([A-Za-z][\w.]*(?: [A-Z][\w.]*)?)/g)].map(m => m[1]);
    const mentioned: User[] = [];
    for (const n of names) {
      const u = await this.users.findOne({ where: { fullName: ILike(`${n}%`), active: true } });
      if (u && !mentioned.find(m => m.id === u.id)) mentioned.push(u);
    }
    const repo = manager ? manager.getRepository(Comment) : this.repo;
    const saved = await repo.save(repo.create({
      scopeType, scopeId, parentId: parentId ?? null, authorName: user.name, userId: user.id, text, mentions: mentioned.map(m => m.fullName)
    }));
    for (const m of mentioned) {
      await this.notifications.notify({ userId: m.id, title: `${user.name} mentioned you`, message: text.slice(0, 200), link: `/${scopeType.toLowerCase()}/${scopeId}` }, manager);
    }
    return this.toFrontend(saved);
  }
}
