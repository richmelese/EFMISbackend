import { Module } from '@nestjs/common';
import { FarmersModule } from '../farmers/farmers.module';
import { KebeleReviewController } from './kebele-review.controller';
import { KebeleReviewService } from './kebele-review.service';

@Module({
  imports: [FarmersModule],
  controllers: [KebeleReviewController],
  providers: [KebeleReviewService],
  exports: [KebeleReviewService]
})
export class KebeleReviewModule {}
