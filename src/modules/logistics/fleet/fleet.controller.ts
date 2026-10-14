import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../../common/decorators';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import {
  AssignDeviceDto, CreateGpsDeviceDto, CreateTruckDto, CreateVehicleTypeDto, GpsDeviceListQuery, LocationHistoryQuery, RetireDeviceDto,
  TruckEligibleQuery, TruckListQuery, TruckStatusDto, UnassignDeviceDto, UpdateGpsDeviceDto, UpdateTruckDto, UpdateVehicleTypeDto, VehicleTypeListQuery
} from './dto/fleet.dto';
import { FleetService } from './fleet.service';
import { GpsDevicesService } from './gps-devices.service';

@ApiTags('Logistics · Fleet')
@ApiBearerAuth()
@Controller({ path: 'vehicle-types', version: '1' })
@RequirePermissions('fleet:read')
export class VehicleTypesController {
  constructor(private readonly fleet: FleetService) {}

  @Get()
  @ApiOperation({ summary: 'List vehicle types' })
  list(@Query() q: VehicleTypeListQuery) {
    return this.fleet.listVehicleTypes(q);
  }

  @Post()
  @RequirePermissions('fleet:manage')
  @ApiOperation({ summary: 'Create a vehicle type (capacity, allowed licence classes, cargo types)' })
  create(@Body() dto: CreateVehicleTypeDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.fleet.createVehicleType(user, dto, ctx);
  }

  @Patch(':id')
  @RequirePermissions('fleet:manage')
  @ApiOperation({ summary: 'Update a vehicle type' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVehicleTypeDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.fleet.updateVehicleType(user, id, dto, ctx);
  }
}

@ApiTags('Logistics · Fleet')
@ApiBearerAuth()
@Controller({ path: 'trucks', version: '1' })
@RequirePermissions('fleet:read')
export class TrucksController {
  constructor(private readonly fleet: FleetService) {}

  @Get()
  @ApiOperation({ summary: 'List trucks (filters: status, availability, connectivity, vehicleTypeId, q) with device, connectivity, last position, current trip' })
  list(@Query() q: TruckListQuery) {
    return this.fleet.listTrucks(q);
  }

  @Post()
  @RequirePermissions('fleet:manage')
  @ApiOperation({ summary: 'Register a truck (fleetCode & plateNumber unique; 0 < capacity ≤ vehicle type maximum)' })
  create(@Body() dto: CreateTruckDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.fleet.createTruck(user, dto, ctx);
  }

  @Get('eligible')
  @ApiOperation({ summary: 'Assignment modal: eligible trucks for a load and why the others cannot be selected' })
  eligible(@Query() q: TruckEligibleQuery) {
    return this.fleet.eligibleTrucks(q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Truck detail' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.fleet.getTruck(id);
  }

  @Patch(':id')
  @RequirePermissions('fleet:manage')
  @ApiOperation({ summary: 'Update truck master data (audited old/new)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTruckDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.fleet.updateTruck(user, id, dto, ctx);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermissions('fleet:manage')
  @ApiOperation({ summary: 'Change operational status (ACTIVE | MAINTENANCE | OUT_OF_SERVICE); 409 while on a trip' })
  status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TruckStatusDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.fleet.setOperationalStatus(user, id, dto, ctx);
  }

  @Get(':id/locations')
  @RequirePermissions('tracking:read')
  @ApiOperation({ summary: 'Location history (newest first; from/to; cursor or page pagination, max 1000 per page)' })
  async locations(@Param('id', ParseUUIDPipe) id: string, @Query() q: LocationHistoryQuery, @CurrentUser() user: AuthUser) {
    await this.fleet.assertCanViewTruck(user, id);
    return this.fleet.locationHistory(id, q);
  }
}

@ApiTags('Logistics · GPS devices')
@ApiBearerAuth()
@Controller({ path: 'gps-devices', version: '1' })
@RequirePermissions('fleet:read', 'devices:manage')
export class GpsDevicesController {
  constructor(private readonly devices: GpsDevicesService) {}

  @Get()
  @ApiOperation({ summary: 'List GPS devices (IMEI / SIM masked unless devices:manage)' })
  list(@Query() q: GpsDeviceListQuery, @CurrentUser() user: AuthUser) {
    return this.devices.list(user, q);
  }

  @Post()
  @RequirePermissions('devices:manage')
  @ApiOperation({ summary: 'Register a GPS device (provider default TRACCAR; providerDeviceId unique per provider; IMEI 15 digits unique)' })
  create(@Body() dto: CreateGpsDeviceDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.devices.create(user, dto, ctx);
  }

  @Get(':id')
  @ApiOperation({ summary: 'GPS device detail' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.devices.get(user, id);
  }

  @Patch(':id')
  @RequirePermissions('devices:manage')
  @ApiOperation({ summary: 'Update GPS device registry data' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGpsDeviceDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.devices.update(user, id, dto, ctx);
  }

  @Post(':id/assign-truck')
  @HttpCode(200)
  @RequirePermissions('devices:manage')
  @ApiOperation({ summary: 'Pair the device with a truck (one device per truck, one truck per device)' })
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDeviceDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.devices.assignTruck(user, id, dto, ctx);
  }

  @Post(':id/unassign')
  @HttpCode(200)
  @RequirePermissions('devices:manage')
  @ApiOperation({ summary: 'Unpair the device from its truck (409 while on a trip unless force=true by ADMIN)' })
  unassign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UnassignDeviceDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.devices.unassign(user, id, dto, ctx);
  }

  @Post(':id/retire')
  @HttpCode(200)
  @RequirePermissions('devices:manage')
  @ApiOperation({ summary: 'Retire the device (must be unassigned first); its positions are rejected afterwards' })
  retire(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RetireDeviceDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.devices.retire(user, id, dto, ctx);
  }

  @Get(':id/diagnostics')
  @ApiOperation({ summary: 'Device diagnostics: connectivity, last seen, positions (24 h), out-of-order count, rejections, assignment history' })
  diagnostics(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.devices.diagnostics(user, id);
  }
}
