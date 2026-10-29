import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Alert } from '../../alerts/entities/alert.entity';
import { Driver, DriverDocument } from '../drivers/entities/driver.entities';
import { GpsDevice, Truck, TruckLocation } from '../fleet/entities/fleet.entities';
import { Delivery, Shipment, Trip, TripShipment } from '../shipments/entities/shipment.entities';
import { InventoryBalance, InventoryTransaction, Product, Warehouse } from '../warehouses/entities/warehouse.entities';
import { LogisticsDashboardController } from './logistics-dashboard.controller';
import { LogisticsDashboardService } from './logistics-dashboard.service';
import { LogisticsViewService } from './logistics-view.service';

/**
 * Operations Control Tower summary, logistics reports and the EFMIS read models (gpsFleet / warehouseUtilization).
 * Outbound EMAIL / SMS / PUSH for logistics notifications is delivered by the platform outbox (NotificationsService
 * enqueues it); gateway adapters are registered with OutboxService.registerAdapter().
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Truck, GpsDevice, TruckLocation, Trip, TripShipment, Shipment, Delivery, Driver, DriverDocument,
      Warehouse, Product, InventoryBalance, InventoryTransaction, Alert
    ])
  ],
  controllers: [LogisticsDashboardController],
  providers: [
    LogisticsViewService,
    LogisticsDashboardService
  ],
  exports: [LogisticsViewService]
})
export class LogisticsDashboardModule {}
