import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../../common/decorators';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { CreateIncidentDto, CreateScanDto, ListIncidentsQueryDto, ResolveIncidentDto, UpdateIncidentDto } from './dto/custody.dto';
import { CustodyService } from './custody.service';

@ApiTags('Logistics · Chain of custody')
@ApiBearerAuth()
@Controller({ path: 'shipments', version: '1' })
export class ScansController {
  constructor(private readonly custody: CustodyService) {}

  @Get(':id/scans')
  @RequirePermissions('shipments:read')
  @ApiOperation({ summary: 'Custody chain: QR scans from origin to destination with a summary (mismatches, bag counts)' })
  list(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.custody.listScans(user, id);
  }

  @Post(':id/scans')
  @RequirePermissions('shipments:scan')
  @ApiOperation({ summary: 'Record a QR scan (DISPATCH_ORIGIN | CHECKPOINT | HANDOVER | RECEIVE_DESTINATION); a lot mismatch raises a Theft/Diversion alert' })
  scan(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateScanDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.custody.recordScan(user, id, dto, ctx);
  }
}

@ApiTags('Logistics · Security incidents')
@ApiBearerAuth()
@Controller({ path: 'security-incidents', version: '1' })
export class SecurityIncidentsController {
  constructor(private readonly custody: CustodyService) {}

  @Get()
  @RequirePermissions('incidents:read')
  @ApiOperation({ summary: 'Security incidents (filters: status, incidentType, shipmentId, tripId, from/to) — scoped' })
  list(@Query() q: ListIncidentsQueryDto, @CurrentUser() user: AuthUser) {
    return this.custody.listIncidents(user, q);
  }

  @Post()
  @RequirePermissions('incidents:report')
  @ApiOperation({ summary: 'Report theft / diversion / robbery / tampering / accident / unauthorised stop (raises an alert)' })
  report(@Body() dto: CreateIncidentDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.custody.reportIncident(user, dto, ctx);
  }

  @Get(':id')
  @RequirePermissions('incidents:read')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.custody.getIncident(user, id);
  }

  @Patch(':id')
  @RequirePermissions('incidents:manage')
  @ApiOperation({ summary: 'Investigation update: severity, status INVESTIGATING, police report, affected quantity (audited)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateIncidentDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.custody.updateIncident(user, id, dto, ctx);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePermissions('incidents:manage')
  @ApiOperation({ summary: 'Resolve with a resolution note (theft-type incidents need a police report number)' })
  resolve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveIncidentDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.custody.resolveIncident(user, id, dto, ctx);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermissions('incidents:manage')
  close(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.custody.closeIncident(user, id, ctx);
  }
}
