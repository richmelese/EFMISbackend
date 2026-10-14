import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UssdSession } from './entities/ussd-session.entity';
import { QuotaAllocation } from '../quota/entities/quota.entities';
import { Vessel } from '../integrations/entities/integration.entities';
import { InventoryBalance, Warehouse } from '../logistics/warehouses/entities/warehouse.entities';
import { UssdService } from './ussd.service';
import { UssdController } from './ussd.controller';

/** *804# USSD gateway for feature phones (REQ-1.4-008). */
@Module({
  imports: [TypeOrmModule.forFeature([UssdSession, QuotaAllocation, Vessel, Warehouse, InventoryBalance])],
  controllers: [UssdController],
  providers: [UssdService]
})
export class UssdModule {}
