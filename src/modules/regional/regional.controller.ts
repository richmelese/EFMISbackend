import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { NSIS_LAYERS } from '../external/external.service';
import { SubmitRegionDto } from './dto/regional.dto';
import { RegionalService } from './regional.service';

@ApiTags('Regions — Analysis & MoA Submission (REQ-1.2-005/007, REQ-1.3-002)')
@ApiBearerAuth()
@Controller('regions')
export class RegionalController {
  constructor(private readonly regional: RegionalService) {}

  @Get()
  // also for user administration (scope pickers)
  @RequirePermissions('aggregation:read', 'users:manage')
  @ApiOperation({ summary: 'Nested regions -> zones -> woredas -> kebeles (non-national users see their own region)' })
  list(@CurrentUser() user: AuthUser) {
    return this.regional.list(user);
  }

  @Get(':id')
  @RequirePermissions('aggregation:read')
  @ApiOperation({ summary: 'One region with its nested hierarchy' })
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.regional.get(id, user);
  }

  @Get(':id/soil')
  @RequirePermissions('region:analyze')
  @ApiQuery({ name: 'layer', required: false, enum: Object.keys(NSIS_LAYERS) })
  @ApiOperation({ summary: 'NSIS soil layer, HaFAS recommendation and demand-vs-soil scientific validation' })
  soil(@Param('id') id: string, @Query('layer') layer: string | undefined, @CurrentUser() user: AuthUser) {
    return this.regional.soil(id, layer, user);
  }

  @Get(':id/analysis')
  @RequirePermissions('region:analyze')
  @ApiOperation({ summary: 'Historical trends, zone hotspots and risk assessment' })
  analysis(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.regional.analysis(id, user);
  }

  @Get(':id/pre-submission-check')
  @RequirePermissions('region:submit', 'national:read')
  @ApiOperation({ summary: 'Data-quality checks run before submission to MoA' })
  preSubmissionCheck(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.regional.preSubmissionCheck(id, user);
  }

  @Post(':id/submit')
  @RequirePermissions('region:submit')
  @ApiOperation({ summary: 'Sign & submit the regional demand package to MoA (versioned, receipt issued)' })
  submit(@Param('id') id: string, @Body() dto: SubmitRegionDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.regional.submit(id, dto, user, ctx);
  }

  @Get(':id/submissions')
  @RequirePermissions('region:submit', 'national:read')
  @ApiQuery({ name: 'full', required: false, enum: ['true', 'false'] })
  @ApiOperation({ summary: 'Submission versions (full=true includes the payload)' })
  submissions(@Param('id') id: string, @Query('full') full: string | undefined, @CurrentUser() user: AuthUser) {
    return this.regional.listSubmissions(id, String(full) === 'true', user);
  }

  @Get(':id/submissions/compare')
  @RequirePermissions('region:submit', 'national:read')
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  @ApiOperation({ summary: 'Compare two submission versions' })
  compare(@Param('id') id: string, @Query('from') from: string, @Query('to') to: string, @CurrentUser() user: AuthUser) {
    return this.regional.compareSubmissions(id, Number(from), Number(to), user);
  }

  @Post(':id/submissions/:sid/acknowledge')
  @HttpCode(200)
  @RequirePermissions('national:edit')
  @ApiOperation({ summary: 'MoA acknowledges receipt of a regional submission' })
  acknowledge(@Param('id') id: string, @Param('sid') sid: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.regional.acknowledge(id, sid, user, ctx);
  }
}
