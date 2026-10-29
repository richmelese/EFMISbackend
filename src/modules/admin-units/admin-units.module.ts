import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminUnit } from './entities/admin-unit.entity';
import { Region } from './entities/region.entity';
import { Zone } from './entities/zone.entity';
import { Woreda } from './entities/woreda.entity';
import { Kebele } from './entities/kebele.entity';
import { FertilizerType } from './entities/fertilizer-type.entity';
import { NsisSoilProfile } from './entities/nsis-soil-profile.entity';
import { AdminUnitsController } from './admin-units.controller';
import { AdminUnitsService } from './admin-units.service';
import { HierarchyService } from './hierarchy.service';

/**
 * The administrative unit tree (`admin_units`) plus reference data (`fertilizer_types`, `nsis_soil_profiles`).
 * The legacy region/zone/woreda/kebele tables (names, DA names, statuses, planning figures) are read through the
 * HierarchyService facade until their roadmap phase retires them (Phase 8 drops them).
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AdminUnit, Region, Zone, Woreda, Kebele, FertilizerType, NsisSoilProfile])],
  controllers: [AdminUnitsController],
  providers: [AdminUnitsService, HierarchyService],
  exports: [AdminUnitsService, HierarchyService, TypeOrmModule]
})
export class AdminUnitsModule {}
