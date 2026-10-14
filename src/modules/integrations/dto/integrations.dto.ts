import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsLatitude, IsLongitude, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, Min } from 'class-validator';

export const INSPECTION_VERDICTS = ['PASSED_CONFORMITY', 'REJECTED_IMPOUNDED', 'HOLD', 'PENDING'] as const;

/** EABC Procure / NBE / CBE tender feed (REQ-INT-001). Omitted fields keep their previous value. */
export class TenderFeedDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() stage?: string;
  @ApiPropertyOptional({ example: '2026-09-15' }) @IsOptional() @IsString() deadline?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() budgetAllocatedETB?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() forexRequiredUSD?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() forexStatus?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lcIssuingBank?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lcStatus?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lowestBidder?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() complianceStatus?: string;
}

/** Vessel tracking feed (REQ-INT-001). */
export class VesselFeedDto {
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cargo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() origin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() laycan?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() etaDjibouti?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() berthingStatus?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() unloadingRateTPD?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() demurrageRisk?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) destinationDepots?: string[];
}

/**
 * ECAE lab result (REQ-INT-002). Only the listed fields are validated; any additional product-specific lab parameters
 * sent with the request are stored unchanged in the inspection record (passthrough).
 */
export class QualityInspectionDto {
  @ApiProperty() @IsString() sampleId: string;
  @ApiProperty() @IsString() vessel: string;
  @ApiProperty() @IsString() product: string;
  @ApiProperty() @IsString() supplier: string;
  @ApiProperty({ example: '2026-08-26' }) @IsString() inspectionDate: string;
  @ApiPropertyOptional() @IsOptional() @IsString() labLocation?: string;
  @ApiProperty({ enum: INSPECTION_VERDICTS }) @IsIn(INSPECTION_VERDICTS as unknown as string[]) verdict: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cocNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() qrVerificationCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() incidentReport?: string;
}

/**
 * Partner GPS platform ping (REQ-INT-003). The position is ingested into the logistics tracking pipeline (source PARTNER_FEED);
 * driver / cargo / route / eta / status are now derived from the logistics trip data — the descriptive fields below are
 * accepted for backward compatibility and ignored.
 */
export class TruckPingDto {
  @ApiProperty() @IsLatitude() lat: number;
  @ApiProperty() @IsLongitude() lng: number;
  @ApiProperty() @IsNumber() @Min(0) @Max(250) speedKmH: number;
  @ApiPropertyOptional({ description: 'Degrees 0-360' }) @IsOptional() @IsNumber() @Min(0) @Max(360) heading?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() eta?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() driver?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vehicleNo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cargo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() route?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() qrLot?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) stationaryHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() alertReason?: string;
}

/**
 * Partner warehouse stock feed (REQ-INT-003) for a warehouse registered in the logistics module (resolved by name).
 * currentStockMT is reconciled through an ADJUSTMENT on the inventory ledger (product productSku, default: the product with
 * the largest balance in that warehouse, else NPSB).
 */
export class WarehouseFeedDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @IsPositive() capacityMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) currentStockMT?: number;
  @ApiPropertyOptional({ example: 'NPSB' }) @IsOptional() @IsString() @MaxLength(30) productSku?: string;
}

/** ECX market price feed (REQ-INT-004). */
export class EcxPriceDto {
  @ApiProperty() @IsNumber() @IsPositive() priceETBPerQtl: number;
}
