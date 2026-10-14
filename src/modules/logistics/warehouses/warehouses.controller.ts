import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, ReqCtx, RequirePermissions } from '../../../common/decorators';
import { AuthUser, RequestContext } from '../../../common/types/auth-user';
import {
  CreateInventoryTransactionDto, CreateProductDto, CreateWarehouseDto, DiscrepancyQueryDto, InventoryTxQueryDto, ProductQueryDto, UpdateWarehouseDto,
  LotQcDto, LotQueryDto, WarehouseQueryDto
} from './dto/warehouses.dto';
import { WarehousesService } from './warehouses.service';

@ApiTags('Logistics · Warehouses & inventory')
@ApiBearerAuth()
@Controller({ path: 'warehouses', version: '1' })
export class WarehousesController {
  constructor(private readonly svc: WarehousesService) {}

  @Get()
  @RequirePermissions('warehouses:read')
  @ApiOperation({ summary: 'List warehouses with current stock and utilisation ({ items, total, page, pageSize })' })
  list(@Query() q: WarehouseQueryDto) {
    return this.svc.list(q);
  }

  @Post()
  @RequirePermissions('warehouses:manage')
  @ApiOperation({ summary: 'Create a warehouse (code & name unique, capacityMt > 0)' })
  create(@Body() dto: CreateWarehouseDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.create(user, dto, ctx);
  }

  @Get(':id')
  @RequirePermissions('warehouses:read')
  @ApiOperation({ summary: 'Warehouse detail with stock totals' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }

  @Patch(':id')
  @RequirePermissions('warehouses:manage')
  @ApiOperation({ summary: 'Update a warehouse (audited)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWarehouseDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.update(user, id, dto, ctx);
  }

  @Get(':id/inventory')
  @RequirePermissions('warehouses:read', 'inventory:transact')
  @ApiOperation({ summary: 'Balances per product: onHand, reserved, available, share of capacity (operators: own warehouse only)' })
  inventory(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.svc.inventoryOf(user, id);
  }

  @Get(':id/lots')
  @RequirePermissions('warehouses:read', 'inventory:transact', 'inventory:qc')
  @ApiOperation({ summary: 'Stock lots (QR batches) with QC status, expiry, on hand / reserved / usable available' })
  lots(@Param('id', ParseUUIDPipe) id: string, @Query() q: LotQueryDto, @CurrentUser() user: AuthUser) {
    return this.svc.lots(user, id, q);
  }

  @Get(':id/discrepancies')
  @RequirePermissions('warehouses:read', 'inventory:transact')
  @ApiOperation({ summary: 'Loading discrepancy, damage and adjustment history of a warehouse' })
  discrepancies(@Param('id', ParseUUIDPipe) id: string, @Query() q: DiscrepancyQueryDto, @CurrentUser() user: AuthUser) {
    return this.svc.discrepancies(user, id, q);
  }
}

@ApiTags('Logistics · Warehouses & inventory')
@ApiBearerAuth()
@Controller({ path: 'products', version: '1' })
export class ProductsController {
  constructor(private readonly svc: WarehousesService) {}

  @Get()
  @RequirePermissions('warehouses:read', 'inventory:transact', 'shipments:read')
  @ApiOperation({ summary: 'Product catalogue (fertilizer blends)' })
  list(@Query() q: ProductQueryDto) {
    return this.svc.listProducts(q);
  }

  @Post()
  @RequirePermissions('warehouses:manage')
  @ApiOperation({ summary: 'Create a product (SKU unique, upper-case)' })
  create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.createProduct(user, dto, ctx);
  }
}

@ApiTags('Logistics · Warehouses & inventory')
@ApiBearerAuth()
@Controller({ path: 'inventory', version: '1' })
export class InventoryController {
  constructor(private readonly svc: WarehousesService) {}

  @Get('transactions')
  @RequirePermissions('warehouses:read', 'inventory:transact')
  @ApiOperation({ summary: 'Inventory ledger (filters: warehouseId, productId, type, referenceType/referenceId, from/to)' })
  list(@Query() q: InventoryTxQueryDto, @CurrentUser() user: AuthUser) {
    return this.svc.listTransactions(user, q);
  }

  @Get('lots/:lotId')
  @RequirePermissions('warehouses:read', 'inventory:transact', 'inventory:qc')
  @ApiOperation({ summary: 'One lot with its warehouse and product (follow source-lot links across warehouses)' })
  lot(@Param('lotId', ParseUUIDPipe) lotId: string, @CurrentUser() user: AuthUser) {
    return this.svc.getLot(user, lotId);
  }

  @Post('lots/:lotId/qc')
  @RequirePermissions('inventory:qc')
  @ApiOperation({ summary: 'Quality decision on a lot: PASSED | PENDING | HELD | REJECTED (HELD/REJECTED block reservation and loading; alert lists affected shipments)' })
  lotQc(@Param('lotId', ParseUUIDPipe) lotId: string, @Body() dto: LotQcDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.setLotQc(user, lotId, dto, ctx);
  }

  @Post('transactions')
  @RequirePermissions('inventory:transact')
  @ApiOperation({ summary: 'Manual movement: RECEIPT | ADJUSTMENT | RETURN | DAMAGE | TRANSFER (atomic, row-locked, audited)' })
  post(@Body() dto: CreateInventoryTransactionDto, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.svc.postTransaction(user, dto, ctx);
  }
}
