import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Geofence, GeofenceEvent, GeofenceState, Route, RouteMilestone, TrackingEvent, TripMilestone } from './entities/routing.entities';
import { RouteEstimatorService } from './route-estimator.service';
import { GeofencesController, RoutesController, RoutingTripsController } from './routing.controller';
import { RoutingService } from './routing.service';
import { TrackingProcessorService } from './tracking-processor.service';

/**
 * Routes, milestones, geofences, ETA and the tracking event processor (consumer of QUEUES.TRACKING).
 * TripsService (shipments module) is resolved lazily through ModuleRef to avoid a circular module import.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Route, RouteMilestone, TripMilestone, Geofence, GeofenceState, GeofenceEvent, TrackingEvent])],
  controllers: [RoutesController, GeofencesController, RoutingTripsController],
  providers: [RouteEstimatorService, TrackingProcessorService, RoutingService],
  exports: [RoutingService]
})
export class RoutingModule {}
