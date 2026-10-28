import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDate, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, MinLength
} from 'class-validator';
import { PageQueryDto, PageQueryDto1000 } from '../../../../common/dto/pagination.dto';

export const OWNERSHIP_TYPES = ['ESLSE', 'EABC', 'PRIVATE_TRANSPORTER', 'UNION'] as const;
export const CONNECTIVITY_FILTERS = ['ONLINE', 'STALE', 'OFFLINE', 'NEVER_SEEN', 'NO_DEVICE'] as const;
export const DEVICE_STATUSES = ['REGISTERED', 'ACTIVE', 'RETIRED'] as const;

// ---------------- Vehicle types ----------------
export class CreateVehicleTypeDto {
  @ApiProperty({ example: 'HGV-40' }) @IsString() @Length(2, 30) @Matches(/^[A-Za-z0-9_-]+$/) code: string;
  @ApiProperty({ example: 'Heavy goods vehicle (40 MT trailer)' }) @IsString() @Length(2, 120) name: string;
  @ApiProperty({ example: 40 }) @IsNumber() @IsPositive() @Max(1000) maxCapacityValue: number;
  @ApiPropertyOptional({ default: 'MT' }) @IsOptional() @IsString() @MaxLength(10) capacityUnit?: string;
  @ApiPropertyOptional({ example: ['C', 'CE'] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(10, { each: true }) allowedLicenceClasses?: string[];
  @ApiPropertyOptional({ example: ['BAGGED_FERTILIZER'] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) cargoTypes?: string[];
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateVehicleTypeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @IsPositive() @Max(1000) maxCapacityValue?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10) capacityUnit?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(10, { each: true }) allowedLicenceClasses?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) cargoTypes?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}

export class VehicleTypeListQuery extends PageQueryDto {
  @IsOptional() @IsString() active?: string;
}

// ---------------- Trucks ----------------
export class CreateTruckDto {
  @ApiProperty({ example: 'ESLSE-TRK-8819' }) @IsString() @Length(2, 40) @Matches(/^[A-Za-z0-9_-]+$/) fleetCode: string;
  @ApiProperty({ example: '3-A12345' }) @IsString() @Length(2, 30) plateNumber: string;
  @ApiProperty() @IsUUID() vehicleTypeId: string;
  @ApiProperty({ example: 40 }) @IsNumber() @IsPositive() capacityValue: number;
  @ApiPropertyOptional({ default: 'MT' }) @IsOptional() @IsString() @MaxLength(10) capacityUnit?: string;
  @ApiPropertyOptional({ enum: OWNERSHIP_TYPES, default: 'ESLSE' }) @IsOptional() @IsIn(OWNERSHIP_TYPES) ownership?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) transporterName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateTruckDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 40) @Matches(/^[A-Za-z0-9_-]+$/) fleetCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 30) plateNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleTypeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @IsPositive() capacityValue?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10) capacityUnit?: string;
  @ApiPropertyOptional({ enum: OWNERSHIP_TYPES }) @IsOptional() @IsIn(OWNERSHIP_TYPES) ownership?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) transporterName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class TruckStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'MAINTENANCE', 'OUT_OF_SERVICE'] }) @IsIn(['ACTIVE', 'MAINTENANCE', 'OUT_OF_SERVICE']) operationalStatus: 'ACTIVE' | 'MAINTENANCE' | 'OUT_OF_SERVICE';
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class TruckListQuery extends PageQueryDto {
  @ApiPropertyOptional({ description: 'operationalStatus' }) @IsOptional() @IsIn(['ACTIVE', 'MAINTENANCE', 'OUT_OF_SERVICE']) status?: string;
  @ApiPropertyOptional({ description: 'availabilityStatus' }) @IsOptional() @IsIn(['AVAILABLE', 'RESERVED', 'ON_TRIP']) availability?: string;
  @ApiPropertyOptional({ enum: CONNECTIVITY_FILTERS }) @IsOptional() @IsIn(CONNECTIVITY_FILTERS) connectivity?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleTypeId?: string;
  @ApiPropertyOptional({ description: 'search fleet code / plate number' }) @IsOptional() @IsString() @MaxLength(60) q?: string;
}

export class TruckEligibleQuery {
  @ApiProperty({ description: 'Planned quantity (MT) to carry', example: 20 }) @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
  @ApiPropertyOptional({ example: 'BAGGED_FERTILIZER' }) @IsOptional() @IsString() @MaxLength(40) cargoType?: string;
  @ApiPropertyOptional({ description: 'Require an ACTIVE, reporting GPS device (default true)', default: 'true' }) @IsOptional() @IsIn(['true', 'false']) requiresTracking?: string;
  @ApiPropertyOptional({ description: 'Trip being (re)validated — its own booking is ignored' }) @IsOptional() @IsUUID() excludeTripId?: string;
}

export class LocationHistoryQuery extends PageQueryDto1000 {
  @ApiPropertyOptional({ description: 'ISO 8601' }) @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @ApiPropertyOptional({ description: 'ISO 8601' }) @IsOptional() @Type(() => Date) @IsDate() to?: Date;
  @ApiPropertyOptional({ description: 'Opaque cursor returned as nextCursor (keyset pagination)' }) @IsOptional() @IsString() @MaxLength(200) cursor?: string;
}

// ---------------- GPS devices ----------------
export class CreateGpsDeviceDto {
  @ApiPropertyOptional({ default: 'TRACCAR' }) @IsOptional() @IsString() @Length(2, 20) @Matches(/^[A-Za-z0-9_]+$/) provider?: string;
  @ApiProperty({ description: 'Device unique id as known by the GPS platform (Traccar uniqueId)' }) @IsString() @Length(1, 60) providerDeviceId: string;
  @ApiPropertyOptional({ description: '15-digit IMEI (restricted)' }) @IsOptional() @Matches(/^\d{15}$/, { message: 'imei must be exactly 15 digits' }) imei?: string;
  @ApiPropertyOptional({ example: 'Teltonika FMB920' }) @IsOptional() @IsString() @MaxLength(60) model?: string;
  @ApiPropertyOptional({ description: 'SIM / MSISDN (restricted)' }) @IsOptional() @Matches(/^\+?\d{6,19}$/, { message: 'simNumber must be 6-19 digits' }) simNumber?: string;
}

export class UpdateGpsDeviceDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 60) providerDeviceId?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{15}$/, { message: 'imei must be exactly 15 digits' }) imei?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) model?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\+?\d{6,19}$/, { message: 'simNumber must be 6-19 digits' }) simNumber?: string;
}

export class AssignDeviceDto {
  @ApiProperty() @IsUUID() truckId: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class UnassignDeviceDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @ApiPropertyOptional({ description: 'ADMIN only: unpair even while the truck is on a trip' }) @IsOptional() @IsBoolean() force?: boolean;
}

export class RetireDeviceDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class GpsDeviceListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: DEVICE_STATUSES }) @IsOptional() @IsIn(DEVICE_STATUSES) status?: string;
  @ApiPropertyOptional({ enum: ['ONLINE', 'STALE', 'OFFLINE', 'NEVER_SEEN'] }) @IsOptional() @IsIn(['ONLINE', 'STALE', 'OFFLINE', 'NEVER_SEEN']) connectivity?: string;
  @ApiPropertyOptional({ description: 'true | false' }) @IsOptional() @IsIn(['true', 'false']) assigned?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) q?: string;
}
