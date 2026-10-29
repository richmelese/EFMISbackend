import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DemandAdjustment } from './entities/demand-adjustment.entity';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { KebeleReviewController } from './kebele-review.controller';
import { KebeleReviewService } from './kebele-review.service';
import { FarmersModule } from '../farmers/farmers.module';

/**
 * Demand review at every level below the region:
 *  - kebele: farmer-level approve / reject / revision / partial / bulk (REQ-1.1-007), routes /api/kebele/*
 *  - woreda & zone: adjustments, comment threads, decisions, scenario modelling (REQ-1.2-002/003/004), /api/reviews/*
 */
@Module({
  imports: [TypeOrmModule.forFeature([DemandAdjustment]), FarmersModule],
  controllers: [ReviewsController, KebeleReviewController],
  providers: [ReviewsService, KebeleReviewService],
  exports: [ReviewsService, KebeleReviewService]
})
export class ReviewsModule {}
