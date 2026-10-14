import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../../common/decorators';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { ChecklistDto, CreateTripDto, IncidentDto, ListTripsQueryDto, LoadingDto, ReassignTripDto, TripReasonDto } from './dto/trip.dto';
import { TripsService } from './trips.service';

@ApiTags('Logistics · Trips')
@ApiBearerAuth()
@Controller({ path: 'trips', version: '1' })
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Get()
  @RequirePermissions('shipments:read')
  @ApiOperation({ summary: 'List trips (filters: status, truckId, driverId, active; paged). DRIVER sees own trips only.' })
  list(@Query() q: ListTripsQueryDto, @CurrentUser() user: AuthUser) {
    return this.trips.list(user, q);
  }

  @Post()
  @RequirePermissions('trips:dispatch')
  @ApiOperation({ summary: 'Create a trip: assign truck + driver to PLANNED shipments (eligibility checks, double-booking prevention)' })
  create(@Body() dto: CreateTripDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.create(user, dto, ctx);
  }

  @Get(':id')
  @RequirePermissions('shipments:read')
  @ApiOperation({ summary: 'Trip detail: truck, driver, shipments, checklist, milestones, events, deliveries' })
  detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.trips.detail(user, id);
  }

  @Get(':id/events')
  @RequirePermissions('shipments:read')
  @ApiOperation({ summary: 'Trip timeline events (incidents, delays, notes, status changes)' })
  events(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.trips.events(user, id);
  }

  @Post(':id/assignments')
  @HttpCode(200)
  @RequirePermissions('trips:dispatch')
  @ApiOperation({ summary: 'Reassign driver and/or truck before dispatch (same eligibility checks)' })
  reassign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReassignTripDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.reassign(user, id, dto, ctx);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequirePermissions('trips:driver')
  @ApiOperation({ summary: 'Driver accepts the trip → DRIVER_ACCEPTED' })
  accept(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.accept(user, id, ctx);
  }

  @Post(':id/checklist')
  @HttpCode(200)
  @RequirePermissions('trips:driver')
  @ApiOperation({ summary: 'Pre-trip vehicle checklist + driver acknowledgement → VEHICLE_CHECKED (422 listing failed items)' })
  checklist(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChecklistDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.checklist(user, id, dto, ctx);
  }

  @Post(':id/loading/start')
  @HttpCode(200)
  @RequirePermissions('trips:loading')
  @ApiOperation({ summary: 'Start loading at the origin warehouse → LOADING' })
  startLoading(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.startLoading(user, id, ctx);
  }

  @Post(':id/loading')
  @HttpCode(200)
  @RequirePermissions('trips:loading')
  @ApiOperation({ summary: 'Record loaded quantities (discrepancies flagged); all loaded → READY' })
  recordLoading(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LoadingDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.recordLoading(user, id, dto, ctx);
  }

  @Post(':id/dispatch')
  @HttpCode(200)
  @RequirePermissions('trips:dispatch')
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Strongly recommended: a repeated key returns the stored response' })
  @ApiOperation({ summary: 'Dispatch: deduct loaded stock, shipments IN_TRANSIT, truck & driver ON_TRIP' })
  dispatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext
  ) {
    return this.trips.dispatch(user, id, idempotencyKey, ctx);
  }

  @Post(':id/arrive')
  @HttpCode(200)
  @RequirePermissions('trips:driver', 'deliveries:confirm')
  @ApiOperation({ summary: 'Mark arrival at destination → ARRIVED (shipments ARRIVED)' })
  arrive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.arrive(user, id, ctx);
  }

  @Post(':id/unloading')
  @HttpCode(200)
  @RequirePermissions('deliveries:confirm')
  @ApiOperation({ summary: 'Start unloading → UNLOADING' })
  unloading(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.unloading(user, id, ctx);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermissions('trips:dispatch')
  @ApiOperation({ summary: 'Complete the trip (all shipments delivered/failed); releases truck & driver; KPI summary' })
  complete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.complete(user, id, ctx);
  }

  @Post(':id/incidents')
  @RequirePermissions('trips:driver')
  @ApiOperation({ summary: 'Log an incident / delay / stop / communication / note (HIGH/CRITICAL incident → INCIDENT + alert)' })
  incident(@Param('id', ParseUUIDPipe) id: string, @Body() dto: IncidentDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.incident(user, id, dto, ctx);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermissions('trips:driver', 'trips:dispatch')
  @ApiOperation({ summary: 'Resume after an incident (INCIDENT → IN_PROGRESS)' })
  resume(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.resume(user, id, ctx);
  }

  @Post(':id/return')
  @HttpCode(200)
  @RequirePermissions('trips:dispatch')
  @ApiOperation({ summary: 'Send the truck back (→ RETURNING)' })
  returnTrip(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TripReasonDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.returnTrip(user, id, dto, ctx);
  }

  @Post(':id/abort')
  @HttpCode(200)
  @RequirePermissions('trips:dispatch')
  @ApiOperation({ summary: 'Abort: release truck/driver and reservations; dispatched shipments → DELIVERY_FAILED' })
  abort(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TripReasonDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.trips.abort(user, id, dto, ctx);
  }
}
