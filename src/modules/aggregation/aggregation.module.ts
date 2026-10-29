import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Region } from '../admin-units/entities/region.entity';
import { Zone } from '../admin-units/entities/zone.entity';
import { Woreda } from '../admin-units/entities/woreda.entity';
import { Kebele } from '../admin-units/entities/kebele.entity';
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
