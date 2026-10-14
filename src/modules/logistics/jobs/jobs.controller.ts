import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../../common/decorators';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { AuditService } from '../../audit/audit.service';
import { HotStateService } from './hot-state.service';
import { JobsService } from './jobs.service';

@ApiTags('Logistics · Jobs & queues')
@ApiBearerAuth()
@Controller({ path: 'jobs', version: '1' })
@RequirePermissions('jobs:manage')
export class JobsController {
  constructor(private readonly jobs: JobsService, private readonly hot: HotStateService, private readonly audit: AuditService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Queue mode (bullmq | inline), job counts per queue, dead-letter count, cache backend' })
  async stats() {
    return { ...(await this.jobs.stats()), cache: this.hot.backend };
  }

  @Get('failures')
  @ApiOperation({ summary: 'Dead-letter queue (jobs that exhausted their retries)' })
  failures(@Query('status') status?: string) {
    return this.jobs.listFailures(status || 'DEAD');
  }

  @Post('failures/:id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-enqueue a dead-lettered job' })
  async retry(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const r = await this.jobs.retryFailure(id);
    await this.audit.record(user, 'JOB_DEAD_LETTER_RETRIED', id, null, ctx);
    return r;
  }
}
