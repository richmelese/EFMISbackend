import {
  Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../../common/decorators';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import { DeliveriesService } from './deliveries.service';
import { ConfirmDeliveryDto, CreateShipmentDto, ListShipmentsQueryDto, PlanShipmentDto, ReasonDto, UpdateShipmentDto } from './dto/shipment.dto';
import { ShipmentsService } from './shipments.service';
import { UploadedProof } from './shipments.util';

@ApiTags('Logistics · Shipments')
@ApiBearerAuth()
@Controller({ path: 'shipments', version: '1' })
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService, private readonly deliveries: DeliveriesService) {}

  @Get()
  @RequirePermissions('shipments:read')
  @ApiOperation({ summary: 'List shipments (filters: status, delayed, warehouseId, q, from/to; paged). Scoped for DRIVER / WAREHOUSE_OPERATOR.' })
  list(@Query() q: ListShipmentsQueryDto, @CurrentUser() user: AuthUser) {
    return this.shipments.list(user, q);
  }

  @Post()
  @RequirePermissions('shipments:manage')
  @ApiOperation({ summary: 'Create a shipment (SH-xxxx, DRAFT) and reserve stock at the origin warehouse' })
  create(@Body() dto: CreateShipmentDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.shipments.create(user, dto, ctx);
  }

  @Get(':id')
  @RequirePermissions('shipments:read')
  @ApiOperation({ summary: 'Shipment detail with trips, deliveries and timeline' })
  detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.shipments.detail(user, id);
  }

  @Patch(':id')
  @RequirePermissions('shipments:manage')
  @ApiOperation({ summary: 'Edit a DRAFT / PLANNED shipment (re-reserves stock when the quantity changes)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateShipmentDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.shipments.update(user, id, dto, ctx);
  }

  @Post(':id/plan')
  @HttpCode(200)
  @RequirePermissions('shipments:manage')
  @ApiOperation({ summary: 'DRAFT → PLANNED (optional route; must connect origin → destination)' })
  plan(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PlanShipmentDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.shipments.plan(user, id, dto, ctx);
  }

  @Post(':id/hold')
  @HttpCode(200)
  @RequirePermissions('shipments:manage')
  @ApiOperation({ summary: 'Put a shipment ON_HOLD (reason required)' })
  hold(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.shipments.hold(user, id, dto, ctx);
  }

  @Post(':id/release-hold')
  @HttpCode(200)
  @RequirePermissions('shipments:manage')
  @ApiOperation({ summary: 'Lift a hold (returns to the status before the hold)' })
  releaseHold(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.shipments.releaseHold(user, id, ctx);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('shipments:manage')
  @ApiOperation({ summary: 'Cancel before IN_TRANSIT (releases the stock reservation, detaches from non-dispatched trips)' })
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.shipments.cancel(user, id, dto, ctx);
  }

  @Post(':id/delivery-confirmations')
  @RequirePermissions('deliveries:confirm')
  @UseInterceptors(FileInterceptor('proof'))
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Repeated key returns the original delivery (200) instead of a duplicate' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['receiverName', 'receivedQuantity', 'condition'],
      properties: {
        proof: { type: 'string', format: 'binary', description: 'JPEG / PNG / PDF; required on discrepancy or condition ≠ GOOD' },
        receiverName: { type: 'string' }, receiverPhone: { type: 'string' }, receivedQuantity: { type: 'number', example: 19.8 },
        condition: { type: 'string', enum: ['GOOD', 'DAMAGED', 'PARTIAL_DAMAGE', 'WET', 'SHORT'] }, notes: { type: 'string' },
        finalDelivery: { type: 'boolean' }
      }
    }
  })
  @ApiOperation({ summary: 'Confirm (partial) delivery with proof; posts the receipt to destination stock and flags discrepancies' })
  async confirmDelivery(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmDeliveryDto,
    @UploadedFile() file: UploadedProof | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response
  ) {
    const r = await this.deliveries.confirm(user, id, dto, file, idempotencyKey, ctx);
    if (r.replayed) res.status(200);
    return r;
  }

  @Get(':id/deliveries')
  @RequirePermissions('shipments:read')
  @ApiOperation({ summary: 'Delivery confirmations of a shipment (partial deliveries)' })
  listDeliveries(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.deliveries.list(user, id);
  }
}
