import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DemandAdjustment } from './entities/demand-adjustment.entity';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

/** Woreda & Zone review: adjustments, comment threads, decisions, scenario modelling (REQ-1.2-002/003/004). */
@Module({
  imports: [TypeOrmModule.forFeature([DemandAdjustment])],
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService]
})
export class ReviewsModule {}
