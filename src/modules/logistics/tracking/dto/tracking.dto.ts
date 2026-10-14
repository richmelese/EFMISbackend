import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsDate, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested
} from 'class-validator';

export class SimulatedPointDto {
  @ApiProperty({ example: 9.0108 }) @IsNumber() lat: number;
  @ApiProperty({ example: 38.7613 }) @IsNumber() lng: number;
  @ApiPropertyOptional({ example: 54 }) @IsOptional() @IsNumber() @Min(0) @Max(300) speedKmh?: number;
  @ApiPropertyOptional({ example: 90 }) @IsOptional() @IsNumber() @Min(0) @Max(360) heading?: number;
  @ApiPropertyOptional({ description: 'ISO 8601; default now + i seconds' }) @IsOptional() @Type(() => Date) @IsDate() recordedAt?: Date;
}

export class SimulateDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() truckId?: string;
  @ApiPropertyOptional({ example: 'ESLSE-TRK-8819' }) @IsOptional() @IsString() @Length(2, 40) fleetCode?: string;
  @ApiProperty({ type: [SimulatedPointDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => SimulatedPointDto) points: SimulatedPointDto[];
}

/** NormalizedPosition (tracking.types.ts) as a validated request body item. */
export class NormalizedPositionDto {
  @ApiPropertyOptional({ default: 'TRACCAR' }) @IsOptional() @IsString() @Length(2, 20) provider?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 60) providerDeviceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() truckId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) providerPositionId?: string;
  @ApiProperty() @IsNumber() latitude: number;
  @ApiProperty() @IsNumber() longitude: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() speedKmh?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() heading?: number;
  @ApiProperty({ description: 'ISO 8601 device fix time' }) @Type(() => Date) @IsDate() recordedAt: Date;
  @ApiPropertyOptional() @IsOptional() @IsObject() attributes?: Record<string, unknown>;
}

export class ActivePositionsQuery {
  @ApiPropertyOptional({ enum: ['ONLINE', 'STALE', 'OFFLINE', 'NEVER_SEEN', 'NO_DEVICE'] }) @IsOptional() @IsIn(['ONLINE', 'STALE', 'OFFLINE', 'NEVER_SEEN', 'NO_DEVICE']) connectivity?: string;
  @ApiPropertyOptional({ description: 'true → only trucks with an active trip' }) @IsOptional() @IsIn(['true', 'false']) onTrip?: string;
  @ApiPropertyOptional({ description: 'true | false — filter by stale position' }) @IsOptional() @IsIn(['true', 'false']) stale?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) q?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ maximum: 1000, default: 1000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) pageSize?: number;
}
