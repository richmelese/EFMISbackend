import { Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { AuditService } from '../audit/audit.service';
import { SchedulerService } from './scheduler.service';

@ApiTags('Scheduler')
@ApiBearerAuth()
@Controller('scheduler')
export class SchedulerController {
  constructor(private readonly scheduler: SchedulerService, private readonly audit: AuditService) {}

  @Post('run')
  @HttpCode(200)
  @RequirePermissions('settings:manage')
  @ApiOperation({ summary: 'Run the reminders / escalation / SLA job once and return its summary' })
  async run(@CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const summary = await this.scheduler.runOnce();
    await this.audit.record(user, 'SCHEDULER_RUN_MANUAL', 'SCHEDULER', summary, ctx);
    return summary;
  }
}
