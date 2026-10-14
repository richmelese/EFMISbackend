import { Body, Controller, Get, HttpCode, Param, ParseArrayPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ValidationError } from 'class-validator';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../../common/decorators';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { Errors } from '../../../common/utils/errors';
import { AuditService } from '../../audit/audit.service';
import { FleetService } from '../fleet/fleet.service';
import { ActivePositionsQuery, NormalizedPositionDto, SimulateDto } from './dto/tracking.dto';
import { TrackingService } from './tracking.service';
import { IngestResult, NormalizedPosition } from './tracking.types';

const flatten = (errors: ValidationError[], prefix = ''): Array<{ field: string; message: string }> =>
  errors.flatMap(e => [
    ...Object.values(e.constraints || {}).map(message => ({ field: prefix + e.property, message })),
    ...flatten(e.children || [], `${prefix}${e.property}.`)
  ]);

const summarize = (results: IngestResult[]) => results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});

@ApiTags('Logistics · GPS tracking')
@ApiBearerAuth()
@Controller({ path: 'tracking', version: '1' })
@RequirePermissions('tracking:read')
export class TrackingController {
  constructor(private readonly tracking: TrackingService, private readonly fleet: FleetService, private readonly audit: AuditService) {}

  @Get('active')
  @ApiOperation({ summary: 'Live map: trucks with last position, connectivity, stale flag, active trip / shipments / driver (scoped for DRIVER and WAREHOUSE_OPERATOR)' })
  async active(@Query() q: ActivePositionsQuery, @CurrentUser() user: AuthUser) {
    const visible = await this.fleet.visibleTruckIds(user);
    let items = await this.tracking.currentPositions(visible === null ? undefined : { truckIds: visible });
    if (q.connectivity) items = items.filter(i => i.connectivity === q.connectivity);
    if (q.onTrip === 'true') items = items.filter(i => !!i.trip);
    if (q.onTrip === 'false') items = items.filter(i => !i.trip);
    if (q.stale) items = items.filter(i => i.stale === (q.stale === 'true'));
    if (q.q) {
      const s = q.q.toLowerCase();
      items = items.filter(i => i.fleetCode.toLowerCase().includes(s) || i.plateNumber.toLowerCase().includes(s) || (i.trip?.tripNumber || '').toLowerCase().includes(s));
    }
    const page = q.page || 1;
    const pageSize = q.pageSize || 1000;
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, generatedAt: new Date().toISOString() };
  }

  @Get('trucks/:id')
  @ApiOperation({ summary: 'Current tracking state of one truck + last 50 points' })
  async truck(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    await this.fleet.assertCanViewTruck(user, id);
    return this.tracking.truckTracking(id);
  }

  @Post('simulate')
  @HttpCode(200)
  @RequirePermissions('tracking:ingest')
  @ApiOperation({ summary: 'Dev/pilot GPS simulator: push points for a truck (source SIMULATOR; default recordedAt = now + i seconds)' })
  async simulate(@Body() dto: SimulateDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const truck = await this.tracking.resolveTruck({ truckId: dto.truckId, fleetCode: dto.fleetCode });
    const base = Date.now();
    const positions: NormalizedPosition[] = dto.points.map((pt, i) => ({
      truckId: truck.id, providerPositionId: null, latitude: pt.lat, longitude: pt.lng,
      speedKmh: pt.speedKmh ?? null, heading: pt.heading ?? null, recordedAt: pt.recordedAt ?? new Date(base + i * 1000), attributes: { simulated: true }
    }));
    const results = await this.tracking.ingest(positions, 'SIMULATOR');
    const summary = summarize(results);
    // one audit entry per simulator run (individual GPS points are never audited)
    await this.audit.record(user, 'GPS_SIMULATION_RUN', truck.id, { fleetCode: truck.fleetCode, points: positions.length, summary }, ctx);
    return { truckId: truck.id, fleetCode: truck.fleetCode, summary, results };
  }

  @Post('positions')
  @HttpCode(200)
  @RequirePermissions('tracking:ingest')
  @ApiBody({ type: [NormalizedPositionDto] })
  @ApiOperation({ summary: 'Manual push of normalised positions (source MANUAL; max 1000 per request)' })
  async positions(
    @Body(new ParseArrayPipe({
      items: NormalizedPositionDto, whitelist: true, transformOptions: { enableImplicitConversion: true },
      exceptionFactory: (errors: ValidationError[] | unknown) => Errors.unprocessable('Request validation failed', Array.isArray(errors) ? flatten(errors as ValidationError[]) : errors)
    })) body: NormalizedPositionDto[],
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext
  ) {
    if (body.length > 1000) throw Errors.unprocessable('At most 1000 positions per request');
    const results = await this.tracking.ingest(body as NormalizedPosition[], 'MANUAL');
    const summary = summarize(results);
    await this.audit.record(user, 'GPS_MANUAL_POSITIONS', null, { count: body.length, summary }, ctx);
    return { summary, results };
  }
}
