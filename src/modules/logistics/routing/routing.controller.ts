import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../../common/decorators';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { Errors } from '../../../common/utils/errors';
import { isValidCoordinate } from '../../../common/utils/geo';
import {
  CreateGeofenceDto, CreateMilestoneDto, CreateRouteDto, EstimateDto, GeofenceEventsQuery, GeofenceListQuery, RouteListQuery, TripEtaQuery,
  UpdateGeofenceDto, UpdateRouteDto
} from './dto/routing.dto';
import { RoutingService } from './routing.service';

/** Routes, checkpoints/milestones and road-based estimates (Logistics doc §12, §15). */
@ApiTags('Logistics · Routes & Milestones')
@ApiBearerAuth()
@Controller({ path: 'routes', version: '1' })
export class RoutesController {
  constructor(private readonly routing: RoutingService) {}

  @Get()
  @RequirePermissions('tracking:read', 'shipments:read')
  @ApiOperation({ summary: 'List routes (paged; filters q, active, originWarehouseId, destinationWarehouseId)' })
  list(@Query() q: RouteListQuery) {
    return this.routing.listRoutes(q);
  }

  @Post('estimate')
  @HttpCode(200)
  @RequirePermissions('routes:manage')
  @ApiOperation({ summary: 'Road distance / duration / geometry between two points (routing provider or straight-line fallback)' })
  async estimate(@Body() dto: EstimateDto) {
    if (!isValidCoordinate(dto.origin[0], dto.origin[1])) throw Errors.unprocessable('origin must be a valid [lat, lng]');
    if (!isValidCoordinate(dto.destination[0], dto.destination[1])) throw Errors.unprocessable('destination must be a valid [lat, lng]');
    return this.routing.estimate([dto.origin[0], dto.origin[1]], [dto.destination[0], dto.destination[1]]);
  }

  @Post()
  @RequirePermissions('routes:manage')
  @ApiOperation({ summary: 'Create a route (geometry/distance/duration computed from warehouse coordinates unless geometry is supplied)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRouteDto, @ReqCtx() ctx: RequestContext) {
    return this.routing.createRoute(user, dto, ctx);
  }

  @Get(':id')
  @RequirePermissions('tracking:read', 'shipments:read')
  @ApiOperation({ summary: 'Route detail with milestones' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.routing.getRoute(id);
  }

  @Patch(':id')
  @RequirePermissions('routes:manage')
  @ApiOperation({ summary: 'Update route (name, corridor, active, geometry; recompute=true re-runs the routing provider)' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRouteDto, @ReqCtx() ctx: RequestContext) {
    return this.routing.updateRoute(user, id, dto, ctx);
  }

  @Get(':id/milestones')
  @RequirePermissions('tracking:read', 'shipments:read')
  @ApiOperation({ summary: 'Ordered route milestones (checkpoints)' })
  milestones(@Param('id', ParseUUIDPipe) id: string) {
    return this.routing.listMilestones(id);
  }

  @Post(':id/milestones')
  @RequirePermissions('routes:manage')
  @ApiOperation({ summary: 'Add a milestone (existing geofenceId, or lat/lng/radiusM → auto CHECKPOINT circle geofence)' })
  addMilestone(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateMilestoneDto, @ReqCtx() ctx: RequestContext) {
    return this.routing.addMilestone(user, id, dto, ctx);
  }

  @Delete(':id/milestones/:milestoneId')
  @RequirePermissions('routes:manage')
  @ApiOperation({ summary: 'Remove a route milestone (existing trip milestones are kept)' })
  removeMilestone(
    @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('milestoneId', ParseUUIDPipe) milestoneId: string, @ReqCtx() ctx: RequestContext
  ) {
    return this.routing.removeMilestone(user, id, milestoneId, ctx);
  }
}

/** Geofences: warehouse/depot/checkpoint/border/port/restricted zones (Logistics doc §12). */
@ApiTags('Logistics · Geofences')
@ApiBearerAuth()
@Controller({ path: 'geofences', version: '1' })
export class GeofencesController {
  constructor(private readonly routing: RoutingService) {}

  @Get()
  @RequirePermissions('tracking:read', 'shipments:read')
  @ApiOperation({ summary: 'List geofences (paged; filters q, kind, active, warehouseId)' })
  list(@Query() q: GeofenceListQuery) {
    return this.routing.listGeofences(q);
  }

  @Post()
  @RequirePermissions('geofences:manage')
  @ApiOperation({ summary: 'Create a geofence (CIRCLE: centre + radius 50–50000 m; POLYGON: ≥ 3 points)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateGeofenceDto, @ReqCtx() ctx: RequestContext) {
    return this.routing.createGeofence(user, dto, ctx);
  }

  @Get(':id')
  @RequirePermissions('tracking:read', 'shipments:read')
  @ApiOperation({ summary: 'Geofence detail' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.routing.getGeofence(id);
  }

  @Patch(':id')
  @RequirePermissions('geofences:manage')
  @ApiOperation({ summary: 'Update a geofence (shape re-validated)' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGeofenceDto, @ReqCtx() ctx: RequestContext) {
    return this.routing.updateGeofence(user, id, dto, ctx);
  }

  @Get(':id/events')
  @RequirePermissions('tracking:read', 'shipments:read')
  @ApiOperation({ summary: 'Recent confirmed enter/exit transitions (paged; filters truckId, tripId, type)' })
  events(@Param('id', ParseUUIDPipe) id: string, @Query() q: GeofenceEventsQuery) {
    return this.routing.geofenceEvents(id, q);
  }
}

/**
 * Trip milestone progress and ETA. Only these two GET sub-routes of /trips belong to the routing module;
 * every other /api/v1/trips route is owned by the shipments module.
 */
@ApiTags('Logistics · Routes & Milestones')
@ApiBearerAuth()
@Controller({ path: 'trips', version: '1' })
export class RoutingTripsController {
  constructor(private readonly routing: RoutingService) {}

  @Get(':id/milestones')
  @RequirePermissions('tracking:read')
  @ApiOperation({ summary: 'Trip milestone progress (PENDING / REACHED / MISSED, expected vs reached)' })
  milestones(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.routing.tripMilestones(user, id);
  }

  @Get(':id/eta')
  @RequirePermissions('tracking:read')
  @ApiOperation({ summary: 'Current trip ETA, remaining distance and per-shipment delay status (?refresh=true → throttled recompute)' })
  eta(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: TripEtaQuery) {
    return this.routing.tripEta(user, id, q.refresh === 'true');
  }
}
