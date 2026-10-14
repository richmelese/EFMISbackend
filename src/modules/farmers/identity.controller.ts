import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { AuditService } from '../audit/audit.service';
import { ExternalService, FAYDA_MESSAGES } from '../external/external.service';
import { FaydaVerifyDto, NrlaisVerifyDto } from './dto/identity.dto';
import { FarmersService } from './farmers.service';

/** Identity / land / soil verification adapters (REQ-1.1-003, REQ-1.1-001, REQ-1.3-002). */
@ApiTags('Identity verification (REQ-1.1-003)')
@ApiBearerAuth()
@Controller('integrations')
export class IdentityController {
  constructor(
    private readonly external: ExternalService,
    private readonly farmers: FarmersService,
    private readonly audit: AuditService
  ) {}

  @Post('fayda/verify')
  @HttpCode(200)
  @RequirePermissions('fayda:verify')
  @ApiOperation({ summary: 'Verify a Fayda digital ID (422 with the spec message when invalid; duplicate registration hint)' })
  async faydaVerify(@Body() dto: FaydaVerifyDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    const dup = await this.farmers.activeByFayda(dto.faydaId.toUpperCase());
    const result = await this.external.faydaVerify(dto.faydaId, { user, expected: { firstName: dto.firstName, gender: dto.gender } });
    await this.audit.record(user, 'FAYDA_VERIFICATION_ATTEMPT', dto.faydaId, { status: result.status }, ctx);
    if (result.status === 'INVALID') {
      res.status(422);
      return { ...result, error: { code: 'FAYDA_INVALID', message: result.message } };
    }
    return { ...result, duplicate: dup ? { message: FAYDA_MESSAGES.DUPLICATE, existingFarmer: dup } : null };
  }

  @Post('nrlais/verify')
  @HttpCode(200)
  @RequirePermissions('fayda:verify')
  @ApiOperation({ summary: 'Verify a land certificate against NRLAIS (with duplicate registration check)' })
  async nrlaisVerify(@Body() dto: NrlaisVerifyDto) {
    const result = await this.external.nrlaisVerify(dto.landCertNumber);
    const dup = await this.farmers.activeByLandCert(dto.landCertNumber);
    return { ...result, duplicate: dup || null };
  }

  @Get('nsis/:regionId')
  @RequirePermissions('region:analyze', 'farmers:read')
  @ApiOperation({ summary: 'NSIS soil profile of a region (cached)' })
  async nsis(@Param('regionId') regionId: string) {
    const p = await this.external.nsisProfile(regionId);
    if (!p) throw Errors.notFound('NSIS profile');
    return p;
  }
}
