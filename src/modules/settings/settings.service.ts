import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Setting } from './entities/setting.entity';
import { SeasonsService } from '../seasons/seasons.service';

/**
 * Typed access to runtime settings. Known keys:
 *  systemMetadata, quotaWeights, financialSummary, qualitySummary, logisticsSummary,
 *  anomalyThresholdPct, kebeleEscalationDays, quotaRequestDeadline, schedulerLastRun
 */
@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(Setting) private readonly repo: Repository<Setting>,
    private readonly seasons: SeasonsService
  ) {}

  async get<T = any>(key: string, fallback: T = null as T, manager?: EntityManager): Promise<T> {
    const row = await (manager ? manager.getRepository(Setting) : this.repo).findOne({ where: { key } });
    return row ? (row.value as T) : fallback;
  }

  async set(key: string, value: unknown, updatedBy = 'system', manager?: EntityManager): Promise<void> {
    await (manager ? manager.getRepository(Setting) : this.repo).save({ key, value, updatedBy });
  }

  async all(): Promise<Record<string, unknown>> {
    const rows = await this.repo.find();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }

  /** Current season name (e.g. "Meher 2026"). Thin wrapper over SeasonsService.current(). */
  async currentSeason(): Promise<string> {
    return (await this.seasons.current())?.name || (await this.get<any>('systemMetadata', {}))?.currentSeason || 'Meher 2026';
  }
}
