import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryBalance, InventoryTransaction, Product, Warehouse } from './entities/warehouse.entities';
import { InventoryService } from './inventory.service';
import { WarehousesService } from './warehouses.service';
import { InventoryController, ProductsController, WarehousesController } from './warehouses.controller';

/** Warehouses, products and the auditable inventory ledger (Logistics doc §13). */
@Module({
  imports: [TypeOrmModule.forFeature([Warehouse, Product, InventoryBalance, InventoryTransaction])],
  controllers: [WarehousesController, ProductsController, InventoryController],
  providers: [WarehousesService, InventoryService],
  exports: [WarehousesService, InventoryService]
})
export class WarehousesModule {}
