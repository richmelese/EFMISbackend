import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { IsDefined, IsString, MinLength } from 'class-validator';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../common/decorators';
import { AuthUser, RequestContext } from '../../common/types/auth-user';
import { Errors } from '../../common/utils/errors';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from './settings.service';
import { SeasonsService } from '../seasons/seasons.service';

class UpdateSettingDto {
  @IsDefined() value: any;
  @IsString() @MinLength(5) justification: string;
}

/** Settings whose values are "configurable" per the spec. */
const EDITABLE = ['anomalyThresholdPct', 'kebeleEscalationDays', 'quotaRequestDeadline', 'systemMetadata'];

@ApiTags('Settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly seasons: SeasonsService,
    @InjectDataSource() private readonly ds: DataSource
  ) {}

  @Get()
  @RequirePermissions('settings:manage')
  @ApiOperation({ summary: 'All runtime settings' })
  all() {
    return this.settings.all();
  }

  @Put(':key')
  @RequirePermissions('settings:manage')
  @ApiOperation({ summary: 'Update a configurable threshold (audited, justification required)' })
  async update(@Param('key') key: string, @Body() dto: UpdateSettingDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    if (!EDITABLE.includes(key)) throw Errors.badRequest(`Editable settings: ${EDITABLE.join(', ')}`);
    const old = await this.settings.get(key);
    const value = key === 'systemMetadata' ? { ...(old || {}), ...dto.value } : dto.value;
    await this.ds.transaction(async m => {
      // The current season lives in `seasons`; systemMetadata.currentSeason is kept as its mirror.
      if (key === 'systemMetadata' && value.currentSeason && value.currentSeason !== old?.currentSeason) {
        await this.seasons.makeCurrent(value.currentSeason, m);
      }
      await this.settings.set(key, value, user.name, m);
      await this.audit.record(user, 'SYSTEM_CONFIGURATION_CHANGED', key, { old, new: value, reason: dto.justification }, ctx, m);
    });
    return { key, value };
  }
}
