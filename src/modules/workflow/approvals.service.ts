import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ApprovalAction } from './entities/approval-action.entity';
import { AuthUser } from '../../common/types/auth-user';

export interface ApprovalInput {
  entityType: 'FARMER' | 'WOREDA' | 'ZONE' | 'REGION';
  entityId: string;
  level: string;
  action: string;
  comments?: string | null;
  details?: unknown;
  signatureId?: string | null;
}

/**
 * Legacy approval log (approval_actions, write-once). The screens that predate the workflow engine still record their
 * decisions here; history is read through WorkflowService.history(), which merges it with workflow_actions.
 * New approval flows use a WorkflowDefinition instead (roadmap Phase 4+ move these screens onto it).
 */
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

  get repository() {
    return this.repo;
  }
}
