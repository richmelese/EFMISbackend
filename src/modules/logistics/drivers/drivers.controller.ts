import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../../common/decorators';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import {
  AvailabilityQueryDto, CreateAvailabilityDto, CreateDriverDto, EligibleQueryDto, ExpiringQueryDto, ListDriversQueryDto, PageQueryDto,
  PerformanceQueryDto, ReactivateDriverDto, SuspendDriverDto, UpdateDriverDto, VerifyDriverDto
} from './dto/driver.dto';
import { DriversService } from './drivers.service';

@ApiTags('Logistics — Drivers')
@ApiBearerAuth()
@Controller({ path: 'drivers', version: '1' })
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get()
  @RequirePermissions('drivers:read')
  @ApiOperation({ summary: 'List drivers (filters: status, q; paged). DRIVER callers only get their own record.' })
  list(@Query() q: ListDriversQueryDto, @CurrentUser() user: AuthUser) {
    return this.drivers.list(user, q);
  }

  @Post()
  @RequirePermissions('drivers:manage')
  @ApiOperation({ summary: 'Create a driver (PENDING_VERIFICATION, availability UNAVAILABLE)' })
  create(@Body() dto: CreateDriverDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.drivers.create(user, dto, ctx);
  }

  // ---- static sub-paths must precede ':id'

  @Get('availability')
  @RequirePermissions('drivers:read')
  @ApiOperation({ summary: 'Free/busy of every active driver for [from, to] with reasons' })
  availability(@Query() q: AvailabilityQueryDto, @CurrentUser() user: AuthUser) {
    return this.drivers.availabilityOverview(user, q);
  }

  @Get('eligible')
  @RequirePermissions('drivers:read')
  @ApiOperation({ summary: 'Assignment modal: eligible drivers and why the others cannot be selected' })
  eligible(@Query() q: EligibleQueryDto, @CurrentUser() user: AuthUser) {
    return this.drivers.eligible(user, q);
  }

  @Get('expiring')
  @RequirePermissions('drivers:read')
  @ApiOperation({ summary: 'Licences, certifications and documents expiring within N days (expiry dashboard)' })
  expiring(@Query() q: ExpiringQueryDto, @CurrentUser() user: AuthUser) {
    return this.drivers.expiring(user, q.days);
  }

  @Get(':id')
  @RequirePermissions('drivers:read')
  @ApiOperation({ summary: 'Driver detail: overview, documents summary, upcoming availability, active assignment, recent trips' })
  detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.drivers.detail(user, id);
  }

  @Patch(':id')
  @RequirePermissions('drivers:manage')
  @ApiOperation({ summary: 'Update a driver (licence changes reset verification; audited old/new)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDriverDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.drivers.update(user, id, dto, ctx);
  }

  @Post(':id/verify')
  @HttpCode(200)
  @RequirePermissions('drivers:verify')
  @ApiOperation({ summary: 'Verify a driver (requires a verified, non-expired LICENCE document and a future licence expiry)' })
  verify(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyDriverDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.drivers.verify(user, id, dto, ctx);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermissions('drivers:manage')
  @ApiOperation({ summary: 'Suspend a driver (not allowed while ON_TRIP)' })
  suspend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SuspendDriverDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.drivers.suspend(user, id, dto, ctx);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermissions('drivers:manage')
  @ApiOperation({ summary: 'Reactivate a suspended/inactive driver (requires valid verification)' })
  reactivate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReactivateDriverDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.drivers.reactivate(user, id, dto, ctx);
  }

  @Post(':id/availability')
  @RequirePermissions('drivers:manage')
  @ApiOperation({ summary: 'Add a shift / leave / unavailability / training window' })
  addAvailability(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateAvailabilityDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.drivers.addAvailability(user, id, dto, ctx);
  }

  @Delete(':id/availability/:availabilityId')
  @RequirePermissions('drivers:manage')
  @ApiOperation({ summary: 'Remove an availability window' })
  removeAvailability(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('availabilityId', ParseUUIDPipe) availabilityId: string,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext
  ) {
    return this.drivers.removeAvailability(user, id, availabilityId, ctx);
  }

  @Get(':id/trips')
  @RequirePermissions('drivers:read')
  @ApiOperation({ summary: 'Trip/assignment history (paged)' })
  trips(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageQueryDto, @CurrentUser() user: AuthUser) {
    return this.drivers.tripHistory(user, id, q);
  }

  @Get(':id/performance')
  @RequirePermissions('drivers:read')
  @ApiOperation({ summary: 'Performance indicators for supervisor review (completed trips, on-time rate, discrepancies, incidents)' })
  performance(@Param('id', ParseUUIDPipe) id: string, @Query() q: PerformanceQueryDto, @CurrentUser() user: AuthUser) {
    return this.drivers.performance(user, id, q);
  }

  @Get(':id/audit')
  @RequirePermissions('drivers:read')
  @ApiOperation({ summary: 'Audit history of the driver (records, documents, availability, verification)' })
  auditHistory(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageQueryDto, @CurrentUser() user: AuthUser) {
    return this.drivers.auditHistory(user, id, q);
  }
}
