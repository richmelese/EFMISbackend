import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min, MinLength, ValidateNested
} from 'class-validator';
import { RULES } from '../../../common/constants/rules';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToUndefined = ({ value }: { value: unknown }) => {
  const v = typeof value === 'string' ? value.trim() : value;
  return v === '' || v === null ? undefined : v;
};

export class DemandLineDto {
  @ApiProperty({ enum: RULES.fertilizerTypes, example: 'NPSB' })
  @IsIn(RULES.fertilizerTypes)
  type: string;

  @ApiProperty({ example: 7.5, description: 'Requested quantity (quintals)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  requestedQtl: number;
}

export class GpsDto {
  @ApiProperty({ example: 8.5 }) @IsNumber() @Min(3) @Max(15) lat: number;
  @ApiProperty({ example: 39.27 }) @IsNumber() @Min(33) @Max(48) lng: number;
}

/** REQ-1.1-001 farmer registration (DA screen). Business-rule checks (phone format, farm size, name) run in the service. */
export class RegisterFarmerDto {
  @ApiProperty({ example: 'Abebe' }) @Transform(trim) @IsString() @MinLength(1) firstName: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() middleName?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() lastName?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() motherName?: string;
  @ApiPropertyOptional({ example: 'FAN-9482-1049-3821' }) @IsOptional() @Transform(trim) @IsString() faydaId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() nationalIdNumber?: string;
  @ApiProperty({ example: '0911223344' }) @Transform(trim) @IsString() phone: string;
  @ApiPropertyOptional() @Transform(emptyToUndefined) @IsOptional() @IsString() phoneSecondary?: string;
  @ApiPropertyOptional({ enum: RULES.genders }) @IsOptional() @IsIn(RULES.genders) gender?: string;
  @ApiPropertyOptional({ enum: RULES.ageGroups }) @IsOptional() @IsIn(RULES.ageGroups) ageGroup?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(40) householdSize?: number;
  @ApiPropertyOptional({ enum: RULES.educationLevels }) @IsOptional() @IsIn(RULES.educationLevels) educationLevel?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() primaryOccupation?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() cooperativeMember?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() cooperative?: string;
  @ApiPropertyOptional({ example: 'KEB-01' }) @IsOptional() @IsString() kebeleId?: string;
  @ApiProperty({ example: 'NRLAIS-OR-AD-99001-2025' }) @Transform(trim) @IsString() @MinLength(3) landCertNumber: string;
  @ApiProperty({ example: 3.75 }) @Type(() => Number) @IsNumber() farmSizeHa: number;
  @ApiPropertyOptional({ enum: RULES.landTenures }) @IsOptional() @IsIn(RULES.landTenures) landTenure?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() irrigationAccess?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() irrigationType?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) crops?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() targetCrop?: string;
  @ApiPropertyOptional({ example: 'Meher 2026' }) @IsOptional() @IsString() season?: string;
  @ApiPropertyOptional({ type: [DemandLineDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DemandLineDto) demands?: DemandLineDto[];
  @ApiPropertyOptional({ example: 7.5 }) @IsOptional() @Type(() => Number) @IsNumber() @Min(0) reqNpsb?: number;
  @ApiPropertyOptional({ example: 9 }) @IsOptional() @Type(() => Number) @IsNumber() @Min(0) reqUrea?: number;
  @ApiPropertyOptional({ type: GpsDto }) @IsOptional() @ValidateNested() @Type(() => GpsDto) gps?: GpsDto;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() consent?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() clientUuid?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() deviceId?: string;
  @ApiPropertyOptional({ example: '2026-08-25 08:00:00' }) @IsOptional() @IsString() clientTimestamp?: string;
}

/** Editable fields of a pending record (identity, land certificate and kebele are fixed). */
export class UpdateFarmerDto extends PartialType(OmitType(RegisterFarmerDto, ['firstName', 'landCertNumber', 'faydaId', 'kebeleId'] as const)) {
  @ApiPropertyOptional({ description: 'Optimistic concurrency: the version last read by the client' })
  @IsOptional()
  @IsInt()
  version?: number;
}

export class DeleteFarmerDto {
  @ApiProperty({ example: 'Duplicate entry captured twice' }) @IsString() @MinLength(3) reason: string;
}

export class ListFarmersQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() kebeleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() woredaId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() regionId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() approvalLevel?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() season?: string;
  @ApiPropertyOptional({ description: 'Demand line status' }) @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() minRequestedQtl?: number;
  @ApiPropertyOptional({ enum: ['name', 'date', 'farmSize', 'id'] }) @IsOptional() @IsString() sort?: string;
  @ApiPropertyOptional({ enum: ['asc', 'desc'] }) @IsOptional() @IsString() order?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() page?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() pageSize?: number;
}

export class CheckDuplicateQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() faydaId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() landCertNumber?: string;
}

export class SyncRecordDto {
  @ApiProperty() @IsString() @MinLength(1) clientUuid: string;
  @ApiProperty({ enum: ['CREATE', 'UPDATE', 'DELETE'] }) @IsIn(['CREATE', 'UPDATE', 'DELETE']) operation: 'CREATE' | 'UPDATE' | 'DELETE';
  @ApiPropertyOptional() @IsOptional() @IsString() farmerId?: string;
  @ApiProperty({ example: '2026-08-25 08:00:00' }) @IsString() clientUpdatedAt: string;
  @ApiProperty({ description: 'sha256(JSON.stringify(data)), optionally prefixed "sha256:"' }) @IsString() checksum: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) @IsObject() data: Record<string, any>;
}

/** REQ-1.1-006 offline batch upload. */
export class SyncFarmersDto {
  @ApiProperty({ example: 'DEV-DA-01' }) @IsString() @MinLength(1) deviceId: string;
  @ApiProperty({ type: [SyncRecordDto] }) @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => SyncRecordDto) records: SyncRecordDto[];
}

/** Multipart fields accompanying the uploaded "file". */
export class UploadDocumentDto {
  @ApiPropertyOptional({ enum: RULES.documentTypes }) @IsOptional() @IsString() docType?: string;
  @ApiPropertyOptional({ example: 'true', description: 'Farmer consent for image storage and use (must be "true")' }) @IsOptional() @IsString() consent?: string;
}
