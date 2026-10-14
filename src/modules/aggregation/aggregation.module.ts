import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Region } from '../hierarchy/entities/region.entity';
import { Zone } from '../hierarchy/entities/zone.entity';
import { Woreda } from '../hierarchy/entities/woreda.entity';
import { Kebele } from '../hierarchy/entities/kebele.entity';
import { Farmer } from '../farmers/entities/farmer.entity';
import { FarmerDemand } from '../farmers/entities/farmer-demand.entity';
import { CarryOverFacility, CarryOverStock } from '../national/entities/carry-over.entities';
import { AggregationController } from './aggregation.controller';
import { AggregationService } from './aggregation.service';
import { NationalFiguresService } from './national-figures.service';

/**
 * Global: AggregationService and NationalFiguresService are used by reviews, regional, national, quota and dashboards.
 * (AggregationController — /api/aggregation/* — is registered here as well.)
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Region, Zone, Woreda, Kebele, Farmer, FarmerDemand, CarryOverFacility, CarryOverStock])],
  controllers: [AggregationController],
  providers: [AggregationService, NationalFiguresService],
  exports: [AggregationService, NationalFiguresService]
})
export class AggregationModule {}
