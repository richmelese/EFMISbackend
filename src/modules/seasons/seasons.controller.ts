import { Controller, Get, Param, Version } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Errors } from '../../common/utils/errors';
import { SeasonDto } from './dto/season.dto';
import { SeasonsService } from './seasons.service';

/** Read-only for every signed-in user (season switcher, defaults for new records). Editing seasons is Phase 1. */
@ApiTags('Seasons')
@ApiBearerAuth()
@Controller('seasons')
export class SeasonsController {
  constructor(private readonly seasons: SeasonsService) {}

  @Version('1')
  @Get()
  @ApiOperation({ summary: 'All seasons, newest first' })
  @ApiOkResponse({ type: SeasonDto, isArray: true })
  async list(): Promise<SeasonDto[]> {
    return (await this.seasons.list()).map(s => this.seasons.toDto(s));
  }

  @Version('1')
  @Get('current')
  @ApiOperation({ summary: 'The current season (default for new records)' })
  @ApiOkResponse({ type: SeasonDto })
  async current(): Promise<SeasonDto> {
    const s = await this.seasons.current();
    if (!s) throw Errors.notFound('No current season is configured');
    return this.seasons.toDto(s);
  }

  @Version('1')
  @Get(':id')
  @ApiOperation({ summary: 'One season' })
  @ApiOkResponse({ type: SeasonDto })
  async byId(@Param('id') id: string): Promise<SeasonDto> {
    return this.seasons.toDto(await this.seasons.byId(id));
  }
}
