import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNumber, IsOptional, IsPositive, IsString, Matches, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Partial update of a Daily Fertilizer Summary record (all quantities in MT, >= 0). */
export class UpdateDailyRecordDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) procuredMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) regionalStockMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) dispatchedMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) portCumulativeMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) portDailyMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) currentRegionStockMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) deliveredToRegionMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) queueMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) hubThisWeekMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) hubCumulativeMT?: number;
}

export class CreateReportDateDto {
  @ApiProperty({ example: '04.04.2016', description: 'Ethiopian calendar dd.mm.yyyy' })
  @IsString() @Matches(/^\d{2}\.\d{2}\.\d{4}$/, { message: 'Use Ethiopian calendar dd.mm.yyyy' })
  id: string;

  @ApiPropertyOptional() @IsOptional() @IsString() label?: string;
}

export class DailySummaryQuery {
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() regionId?: string;
  @IsOptional() @IsString() fertilizerType?: string;
  @IsOptional() @IsString() q?: string;
}

export class CreateLotDto {
  @ApiProperty() @IsString() regionId: string;
  @ApiProperty() @IsString() @MinLength(3) vesselName: string;
  @ApiProperty() @IsString() @MinLength(2) fertilizerType: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lotCode?: string;
  @ApiPropertyOptional({ default: 'Active Loading' }) @IsOptional() @IsString() status?: string;
}

export class UnionLoadDto {
  @ApiProperty({ example: '17.06.24' }) @IsString() @MinLength(4) date: string;
  @ApiProperty() @IsNumber() @Min(0) mt: number;
}

export class DispatchEntryDto {
  @ApiProperty({ example: 'u1' }) @IsString() unionId: string;
  @ApiProperty({ example: '17.06.24' }) @IsString() @MinLength(4) date: string;
  @ApiProperty() @IsNumber() @IsPositive() mtLoaded: number;
  @ApiPropertyOptional() @IsOptional() @IsString() truckPlate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() driverName?: string;
  @ApiProperty() @IsString() @MinLength(3) waybillNo: string;
}

export class LotDateDto {
  @ApiProperty() @IsString() @MinLength(4) date: string;
}

export class AddLotUnionDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) unionName: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() destination?: string;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsNumber() @Min(0) shareMT?: number;
}
