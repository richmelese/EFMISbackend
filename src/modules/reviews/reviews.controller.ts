import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AddedCommentDto, CommentDto } from '../comments/dto/comment.dto';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { AdjustmentQueryDto, CommentQueryDto, CreateAdjustmentDto, CreateCommentDto, DecisionDto, ScenarioDto } from './dto/reviews.dto';
import { ReviewsService } from './reviews.service';

@ApiTags('Woreda & Zone Review (REQ-1.2-002/003/004)')
@ApiBearerAuth()
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  // NOTE: static routes are declared before the parameterised ':level/:unitId' routes.

  @Get('adjustments')
  @RequirePermissions('aggregation:read')
  @ApiOperation({ summary: 'List demand adjustments (filter by level, unitId)' })
  listAdjustments(@Query() q: AdjustmentQueryDto, @CurrentUser() user: AuthUser) {
    return this.reviews.listAdjustments(q, user);
  }

  @Post('adjustments')
  @RequirePermissions('woreda:review', 'zone:review')
  @ApiOperation({ summary: 'Adjust kebele (woreda officer) or woreda (zone officer) demand — justification mandatory, versioned' })
  createAdjustment(@Body() dto: CreateAdjustmentDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.reviews.createAdjustment(dto, user, ctx);
  }

  @Get('comments')
  @RequirePermissions('aggregation:read', 'alerts:read')
  @ApiOperation({ summary: 'Comment thread for a scope (scopeType, scopeId)' })
  @ApiOkResponse({ type: CommentDto, isArray: true })
  listComments(@Query() q: CommentQueryDto, @CurrentUser() user: AuthUser) {
    return this.reviews.listComments(q.scopeType, q.scopeId, user);
  }

  @Post('comments')
  @RequirePermissions('review:comment', 'ftwg:participate', 'alerts:manage')
  @ApiOperation({ summary: 'Add a comment (@mentions notify users)' })
  @ApiCreatedResponse({ type: AddedCommentDto })
  addComment(@Body() dto: CreateCommentDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.reviews.addComment(dto, user, ctx);
  }

  @Post('scenario')
  @HttpCode(200)
  @RequirePermissions('aggregation:read')
  @ApiOperation({ summary: 'Scenario modelling: what-if demand changes for child units' })
  scenario(@Body() dto: ScenarioDto, @CurrentUser() user: AuthUser) {
    return this.reviews.scenario(dto, user);
  }

  @Get(':level/:unitId')
  @RequirePermissions('aggregation:read')
  @ApiParam({ name: 'level', enum: ['woreda', 'zone'] })
  @ApiOperation({ summary: 'Review dashboard for a woreda or zone (children, adjustments, comments, decisions, stats)' })
  dashboard(@Param('level') level: string, @Param('unitId') unitId: string, @CurrentUser() user: AuthUser) {
    return this.reviews.dashboard(level, unitId, user);
  }

  @Post(':level/:unitId/decision')
  @HttpCode(200)
  @ApiParam({ name: 'level', enum: ['woreda', 'zone'] })
  @ApiOperation({ summary: 'Approve & forward / return / partial approve / hold / dispute (e-signature required)' })
  decide(@Param('level') level: string, @Param('unitId') unitId: string, @Body() dto: DecisionDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.reviews.decide(level, unitId, dto, user, ctx);
  }
}
