import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { memoryStorage } from 'multer';
import { RULES } from '../../../common/constants/rules';
import { Errors } from '../../../common/utils/errors';
import { DriversModule } from '../drivers/drivers.module';
import { FleetModule } from '../fleet/fleet.module';
import { RoutingModule } from '../routing/routing.module';
import { WarehousesModule } from '../warehouses/warehouses.module';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from './deliveries.service';
import { Delivery, IdempotencyKey, Shipment, Trip, TripChecklist, TripEvent, TripShipment } from './entities/shipment.entities';
import { ShipmentsController } from './shipments.controller';
import { ScansController, SecurityIncidentsController } from './custody.controller';
import { CustodyService } from './custody.service';
import { SecurityIncident, ShipmentScanEvent } from './entities/custody.entities';
import { ShipmentsService } from './shipments.service';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';

/**
 * Shipments, trips and deliveries (Logistics doc §5, §9, §10, §13).
 * Exports ShipmentsService, TripsService (systemTransition / activeTripForTruck / tripToFrontend) and DeliveriesService.
 * RoutingModule resolves TripsService lazily (ModuleRef) for systemTransition, so there is no module cycle.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Shipment, Trip, TripShipment, TripChecklist, TripEvent, Delivery, IdempotencyKey, ShipmentScanEvent, SecurityIncident]),
    DriversModule,
    FleetModule,
    WarehousesModule,
    RoutingModule,
    // proof-of-delivery uploads: memory storage, size limit from config, JPEG/PNG/PDF only
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: memoryStorage(),
        limits: { fileSize: config.get<number>('maxUploadBytes'), files: 1 },
        fileFilter: (_req: unknown, file: { mimetype: string }, cb: (error: Error | null, accept: boolean) => void) =>
          RULES.uploadMimeTypes.includes(file.mimetype) ? cb(null, true) : cb(Errors.unprocessable('Proof of delivery must be a JPEG, PNG or PDF file'), false)
      })
    })
  ],
  controllers: [ShipmentsController, TripsController, DeliveriesController, ScansController, SecurityIncidentsController],
  providers: [ShipmentsService, TripsService, DeliveriesService, CustodyService],
  exports: [ShipmentsService, TripsService, DeliveriesService]
})
export class ShipmentsModule {}
