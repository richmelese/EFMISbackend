import { Module } from '@nestjs/common';
import { JobsModule } from './jobs/jobs.module';
import { RealtimeModule } from './realtime/realtime.module';
import { DriversModule } from './drivers/drivers.module';
import { FleetModule } from './fleet/fleet.module';
import { TrackingModule } from './tracking/tracking.module';
import { RoutingModule } from './routing/routing.module';
import { ShipmentsModule } from './shipments/shipments.module';
import { WarehousesModule } from './warehouses/warehouses.module';
import { LogisticsDashboardModule } from './dashboard/dashboard.module';

/**
 * Logistics & Driver Management (Logistics_and_Driver_Management_Full_Flow).
 * Teltonika GPS → GPS Tracking Platform (Traccar) → tracking adapter → PostgreSQL + Redis/queues → WebSocket → Next.js.
 * REST routes are versioned: /api/v1/...
 */
@Module({
  imports: [JobsModule, RealtimeModule, DriversModule, FleetModule, TrackingModule, RoutingModule, ShipmentsModule, WarehousesModule, LogisticsDashboardModule]
})
export class LogisticsModule {}
