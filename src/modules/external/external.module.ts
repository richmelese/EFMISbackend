import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Farmer } from '../farmers/entities/farmer.entity';
import { FaydaVerification } from '../farmers/entities/fayda-verification.entity';
import { NsisSoilProfile } from '../admin-units/entities/nsis-soil-profile.entity';
import { ExternalService } from './external.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Farmer, FaydaVerification, NsisSoilProfile])],
  providers: [ExternalService],
  exports: [ExternalService]
})
export class ExternalModule {}
