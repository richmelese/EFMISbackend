import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Alert } from '../../alerts/entities/alert.entity';
import { Notification } from '../../notifications/entities/notification.entity';
import { Driver, DriverDocument } from '../drivers/entities/driver.entities';
import { GpsDevice, Truck, TruckLocation } from '../fleet/entities/fleet.entities';
import { Delivery, Shipment, Trip, TripShipment } from '../shipments/entities/shipment.entities';
import { InventoryBalance, InventoryTransaction, Product, Warehouse } from '../warehouses/entities/warehouse.entities';
import { LogisticsDashboardController } from './logistics-dashboard.controller';
import { LogisticsDashboardService } from './logistics-dashboard.service';
import { LogisticsViewService } from './logistics-view.service';
import {
  EMAIL_PROVIDER, LoggingProvider, NotificationDeliveryService, PUSH_PROVIDER, SMS_PROVIDER
} from './notification-delivery.service';

/**
 * Operations Control Tower summary, logistics reports, the EFMIS read models (gpsFleet / warehouseUtilization)
 * and the outbound notification delivery worker (EMAIL / SMS / PUSH).
 * Swap a LoggingProvider for a real gateway adapter by overriding EMAIL_PROVIDER / SMS_PROVIDER / PUSH_PROVIDER.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Truck, GpsDevice, TruckLocation, Trip, TripShipment, Shipment, Delivery, Driver, DriverDocument,
      Warehouse, Product, InventoryBalance, InventoryTransaction, Alert, Notification
    ])
  ],
  controllers: [LogisticsDashboardController],
  providers: [
    LogisticsViewService,
    LogisticsDashboardService,
    NotificationDeliveryService,
    { provide: EMAIL_PROVIDER, useFactory: () => new LoggingProvider('EMAIL') },
    { provide: SMS_PROVIDER, useFactory: () => new LoggingProvider('SMS') },
    { provide: PUSH_PROVIDER, useFactory: () => new LoggingProvider('PUSH') }
  ],
  exports: [LogisticsViewService, NotificationDeliveryService]
})
export class LogisticsDashboardModule {}
