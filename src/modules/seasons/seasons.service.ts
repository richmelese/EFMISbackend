import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Errors } from '../../common/utils/errors';
import { Season } from './entities/season.entity';
import { SeasonDto } from './dto/season.dto';
import { seasonFromName } from './season-calendar';

/** Agricultural seasons. Owner of the `seasons` table. */
@Injectable()
export class SeasonsService {
  constructor(@InjectRepository(Season) private readonly repo: Repository<Season>) {}

  private r(m?: EntityManager) {
    return m ? m.getRepository(Season) : this.repo;
  }

  /** The season new records default to; null only before any season exists. */
  current(m?: EntityManager): Promise<Season | null> {
    return this.r(m).findOne({ where: { isCurrent: true } });
  }

  async byId(id: string, m?: EntityManager): Promise<Season> {
    const s = await this.r(m).findOne({ where: { id } });
    if (!s) throw Errors.notFound(`Season ${id} not found`);
    return s;
  }

  byName(name: string, m?: EntityManager): Promise<Season | null> {
    return this.r(m).findOne({ where: { name } });
  }

  list(m?: EntityManager): Promise<Season[]> {
    return this.r(m).find({ order: { startsOn: 'DESC' } });
  }

  /**
   * Make the named season current (settings.systemMetadata.currentSeason is edited by administrators). A season not
   * yet known is created from its name with the default calendar. A PLANNING season opens when it becomes current.
   */
  async makeCurrent(name: string, m: EntityManager): Promise<Season> {
    const repo = m.getRepository(Season);
    let s = await repo.findOne({ where: { name } });
    if (!s) {
      const seed = seasonFromName(name);
      if (!seed) throw Errors.badRequest(`Unknown season "${name}" — expected e.g. "Meher 2026", "Belg 2026", "Irrigation 2026-27"`);
      s = (await repo.findOne({ where: { id: seed.id } })) ?? repo.create({ ...seed, status: 'PLANNING', isCurrent: false });
    }
    if (s.isCurrent) return s;
    await repo.update({ isCurrent: true }, { isCurrent: false });
    s.isCurrent = true;
    if (s.status === 'PLANNING') s.status = 'OPEN';
    return repo.save(s);
  }

  toDto(s: Season): SeasonDto {
    return {
      id: s.id, name: s.name, type: s.type, year: s.year, startsOn: s.startsOn, endsOn: s.endsOn,
      collectionDeadline: s.collectionDeadline, status: s.status, isCurrent: s.isCurrent
    };
  }
}
