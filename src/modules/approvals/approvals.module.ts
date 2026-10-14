import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApprovalAction } from './entities/approval-action.entity';
import { ApprovalsService } from './approvals.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApprovalAction])],
  providers: [ApprovalsService],
  exports: [ApprovalsService]
})
export class ApprovalsModule {}
