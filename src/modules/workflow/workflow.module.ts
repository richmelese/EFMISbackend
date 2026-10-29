import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowAction } from './entities/workflow-action.entity';
import { ApprovalAction } from './entities/approval-action.entity';
import { ApprovalsService } from './approvals.service';
import { WorkflowCase } from './entities/workflow-case.entity';
import { WorkflowController } from './workflow.controller';
import { WorkflowRegistry } from './workflow.registry';
import { WorkflowService } from './workflow.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([WorkflowCase, WorkflowAction, ApprovalAction])],
  controllers: [WorkflowController],
  providers: [WorkflowRegistry, WorkflowService, ApprovalsService],
  exports: [WorkflowRegistry, WorkflowService, ApprovalsService]
})
export class WorkflowModule {}
