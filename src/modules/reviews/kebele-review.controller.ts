import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { KebeleApproveDto, KebeleBulkDto, KebelePartialDto, KebeleRejectDto, KebeleRevisionDto } from './dto/kebele-review.dto';
import { KebeleReviewService } from './kebele-review.service';

@ApiTags('Kebele review (REQ-1.1-007)')
@ApiBearerAuth()
@Controller('kebele')
@RequirePermissions('kebele:review')
export class KebeleReviewController {
  constructor(private readonly review: KebeleReviewService) {}

  @Get('queue')
  @ApiOperation({ summary: 'Kebele dashboard: farmers in scope + pending/flagged/arrears statistics' })
  queue(@CurrentUser() user: AuthUser) {
    return this.review.queue(user);
  }

  @Post('farmers/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a farmer demand (e-signature; optional per-type approvedQtl)' })
  approve(@Param('id') id: string, @Body() dto: KebeleApproveDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.review.approve(user, id, dto, ctx);
  }

  @Post('farmers/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a farmer demand (reason required, e-signature)' })
  reject(@Param('id') id: string, @Body() dto: KebeleRejectDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.review.reject(user, id, dto, ctx);
  }

  @Post('farmers/:id/request-revision')
  @HttpCode(200)
  @ApiOperation({ summary: 'Return a farmer demand to the DA for revision (comments required, e-signature)' })
  requestRevision(@Param('id') id: string, @Body() dto: KebeleRevisionDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.review.requestRevision(user, id, dto, ctx);
  }

  @Post('farmers/:id/partial')
  @HttpCode(200)
  @ApiOperation({ summary: 'Partial approval: approve some fertilizer lines, request revision of others' })
  partial(@Param('id') id: string, @Body() dto: KebelePartialDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.review.partial(user, id, dto, ctx);
  }

  @Post('bulk')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bulk approve/reject/return (max 100, same kebele & season, one signature; skips warnings unless includeWarnings)' })
  bulk(@Body() dto: KebeleBulkDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.review.bulk(user, dto, ctx);
  }
}
