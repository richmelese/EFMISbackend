import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ApprovalAction } from './entities/approval-action.entity';
import { AuthUser } from '../../common/types/auth-user';
import { stamp } from '../../common/utils/helpers';

export interface ApprovalInput {
  entityType: 'FARMER' | 'WOREDA' | 'ZONE' | 'REGION';
  entityId: string;
  level: string;
  action: string;
  comments?: string | null;
  details?: unknown;
  signatureId?: string | null;
}

/** Writes/reads the immutable approval action log. */
@Injectable()
export class ApprovalsService {
  constructor(@InjectRepository(ApprovalAction) private readonly repo: Repository<ApprovalAction>) {}

  async record(user: AuthUser, input: ApprovalInput, manager?: EntityManager): Promise<ApprovalAction> {
    const repo = manager ? manager.getRepository(ApprovalAction) : this.repo;
    return repo.save(repo.create({
      ...input, comments: input.comments ?? null, details: input.details ?? null, signatureId: input.signatureId ?? null,
      userId: user.id, userName: user.name
    }));
  }

  async history(entityType: string, entityId: string) {
    const rows = await this.repo.find({ where: { entityType, entityId }, order: { id: 'ASC' } });
    return rows.map(a => ({ level: a.level, action: a.action, comments: a.comments, details: a.details, by: a.userName, at: stamp(a.createdAt), signatureId: a.signatureId }));
  }

  get repository() {
    return this.repo;
  }
}
