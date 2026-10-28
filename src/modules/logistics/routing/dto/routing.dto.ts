import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, IsUUID,
  Matches, Max, MaxLength, Min, MinLength
} from 'class-validator';
import { PageQueryDto } from '../../../../common/dto/pagination.dto';

export const GEOFENCE_KINDS = ['WAREHOUSE', 'DEPOT', 'CHECKPOINT', 'BORDER', 'PORT', 'RESTRICTED'] as const;
export const GEOFENCE_SHAPES = ['CIRCLE', 'POLYGON'] as const;
export const GEOFENCE_MIN_RADIUS_M = 50;
export const GEOFENCE_MAX_RADIUS_M = 50_000;

// ---------------- Routes ----------------

export class CreateRouteDto {
  @ApiProperty({ example: 'DJI-ADM-01' }) @IsString() @Matches(/^[A-Za-z0-9._-]{2,40}$/, { message: 'code must be 2-40 chars of letters, digits, . _ -' }) code: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(200) name: string;
  @ApiProperty() @IsUUID() originWarehouseId: string;
  @ApiProperty() @IsUUID() destinationWarehouseId: string;
  @ApiPropertyOptional({ description: 'Polyline [[lat, lng], ...]; computed through the routing provider when omitted', type: 'array', items: { type: 'array', items: { type: 'number' } } })
  @IsOptional() @IsArray() @ArrayMinSize(2) @ArrayMaxSize(20000) geometry?: Array<[number, number]>;
  @ApiPropertyOptional({ description: 'Route-deviation corridor half-width (km)', default: 2 })
  @IsOptional() @IsNumber() @Min(0.1) @Max(100) corridorWidthKm?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) distanceKm?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) estimatedDurationMin?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) providerReference?: string;
}

export class UpdateRouteDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(3) @MaxLength(200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.1) @Max(100) corridorWidthKm?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional({ type: 'array', items: { type: 'array', items: { type: 'number' } } })
  @IsOptional() @IsArray() @ArrayMinSize(2) @ArrayMaxSize(20000) geometry?: Array<[number, number]>;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) distanceKm?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) estimatedDurationMin?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) providerReference?: string;
  @ApiPropertyOptional({ description: 'Recompute geometry/distance/duration through the routing provider' })
  @IsOptional() @IsBoolean() recompute?: boolean;
}

export class RouteListQuery extends PageQueryDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsIn(['true', 'false']) active?: string;
  @IsOptional() @IsUUID() originWarehouseId?: string;
  @IsOptional() @IsUUID() destinationWarehouseId?: string;
}

export class CreateMilestoneDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(160) name: string;
  @ApiPropertyOptional({ description: 'Order on the route (defaults to last + 1)' })
  @IsOptional() @IsInt() @Min(1) @Max(1000) sequence?: number;
  @ApiPropertyOptional({ description: 'Existing geofence; otherwise lat/lng (+radiusM) creates a CHECKPOINT circle geofence' })
  @IsOptional() @IsUUID() geofenceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() lng?: number;
  @ApiPropertyOptional({ default: 500, minimum: GEOFENCE_MIN_RADIUS_M, maximum: GEOFENCE_MAX_RADIUS_M })
  @IsOptional() @IsNumber() @Min(GEOFENCE_MIN_RADIUS_M) @Max(GEOFENCE_MAX_RADIUS_M) radiusM?: number;
  @ApiProperty({ description: 'Expected minutes after trip start' }) @IsInt() @Min(0) @Max(60 * 24 * 30) expectedOffsetMin: number;
  @ApiPropertyOptional({ default: 60 }) @IsOptional() @IsInt() @Min(0) @Max(60 * 24 * 7) toleranceMin?: number;
}


export class EstimateDto {
  @ApiProperty({ example: [9.03, 38.74], description: '[lat, lng]' })
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(2) @IsNumber({}, { each: true }) origin: [number, number];
  @ApiProperty({ example: [11.59, 37.39], description: '[lat, lng]' })
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(2) @IsNumber({}, { each: true }) destination: [number, number];
}

// ---------------- Geofences ----------------

export class CreateGeofenceDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(160) name: string;
  @ApiProperty({ enum: GEOFENCE_KINDS }) @IsIn(GEOFENCE_KINDS as unknown as string[]) kind: string;
  @ApiProperty({ enum: GEOFENCE_SHAPES }) @IsIn(GEOFENCE_SHAPES as unknown as string[]) shape: 'CIRCLE' | 'POLYGON';
  @ApiPropertyOptional() @IsOptional() @IsLatitude() centerLat?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() centerLng?: number;
  @ApiPropertyOptional({ minimum: GEOFENCE_MIN_RADIUS_M, maximum: GEOFENCE_MAX_RADIUS_M })
  @IsOptional() @IsNumber() @Min(GEOFENCE_MIN_RADIUS_M) @Max(GEOFENCE_MAX_RADIUS_M) radiusM?: number;
  @ApiPropertyOptional({ description: 'Ring of [lat, lng] (≥ 3 points)', type: 'array', items: { type: 'array', items: { type: 'number' } } })
  @IsOptional() @IsArray() @ArrayMinSize(3) @ArrayMaxSize(5000) polygon?: Array<[number, number]>;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() alertOnEnter?: boolean;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() alertOnExit?: boolean;
  @ApiPropertyOptional({ default: 2, description: 'Hysteresis: agreeing positions required to confirm a transition' })
  @IsOptional() @IsInt() @Min(1) @Max(20) minConsecutivePoints?: number;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateGeofenceDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(160) name?: string;
  @ApiPropertyOptional({ enum: GEOFENCE_KINDS }) @IsOptional() @IsIn(GEOFENCE_KINDS as unknown as string[]) kind?: string;
  @ApiPropertyOptional({ enum: GEOFENCE_SHAPES }) @IsOptional() @IsIn(GEOFENCE_SHAPES as unknown as string[]) shape?: 'CIRCLE' | 'POLYGON';
  @ApiPropertyOptional() @IsOptional() @IsLatitude() centerLat?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() centerLng?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(GEOFENCE_MIN_RADIUS_M) @Max(GEOFENCE_MAX_RADIUS_M) radiusM?: number;
  @ApiPropertyOptional({ type: 'array', items: { type: 'array', items: { type: 'number' } } })
  @IsOptional() @IsArray() @ArrayMinSize(3) @ArrayMaxSize(5000) polygon?: Array<[number, number]>;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() warehouseId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() alertOnEnter?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() alertOnExit?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(20) minConsecutivePoints?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}

export class GeofenceListQuery extends PageQueryDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsIn(GEOFENCE_KINDS as unknown as string[]) kind?: string;
  @IsOptional() @IsIn(['true', 'false']) active?: string;
  @IsOptional() @IsUUID() warehouseId?: string;
}

export class GeofenceEventsQuery extends PageQueryDto {
  @IsOptional() @IsUUID() truckId?: string;
  @IsOptional() @IsUUID() tripId?: string;
  @IsOptional() @IsIn(['ENTERED', 'EXITED']) type?: string;
}

export class TripEtaQuery {
  @IsOptional() @IsIn(['true', 'false']) refresh?: string;
}

