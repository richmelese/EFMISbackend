import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { memoryStorage } from 'multer';
import { RULES } from '../../../common/constants/rules';
import { Errors } from '../../../common/utils/errors';
import { User } from '../../users/entities/user.entity';
import { VehicleType } from '../fleet/entities/fleet.entities';
import { Delivery, Shipment, Trip, TripEvent, TripShipment } from '../shipments/entities/shipment.entities';
import { DriverComplianceService } from './driver-compliance.service';
import { DriverDocumentsController } from './driver-documents.controller';
import { DriverDocumentsService } from './driver-documents.service';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';
import { Driver, DriverAvailability, DriverDocument, DriverTripAssignment } from './entities/driver.entities';

/** Driver management (Logistics doc §6/§7). Exports DriversService (contract: toFrontend, driverForUser, checkEligibility, setAvailability). */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Driver, DriverDocument, DriverAvailability, DriverTripAssignment, VehicleType, Trip, TripShipment, Shipment, Delivery, TripEvent, User
    ]),
    // Document uploads: memory storage (written to private storage by the service), size limit from config, JPEG/PNG/PDF only
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: memoryStorage(),
        limits: { fileSize: config.get<number>('maxUploadBytes'), files: 1 },
        fileFilter: (_req: unknown, file: { mimetype: string }, cb: (error: Error | null, accept: boolean) => void) =>
          RULES.uploadMimeTypes.includes(file.mimetype) ? cb(null, true) : cb(Errors.unprocessable('Only JPEG, PNG or PDF files are accepted'), false)
      })
    })
  ],
  controllers: [DriversController, DriverDocumentsController],
  providers: [DriversService, DriverDocumentsService, DriverComplianceService],
  exports: [DriversService]
})
export class DriversModule {}
