import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Driver } from '../drivers/entities/driver.entities';
import { Shipment, Trip, TripShipment } from '../shipments/entities/shipment.entities';
import { GpsDevice, GpsDeviceAssignment, GpsIngestRejection, Truck, TruckLocation, VehicleType } from './entities/fleet.entities';
import { GpsDevicesController, TrucksController, VehicleTypesController } from './fleet.controller';
import { FleetService } from './fleet.service';
import { GpsDevicesService } from './gps-devices.service';

/** Fleet & GPS device registry (Logistics doc §8): vehicle types, trucks, GPS devices, device ↔ truck pairing. */
@Module({
  imports: [TypeOrmModule.forFeature([VehicleType, Truck, GpsDevice, GpsDeviceAssignment, GpsIngestRejection, TruckLocation, Trip, Driver, TripShipment, Shipment])],
  controllers: [VehicleTypesController, TrucksController, GpsDevicesController],
  providers: [FleetService, GpsDevicesService],
  exports: [FleetService, GpsDevicesService]
})
export class FleetModule {}
