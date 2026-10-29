import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowAction } from './entities/workflow-action.entity';
import { WorkflowCase } from './entities/workflow-case.entity';
import { WorkflowController } from './workflow.controller';
import { WorkflowRegistry } from './workflow.registry';
import { WorkflowService } from './workflow.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([WorkflowCase, WorkflowAction])],
  controllers: [WorkflowController],
  providers: [WorkflowRegistry, WorkflowService],
  exports: [WorkflowRegistry, WorkflowService]
})
export class WorkflowModule {}
