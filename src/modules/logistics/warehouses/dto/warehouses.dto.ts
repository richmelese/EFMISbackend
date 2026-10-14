import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsISO8601, IsLatitude, IsLongitude, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Length, Matches, MaxLength, Min,
  MinLength, NotEquals, ValidateIf
} from 'class-validator';

export const WAREHOUSE_KINDS = ['CENTRAL_HUB', 'REGIONAL_DEPOT', 'UNION_STORE', 'PC_STORE', 'PORT'] as const;
export const WAREHOUSE_STATUSES = ['ACTIVE', 'INACTIVE', 'MAINTENANCE'] as const;
/** Ledger types a user may post manually (system types come from the shipment / trip / delivery flows). */
export const MANUAL_TX_TYPES = ['RECEIPT', 'ADJUSTMENT', 'RETURN', 'DAMAGE', 'TRANSFER'] as const;
export const LEDGER_TYPES = [
  'RECEIPT', 'DISPATCH', 'RESERVE', 'RELEASE', 'ADJUSTMENT', 'RETURN', 'DAMAGE', 'DELIVERY_RECEIPT', 'LOADING_DISCREPANCY', 'TRANSFER_IN', 'TRANSFER_OUT'
] as const;
export const REFERENCE_TYPES = ['SHIPMENT', 'TRIP', 'DELIVERY', 'MANUAL', 'FEED'] as const;

const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateWarehouseDto {
  @ApiProperty({ example: 'WH-MOJO' }) @Transform(upper) @IsString() @Length(2, 30) @Matches(/^[A-Z0-9][A-Z0-9_-]*$/, { message: 'code may contain A-Z, 0-9, - and _' }) code: string;
  @ApiProperty({ example: 'Mojo Central Mega-Hub' }) @Transform(trim) @IsString() @Length(3, 160) name: string;
  @ApiPropertyOptional({ enum: WAREHOUSE_KINDS, default: 'REGIONAL_DEPOT' }) @IsOptional() @IsIn(WAREHOUSE_KINDS as unknown as string[]) kind?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) address?: string;
  @ApiPropertyOptional({ example: 8.586 }) @ValidateIf(o => o.longitude !== undefined || o.latitude !== undefined) @IsLatitude() latitude?: number;
  @ApiPropertyOptional({ example: 39.12 }) @ValidateIf(o => o.longitude !== undefined || o.latitude !== undefined) @IsLongitude() longitude?: number;
  @ApiProperty({ example: 150000, description: 'Design capacity (MT), > 0' }) @IsNumber() @IsPositive() capacityMt: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) regionId?: string;
  @ApiPropertyOptional({ enum: WAREHOUSE_STATUSES }) @IsOptional() @IsIn(WAREHOUSE_STATUSES as unknown as string[]) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sort?: number;
}

export class UpdateWarehouseDto {
  @ApiPropertyOptional() @IsOptional() @Transform(upper) @IsString() @Length(2, 30) @Matches(/^[A-Z0-9][A-Z0-9_-]*$/) code?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(3, 160) name?: string;
  @ApiPropertyOptional({ enum: WAREHOUSE_KINDS }) @IsOptional() @IsIn(WAREHOUSE_KINDS as unknown as string[]) kind?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @ApiPropertyOptional() @ValidateIf(o => o.longitude !== undefined || o.latitude !== undefined) @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @ValidateIf(o => o.longitude !== undefined || o.latitude !== undefined) @IsLongitude() longitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @IsPositive() capacityMt?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) regionId?: string | null;
  @ApiPropertyOptional({ enum: WAREHOUSE_STATUSES }) @IsOptional() @IsIn(WAREHOUSE_STATUSES as unknown as string[]) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sort?: number;
  @ApiPropertyOptional({ description: 'Reason recorded in the audit trail' }) @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class WarehouseQueryDto {
  @ApiPropertyOptional({ enum: WAREHOUSE_KINDS }) @IsOptional() @IsIn(WAREHOUSE_KINDS as unknown as string[]) kind?: string;
  @ApiPropertyOptional({ enum: WAREHOUSE_STATUSES }) @IsOptional() @IsIn(WAREHOUSE_STATUSES as unknown as string[]) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() regionId?: string;
  @ApiPropertyOptional({ description: 'Search code / name' }) @IsOptional() @IsString() q?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) pageSize?: number;
}

export class CreateProductDto {
  @ApiProperty({ example: 'NPSB' }) @Transform(upper) @IsString() @Length(2, 30) @Matches(/^[A-Z0-9][A-Z0-9_-]*$/, { message: 'sku may contain A-Z, 0-9, - and _' }) sku: string;
  @ApiProperty({ example: 'NPSB Granular (50 kg bags)' }) @Transform(trim) @IsString() @Length(2, 160) name: string;
  @ApiPropertyOptional({ default: 'MT' }) @IsOptional() @IsString() @MaxLength(10) unit?: string;
  @ApiPropertyOptional({ default: 'BAGGED_FERTILIZER' }) @IsOptional() @Transform(upper) @IsString() @MaxLength(30) cargoType?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() active?: boolean;
}

export class ProductQueryDto {
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value)) @IsBoolean() active?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) pageSize?: number;
}

/**
 * Manual inventory movement. quantity (> 0) for RECEIPT / RETURN / DAMAGE / TRANSFER; signed onHandDelta (≠ 0) for ADJUSTMENT.
 * TRANSFER moves stock from warehouseId to toWarehouseId (TRANSFER_OUT + TRANSFER_IN in one transaction).
 * notes are mandatory for ADJUSTMENT and DAMAGE.
 */
export class CreateInventoryTransactionDto {
  @ApiProperty({ enum: MANUAL_TX_TYPES }) @IsIn(MANUAL_TX_TYPES as unknown as string[]) type: (typeof MANUAL_TX_TYPES)[number];
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiProperty() @IsUUID() productId: string;
  @ApiPropertyOptional({ description: 'MT, > 0 (not used for ADJUSTMENT)' })
  @ValidateIf(o => o.type !== 'ADJUSTMENT') @IsNumber() @IsPositive() quantity?: number;
  @ApiPropertyOptional({ description: 'ADJUSTMENT only: signed change of on-hand stock (MT)' })
  @ValidateIf(o => o.type === 'ADJUSTMENT') @IsNumber() @NotEquals(0) onHandDelta?: number;
  @ApiPropertyOptional({ description: 'TRANSFER only: destination warehouse' })
  @ValidateIf(o => o.type === 'TRANSFER') @IsUUID() toWarehouseId?: string;
  @ApiPropertyOptional({ enum: REFERENCE_TYPES }) @IsOptional() @IsIn(REFERENCE_TYPES as unknown as string[]) referenceType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) referenceId?: string;
  @ApiPropertyOptional({ description: 'Required for ADJUSTMENT and DAMAGE' })
  @ValidateIf(o => o.type === 'ADJUSTMENT' || o.type === 'DAMAGE' || o.notes !== undefined) @IsString() @MinLength(3) @MaxLength(2000) notes?: string;
  @ApiPropertyOptional({ description: 'Lot / QR batch. RECEIPT/RETURN/positive ADJUSTMENT: lot to add to (generated when omitted). DAMAGE/TRANSFER/negative ADJUSTMENT: lot to take from (first-expiry-first-out when omitted)' })
  @IsOptional() @IsString() @MinLength(2) @MaxLength(64) @Matches(/^[A-Za-z0-9._/-]+$/, { message: 'lotNumber may contain letters, digits and . _ / -' }) lotNumber?: string;
  @ApiPropertyOptional({ description: 'RECEIPT: lot expiry date (YYYY-MM-DD)' }) @IsOptional() @IsISO8601({ strict: true }) expiryDate?: string;
  @ApiPropertyOptional({ enum: ['PASSED', 'PENDING'], description: 'RECEIPT: PENDING keeps the lot unusable until quality control passes it (default PASSED)' })
  @IsOptional() @IsIn(['PASSED', 'PENDING']) qcStatus?: 'PASSED' | 'PENDING';
}

export class LotQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional({ description: 'PASSED, PENDING, HELD, REJECTED (comma-separated)' }) @IsOptional() @IsString() qcStatus?: string;
  @ApiPropertyOptional({ description: 'Include lots with no stock' }) @IsOptional() @IsIn(['true', 'false']) includeEmpty?: string;
}

export class LotQcDto {
  @ApiProperty({ enum: ['PASSED', 'PENDING', 'HELD', 'REJECTED'] }) @IsIn(['PASSED', 'PENDING', 'HELD', 'REJECTED']) status: 'PASSED' | 'PENDING' | 'HELD' | 'REJECTED';
  @ApiPropertyOptional({ description: 'ECAE certificate of conformity / lab report no.' }) @IsOptional() @IsString() @MaxLength(80) reference?: string;
  @ApiPropertyOptional() @ValidateIf(o => o.status === 'HELD' || o.status === 'REJECTED' || o.notes !== undefined) @IsString() @MinLength(3) @MaxLength(2000) notes?: string;
}

export class InventoryTxQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional({ enum: LEDGER_TYPES, description: 'One type or a comma-separated list' }) @IsOptional() @IsString() type?: string;
  @ApiPropertyOptional({ enum: REFERENCE_TYPES }) @IsOptional() @IsString() referenceType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() referenceId?: string;
  @ApiPropertyOptional({ description: 'ISO 8601' }) @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional({ description: 'ISO 8601' }) @IsOptional() @IsISO8601() to?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) pageSize?: number;
}

export class DiscrepancyQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional({ description: 'ISO 8601' }) @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional({ description: 'ISO 8601' }) @IsOptional() @IsISO8601() to?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) pageSize?: number;
}
