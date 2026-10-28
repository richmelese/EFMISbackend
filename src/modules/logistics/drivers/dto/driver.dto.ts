import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsDateString, IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min,
  MinLength, ValidateIf, ValidateNested
} from 'class-validator';
import { PageQueryDto } from '../../../../common/dto/pagination.dto';

/** Ethiopian mobile numbers: 09xxxxxxxx (Ethio telecom) / 07xxxxxxxx (Safaricom) */
export const ET_PHONE = /^0[79]\d{8}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const LICENCE_CLASSES = ['A', 'B', 'C1', 'C', 'CE', 'D'] as const;
export const DOCUMENT_TYPES = ['LICENCE', 'NATIONAL_ID', 'CERTIFICATE', 'MEDICAL', 'OTHER'] as const;
export const AVAILABILITY_TYPES = ['SHIFT', 'LEAVE', 'UNAVAILABLE', 'TRAINING'] as const;
export const DRIVER_LIST_FILTERS = ['available', 'assigned', 'on_trip', 'document_expiring', 'unverified', 'inactive', 'suspended'] as const;
/** Employment states settable via create/PATCH (SUSPENDED only through POST /drivers/:id/suspend) */
export const EDITABLE_EMPLOYMENT = ['ACTIVE', 'INACTIVE', 'ON_LEAVE'] as const;

export class ListDriversQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: DRIVER_LIST_FILTERS }) @IsOptional() @IsIn(DRIVER_LIST_FILTERS as unknown as string[]) status?: string;
  @ApiPropertyOptional({ description: 'Search name / employee number / phone' }) @IsOptional() @IsString() @MaxLength(80) q?: string;
}

export class CertificationDto {
  @ApiProperty({ example: 'Hazardous goods handling' }) @IsString() @Length(1, 120) name: string;
  @ApiPropertyOptional({ example: '2027-06-30' }) @IsOptional() @Matches(YMD, { message: 'expiresAt must be YYYY-MM-DD' }) @IsDateString() expiresAt?: string | null;
}

export class CreateDriverDto {
  @ApiProperty({ example: 'ESLSE-DRV-0101' }) @IsString() @Length(1, 40) employeeNumber: string;
  @ApiProperty({ example: 'Abebe' }) @IsString() @Length(1, 80) firstName: string;
  @ApiProperty({ example: 'Kebede' }) @IsString() @Length(1, 80) lastName: string;
  @ApiProperty({ example: '0911223344' }) @Matches(ET_PHONE, { message: 'phone must be an Ethiopian mobile number (09xxxxxxxx or 07xxxxxxxx)' }) phone: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(160) email?: string | null;
  @ApiProperty({ example: 'AA-123456' }) @IsString() @Length(4, 40) licenceNumber: string;
  @ApiProperty({ enum: LICENCE_CLASSES }) @IsIn(LICENCE_CLASSES as unknown as string[]) licenceClass: string;
  @ApiProperty({ example: '2028-01-31' }) @Matches(YMD, { message: 'licenceExpiryDate must be YYYY-MM-DD' }) @IsDateString() licenceExpiryDate: string;
  @ApiPropertyOptional({ type: [CertificationDto] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => CertificationDto) certifications?: CertificationDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) emergencyContactName?: string | null;
  @ApiPropertyOptional() @IsOptional() @Matches(ET_PHONE, { message: 'emergencyContactPhone must be an Ethiopian mobile number' }) emergencyContactPhone?: string | null;
  @ApiPropertyOptional({ example: 'ESLSE' }) @IsOptional() @IsString() @MaxLength(120) employer?: string | null;
  @ApiPropertyOptional({ enum: EDITABLE_EMPLOYMENT, default: 'ACTIVE' }) @IsOptional() @IsIn(EDITABLE_EMPLOYMENT as unknown as string[]) employmentStatus?: string;
}

export class UpdateDriverDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 40) employeeNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(ET_PHONE, { message: 'phone must be an Ethiopian mobile number (09xxxxxxxx or 07xxxxxxxx)' }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(160) email?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(4, 40) licenceNumber?: string;
  @ApiPropertyOptional({ enum: LICENCE_CLASSES }) @IsOptional() @IsIn(LICENCE_CLASSES as unknown as string[]) licenceClass?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(YMD, { message: 'licenceExpiryDate must be YYYY-MM-DD' }) @IsDateString() licenceExpiryDate?: string;
  @ApiPropertyOptional({ type: [CertificationDto] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => CertificationDto) certifications?: CertificationDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) emergencyContactName?: string | null;
  @ApiPropertyOptional() @IsOptional() @Matches(ET_PHONE, { message: 'emergencyContactPhone must be an Ethiopian mobile number' }) emergencyContactPhone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) employer?: string | null;
  @ApiPropertyOptional({ enum: EDITABLE_EMPLOYMENT }) @IsOptional() @IsIn(EDITABLE_EMPLOYMENT as unknown as string[]) employmentStatus?: string;
  @ApiPropertyOptional({ description: 'Link (string) or unlink (null) a DRIVER login account', nullable: true })
  @ValidateIf(o => o.userId !== null && o.userId !== undefined) @IsString() @Length(1, 40) userId?: string | null;
  @ApiPropertyOptional({ description: 'Reason for the change (audit)' }) @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class UploadDriverDocumentDto {
  @ApiProperty({ enum: DOCUMENT_TYPES }) @IsIn(DOCUMENT_TYPES as unknown as string[]) documentType: string;
  @ApiPropertyOptional({ example: '2024-01-31' }) @IsOptional() @Matches(YMD, { message: 'issuedAt must be YYYY-MM-DD' }) @IsDateString() issuedAt?: string;
  @ApiPropertyOptional({ example: '2028-01-31' }) @IsOptional() @Matches(YMD, { message: 'expiresAt must be YYYY-MM-DD' }) @IsDateString() expiresAt?: string;
}

export class DocumentVerificationDto {
  @ApiProperty({ enum: ['VERIFIED', 'REJECTED'] }) @IsIn(['VERIFIED', 'REJECTED']) status: 'VERIFIED' | 'REJECTED';
  @ApiPropertyOptional({ description: 'Required when REJECTED' })
  @ValidateIf(o => o.status === 'REJECTED' || o.reason !== undefined) @IsString() @IsNotEmpty({ message: 'reason is required when rejecting a document' }) @MaxLength(500) reason?: string;
}

export class VerifyDriverDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class SuspendDriverDto {
  @ApiProperty({ example: 'Pending investigation of incident TR-1001' }) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class ReactivateDriverDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class AvailabilityQueryDto {
  @ApiPropertyOptional({ description: 'ISO 8601 (default now)' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ description: 'ISO 8601 (default from + 24h)' }) @IsOptional() @IsDateString() to?: string;
}

export class CreateAvailabilityDto {
  @ApiProperty({ example: '2026-11-01T06:00:00Z' }) @IsDateString() startAt: string;
  @ApiProperty({ example: '2026-11-05T18:00:00Z' }) @IsDateString() endAt: string;
  @ApiProperty({ enum: AVAILABILITY_TYPES }) @IsIn(AVAILABILITY_TYPES as unknown as string[]) availabilityType: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class EligibleQueryDto extends AvailabilityQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleTypeId?: string;
  @ApiPropertyOptional({ description: 'Trip being (re)validated — its own assignment is ignored' }) @IsOptional() @IsUUID() excludeTripId?: string;
}

export class ExpiringQueryDto {
  @ApiPropertyOptional({ description: 'Window in days (default logisticsThresholds.documentExpiryWarningDays)' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
}

export class PerformanceQueryDto {
  @ApiPropertyOptional({ description: 'ISO 8601 — trips completed from' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ description: 'ISO 8601 — trips completed until' }) @IsOptional() @IsDateString() to?: string;
}
