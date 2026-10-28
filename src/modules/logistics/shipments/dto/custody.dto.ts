import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn, IsInt, IsISO8601, IsLatitude, IsLongitude, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf
} from 'class-validator';
import { PageQueryDto } from '../../../../common/dto/pagination.dto';

export const SCAN_TYPES = ['DISPATCH_ORIGIN', 'CHECKPOINT', 'HANDOVER', 'RECEIVE_DESTINATION'] as const;
export const INCIDENT_TYPES = ['THEFT', 'DIVERSION', 'ROBBERY', 'TAMPERING', 'ACCIDENT', 'UNAUTHORIZED_STOP', 'OTHER'] as const;
export const SECURITY_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export const INCIDENT_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'] as const;

export class CreateScanDto {
  @ApiProperty({ enum: SCAN_TYPES }) @IsIn(SCAN_TYPES as unknown as string[]) scanType: (typeof SCAN_TYPES)[number];
  @ApiProperty({ description: 'Scanned QR code / lot number', example: 'LOT-NPS-2026-0042' })
  @IsString() @MinLength(2) @MaxLength(64) @Matches(/^[A-Za-z0-9._\/-]+$/, { message: 'lotNumber may contain letters, digits and . _ / -' }) lotNumber: string;
  @ApiPropertyOptional({ description: 'Bags counted at this point' }) @IsOptional() @IsInt() @Min(0) @Max(100000) bagCount?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) deviceSerial?: string;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() lng?: number;
  @ApiPropertyOptional({ example: 'Awash weighbridge' }) @IsOptional() @IsString() @MaxLength(160) locationLabel?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiPropertyOptional({ description: 'Client-generated id; resending the same id returns the stored scan (offline scanners)' })
  @IsOptional() @IsString() @MaxLength(80) clientScanId?: string;
  @ApiPropertyOptional({ description: 'Device time of the scan (ISO 8601); default now' }) @IsOptional() @IsISO8601() scannedAt?: string;
}

export class ListIncidentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Status or comma-separated statuses' }) @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional({ enum: INCIDENT_TYPES }) @IsOptional() @IsIn(INCIDENT_TYPES as unknown as string[]) incidentType?: string;
  @ApiPropertyOptional({ description: 'Severity or comma-separated severities' }) @IsOptional() @IsString() severity?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() shipmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() tripId?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}

export class CreateIncidentDto {
  @ApiProperty({ enum: INCIDENT_TYPES }) @IsIn(INCIDENT_TYPES as unknown as string[]) incidentType: (typeof INCIDENT_TYPES)[number];
  @ApiPropertyOptional({ enum: SECURITY_SEVERITIES, description: 'Default by type: theft/diversion/robbery/tampering CRITICAL, accident HIGH, otherwise MEDIUM' })
  @IsOptional() @IsIn(SECURITY_SEVERITIES as unknown as string[]) severity?: string;
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(4000) description: string;
  @ApiPropertyOptional({ description: 'ISO 8601; default now' }) @IsOptional() @IsISO8601() occurredAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() shipmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() tripId?: string;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() lng?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) locationLabel?: string;
  @ApiPropertyOptional({ description: 'MT lost / affected' }) @IsOptional() @IsNumber() @IsPositive() quantityAffectedMt?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) policeReportNo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) policeStation?: string;
}

export class UpdateIncidentDto {
  @ApiPropertyOptional({ enum: SECURITY_SEVERITIES }) @IsOptional() @IsIn(SECURITY_SEVERITIES as unknown as string[]) severity?: string;
  @ApiPropertyOptional({ enum: ['OPEN', 'INVESTIGATING'] }) @IsOptional() @IsIn(['OPEN', 'INVESTIGATING']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(10) @MaxLength(4000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @IsPositive() quantityAffectedMt?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) policeReportNo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) policeStation?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) locationLabel?: string;
}

export class ResolveIncidentDto {
  @ApiProperty({ example: 'Cargo recovered by Federal Police; 0.4 MT lost; driver cleared' }) @IsString() @MinLength(10) @MaxLength(4000) resolution: string;
  @ApiPropertyOptional() @ValidateIf(o => o.policeReportNo !== undefined) @IsString() @MaxLength(64) policeReportNo?: string;
}
