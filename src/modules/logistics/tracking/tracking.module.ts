import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Driver } from '../drivers/entities/driver.entities';
import { GpsDevice, GpsIngestRejection, Truck, TruckLocation } from '../fleet/entities/fleet.entities';
import { FleetModule } from '../fleet/fleet.module';
import { TrackingEvent } from '../routing/entities/routing.entities';
import { Shipment, Trip, TripShipment } from '../shipments/entities/shipment.entities';
import { TraccarPollerService } from './traccar/traccar-poller.service';
import { TraccarController } from './traccar/traccar.controller';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';

/**
 * GPS tracking (Logistics doc §11): ingestion pipeline, live positions, stale/offline detection and the Traccar adapter
 * (provider-specific mapping lives only in ./traccar).
 */
@Module({
  imports: [
    FleetModule,
    TypeOrmModule.forFeature([Truck, GpsDevice, TruckLocation, GpsIngestRejection, Trip, TripShipment, Shipment, Driver, TrackingEvent])
  ],
  controllers: [TrackingController, TraccarController],
  providers: [TrackingService, TraccarPollerService],
  exports: [TrackingService]
})
export class TrackingModule {}
