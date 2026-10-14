import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, Max, MaxLength, Min
} from 'class-validator';

/** Robust boolean parsing for JSON bodies, query strings and multipart fields ("false" must stay false). */
export const ToBool = () =>
  Transform(({ obj, key, value }) => {
    const raw = obj?.[key] ?? value;
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw === 'boolean') return raw;
    return ['true', '1', 'yes', 'on'].includes(String(raw).toLowerCase());
  });

export const SHIPMENT_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
export const DELIVERY_CONDITIONS = ['GOOD', 'DAMAGED', 'PARTIAL_DAMAGE', 'WET', 'SHORT'];

export class ListShipmentsQueryDto {
  @ApiPropertyOptional({ description: 'Status or comma-separated statuses', example: 'IN_TRANSIT,ARRIVED' })
  @IsOptional() @IsString() status?: string;

  @ApiPropertyOptional({ description: 'Only delayed shipments (isDelayed flag)' })
  @IsOptional() @ToBool() @IsBoolean() delayed?: boolean;

  @ApiPropertyOptional({ description: 'Origin or destination warehouse' })
  @IsOptional() @IsUUID() warehouseId?: string;

  @ApiPropertyOptional({ description: 'Search shipment number, customer, cargo description, QR lot' })
  @IsOptional() @IsString() @MaxLength(100) q?: string;

  @ApiPropertyOptional({ description: 'plannedPickupAt ≥ from (ISO date/time)' })
  @IsOptional() @IsDateString() from?: string;

  @ApiPropertyOptional({ description: 'plannedPickupAt ≤ to (ISO date/time)' })
  @IsOptional() @IsDateString() to?: string;

  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 50, maximum: 200 }) @IsOptional() @IsInt() @Min(1) @Max(200) pageSize?: number;
}

export class CreateShipmentDto {
  @ApiPropertyOptional({ description: 'Transporter waybill number (legal transport document); issued automatically at dispatch when empty', example: 'WB-2026-000123' })
  @IsOptional() @IsString() @MaxLength(64) @Matches(/^[A-Za-z0-9._/-]{3,64}$/, { message: 'waybillNumber may contain letters, digits and . _ / -' }) waybillNumber?: string;
  @ApiPropertyOptional({ example: 'Amhara Farmers Union' }) @IsOptional() @IsString() @MaxLength(160) customerName?: string;
  @ApiProperty() @IsUUID() originWarehouseId: string;
  @ApiProperty() @IsUUID() destinationWarehouseId: string;
  @ApiPropertyOptional({ description: 'Product (fertilizer) id — enables stock reservation' }) @IsOptional() @IsUUID() productId?: string;
  @ApiProperty({ example: '20 MT NPSB (Bagged with QR)' }) @IsString() @IsNotEmpty() @MaxLength(2000) cargoDescription: string;
  @ApiProperty({ example: 20 }) @IsNumber() @IsPositive() plannedQuantity: number;
  @ApiPropertyOptional({ example: 'MT', default: 'MT' }) @IsOptional() @IsIn(['MT']) quantityUnit?: string;
  @ApiPropertyOptional({ enum: SHIPMENT_PRIORITIES, default: 'NORMAL' }) @IsOptional() @IsIn(SHIPMENT_PRIORITIES) priority?: string;
  @ApiProperty({ example: '2026-10-14T06:00:00Z' }) @IsDateString() plannedPickupAt: string;
  @ApiProperty({ example: '2026-10-15T06:00:00Z' }) @IsDateString() plannedDeliveryAt: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() routeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) quotaAllocationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) qrLot?: string;
  @ApiPropertyOptional({ description: 'Reserve stock at origin (default true when productId is given)', default: true })
  @IsOptional() @ToBool() @IsBoolean() reserveStock?: boolean;
}

export class UpdateShipmentDto {
  @ApiPropertyOptional({ description: 'Transporter waybill number (legal transport document); issued automatically at dispatch when empty', example: 'WB-2026-000123' })
  @IsOptional() @IsString() @MaxLength(64) @Matches(/^[A-Za-z0-9._/-]{3,64}$/, { message: 'waybillNumber may contain letters, digits and . _ / -' }) waybillNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) customerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() originWarehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() destinationWarehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(2000) cargoDescription?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @IsPositive() plannedQuantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsIn(['MT']) quantityUnit?: string;
  @ApiPropertyOptional({ enum: SHIPMENT_PRIORITIES }) @IsOptional() @IsIn(SHIPMENT_PRIORITIES) priority?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() plannedPickupAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() plannedDeliveryAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() routeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) quotaAllocationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) qrLot?: string;
  @ApiPropertyOptional({ description: 'Reserve stock when no reservation exists yet' }) @IsOptional() @ToBool() @IsBoolean() reserveStock?: boolean;
}

export class PlanShipmentDto {
  @ApiPropertyOptional({ description: 'Route (must connect origin → destination)' }) @IsOptional() @IsUUID() routeId?: string;
}

export class ReasonDto {
  @ApiProperty({ example: 'Road closed by flooding' }) @IsString() @IsNotEmpty() @MaxLength(1000) reason: string;
}

/** Multipart (or JSON) body of POST /shipments/:id/delivery-confirmations. Optional file field "proof". */
export class ConfirmDeliveryDto {
  @ApiProperty({ example: 'Abebe Kebede' }) @IsString() @IsNotEmpty() @MaxLength(160) receiverName: string;
  @ApiPropertyOptional({ example: '0911223344' }) @IsOptional() @IsString() @Matches(/^\+?[0-9 ]{7,20}$/) receiverPhone?: string;
  @ApiProperty({ example: 19.8 }) @IsNumber() @Min(0) receivedQuantity: number;
  @ApiProperty({ enum: DELIVERY_CONDITIONS }) @IsIn(DELIVERY_CONDITIONS) condition: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiPropertyOptional({ description: 'Close the shipment even if less than the loaded quantity was received' })
  @IsOptional() @ToBool() @IsBoolean() finalDelivery?: boolean;
}
