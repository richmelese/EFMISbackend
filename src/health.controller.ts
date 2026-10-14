import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from './common/decorators';
import { SettingsService } from './modules/settings/settings.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly settings: SettingsService, private readonly config: ConfigService) {}

  @Public()
  @Get()
  async health() {
    let db = 'UP';
    try { await this.ds.query('SELECT 1'); } catch { db = 'DOWN'; }
    return {
      status: db === 'UP' ? 'UP' : 'DEGRADED',
      service: 'efmis-backend',
      version: (await this.settings.get<any>('systemMetadata', {}))?.version,
      database: db,
      time: new Date().toISOString(),
      demoMode: this.config.get('demoMode'),
      scheduler: await this.settings.get('schedulerLastRun', null)
    };
  }
}
