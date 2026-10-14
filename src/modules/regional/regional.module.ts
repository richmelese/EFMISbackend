import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RegionalSubmission } from './entities/regional-submission.entity';
import { Farmer } from '../farmers/entities/farmer.entity';
import { RegionalController } from './regional.controller';
import { RegionalService } from './regional.service';

/** Region analysis (NSIS / HaFAS), final regional approval and versioned submission to MoA (REQ-1.2-005/007). */
@Module({
  imports: [TypeOrmModule.forFeature([RegionalSubmission, Farmer])],
  controllers: [RegionalController],
  providers: [RegionalService],
  exports: [RegionalService]
})
export class RegionalModule {}
