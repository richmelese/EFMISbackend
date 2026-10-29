import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Region } from './entities/region.entity';
import { Zone } from './entities/zone.entity';
import { Woreda } from './entities/woreda.entity';
import { Kebele } from './entities/kebele.entity';
import { FertilizerType } from './entities/fertilizer-type.entity';
import { Errors } from '../../common/utils/errors';
import { UnitRef } from '../../common/utils/scope';
import { AdminUnitsService } from '../admin-units/admin-units.service';

export interface KebeleChain {
  kebele: Kebele;
  woreda: Woreda;
  zone: Zone;
  region: Region;
}

export type UnitLevel = 'REGION' | 'ZONE' | 'WOREDA' | 'KEBELE';

/**
 * Facade over the four legacy hierarchy tables (which still hold names, DA names, statuses and planning figures) and
 * `admin-units` (the unit tree used for scope). Existing callers keep working; new code uses AdminUnitsService.
 */
@Injectable()
export class HierarchyService {
  constructor(
    @InjectRepository(Region) readonly regions: Repository<Region>,
    @InjectRepository(Zone) readonly zones: Repository<Zone>,
    @InjectRepository(Woreda) readonly woredas: Repository<Woreda>,
    @InjectRepository(Kebele) readonly kebeles: Repository<Kebele>,
    @InjectRepository(FertilizerType) readonly fertilizerTypes: Repository<FertilizerType>,
    readonly adminUnits: AdminUnitsService
  ) {}

  async resolveKebele(kebeleId: string): Promise<KebeleChain> {
    const kebele = await this.kebeles.findOne({ where: { id: kebeleId }, relations: { woreda: { zone: { region: true } } } });
    if (!kebele) throw Errors.badRequest(`Unknown kebele ${kebeleId}`);
    const woreda = kebele.woreda;
    const zone = woreda.zone;
    return { kebele, woreda, zone, region: zone.region };
  }

  /** Parent chain (and admin_units path) for a unit of the given level; null when no such unit (used for scope checks). */
  async unitRef(level: UnitLevel, id: string): Promise<UnitRef | null> {
    const unit = await this.adminUnits.findById(id);
    return unit?.type === level ? this.adminUnits.unitRef(unit) : null;
  }

  regionToFrontend(r: Region, zones?: Zone[]) {
    const out: any = {
      id: r.id, name: r.name, code: r.code, sharePercent: r.sharePercent, grossDemandMT: r.grossDemandMt,
      quotaAllocationMT: r.quotaAllocationMt, registeredFarmers: r.registeredFarmers, approvalStatus: r.approvalStatus,
      soilDeficiency: r.soilDeficiency
    };
    if (zones) {
      out.zones = zones.map(z => ({
        id: z.id, name: z.name, status: z.status,
        woredas: [...(z.woredas || [])].sort((a, b) => a.sort - b.sort).map(w => ({
          id: w.id, name: w.name, status: w.status,
          kebeles: [...(w.kebeles || [])].sort((a, b) => a.sort - b.sort).map(k => ({
            id: k.id, name: k.name, da: k.daName, farmers: k.farmers, demandMT: k.demandMt, status: k.status
          }))
        }))
      }));
    }
    return out;
  }

  /** Nested regions -> zones -> woredas -> kebeles exactly like EFMIS_DATA.regions */
  async nestedRegions(regionId?: string | null) {
    const regions = await this.regions.find({ where: regionId ? { id: regionId } : {}, order: { sort: 'ASC' } });
    const zones = await this.zones.find({ relations: { woredas: { kebeles: true } }, order: { sort: 'ASC' } });
    return regions.map(r => this.regionToFrontend(r, zones.filter(z => z.regionId === r.id)));
  }
}
