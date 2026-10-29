import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminUnit } from './entities/admin-unit.entity';
import { AdminUnitsController } from './admin-units.controller';
import { AdminUnitsService } from './admin-units.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AdminUnit])],
  controllers: [AdminUnitsController],
  providers: [AdminUnitsService],
  exports: [AdminUnitsService]
})
export class AdminUnitsModule {}
