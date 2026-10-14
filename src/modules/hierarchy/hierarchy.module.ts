import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Region } from './entities/region.entity';
import { Zone } from './entities/zone.entity';
import { Woreda } from './entities/woreda.entity';
import { Kebele } from './entities/kebele.entity';
import { FertilizerType } from './entities/fertilizer-type.entity';
import { NsisSoilProfile } from './entities/nsis-soil-profile.entity';
import { HierarchyService } from './hierarchy.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Region, Zone, Woreda, Kebele, FertilizerType, NsisSoilProfile])],
  providers: [HierarchyService],
  exports: [HierarchyService, TypeOrmModule]
})
export class HierarchyModule {}
