import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsLatitude, IsLongitude, IsNotEmpty, IsNumber,
  IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested
} from 'class-validator';
import { ToBool } from './shipment.dto';

export const TRIP_EVENT_TYPES = ['INCIDENT', 'DELAY', 'STOP', 'COMMUNICATION', 'NOTE'];
export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export class ListTripsQueryDto {
  @ApiPropertyOptional({ description: 'Status or comma-separated statuses' }) @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() truckId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() driverId?: string;
  @ApiPropertyOptional({ description: 'Only trips in an active state' }) @IsOptional() @ToBool() @IsBoolean() active?: boolean;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 50, maximum: 200 }) @IsOptional() @IsInt() @Min(1) @Max(200) pageSize?: number;
}

export class CreateTripDto {
  @ApiProperty({ type: [String], description: 'Shipments (PLANNED, same origin warehouse); order = stop sequence' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ArrayUnique() @IsUUID('all', { each: true })
  shipmentIds: string[];
  @ApiProperty() @IsUUID() truckId: string;
  @ApiProperty() @IsUUID() driverId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() routeId?: string;
  @ApiProperty({ example: '2026-10-14T06:00:00Z' }) @IsDateString() plannedStartAt: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @ToBool() @IsBoolean() requiresDriverAcceptance?: boolean;
  @ApiPropertyOptional({ default: true }) @IsOptional() @ToBool() @IsBoolean() requiresTracking?: boolean;
}

export class ReassignTripDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() driverId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() truckId?: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(1000) reason: string;
}

export class ChecklistItemDto {
  @ApiProperty({ example: 'Brakes' }) @IsString() @IsNotEmpty() @MaxLength(120) item: string;
  @ApiProperty() @IsBoolean() ok: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ChecklistDto {
  @ApiProperty({ type: [ChecklistItemDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ChecklistItemDto)
  items: ChecklistItemDto[];
  @ApiProperty({ description: 'Driver acknowledges trip details, cargo and route' }) @IsBoolean() driverAcknowledged: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) odometerKm?: number;
}

export class LoadingLineDto {
  @ApiProperty() @IsUUID() shipmentId: string;
  @ApiProperty({ example: 20 }) @IsNumber() @Min(0) loadedQuantity: number;
}

export class LoadingDto {
  @ApiProperty({ type: [LoadingLineDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => LoadingLineDto)
  lines: LoadingLineDto[];
}

export class IncidentDto {
  @ApiProperty({ enum: TRIP_EVENT_TYPES }) @IsIn(TRIP_EVENT_TYPES) type: string;
  @ApiPropertyOptional({ enum: INCIDENT_SEVERITIES }) @IsOptional() @IsIn(INCIDENT_SEVERITIES) severity?: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(2000) description: string;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() lng?: number;
}

export class TripReasonDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(1000) reason: string;
}
