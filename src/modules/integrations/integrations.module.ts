import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EcxPrice, LogisticsBottleneck, QualityInspection, Tender, Vessel } from './entities/integration.entities';
import { PurchaseOrder } from '../quota/entities/quota.entities';
import { Farmer } from '../farmers/entities/farmer.entity';
import { Region } from '../admin-units/entities/region.entity';
import { Truck } from '../logistics/fleet/entities/fleet.entities';
import { InventoryBalance, Product, Warehouse } from '../logistics/warehouses/entities/warehouse.entities';
import { TrackingModule } from '../logistics/tracking/tracking.module';
import { WarehousesModule } from '../logistics/warehouses/warehouses.module';
import { LogisticsDashboardModule } from '../logistics/dashboard/dashboard.module';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';

/**
 * Integration framework (Section 3). IntegrationsService is exported for the bootstrap/dashboard payloads.
 * Logistics (REQ-INT-003) reads/writes the Logistics module: trucks & positions (TrackingService), warehouses & inventory ledger.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Tender, Vessel, QualityInspection, LogisticsBottleneck, EcxPrice, PurchaseOrder, Farmer, Region, Truck, Warehouse, Product, InventoryBalance]),
    TrackingModule,
    WarehousesModule,
    LogisticsDashboardModule
  ],
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
  exports: [IntegrationsService]
})
export class IntegrationsModule {}
