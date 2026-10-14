import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsPositive, IsString, Max, Min, MinLength, ValidateNested } from 'class-validator';
import { RULES } from '../../../common/constants/rules';
import { SignatureDto } from '../../../common/dto/signature.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// ---------------- Provisional quota engine (REQ-1.4-001) ----------------
export class QuotaWeightsDto {
  @ApiProperty({ example: 60 }) @IsNumber() @Min(0) @Max(100) historical: number;
  @ApiProperty({ example: 25 }) @IsNumber() @Min(0) @Max(100) soilIndex: number;
  @ApiProperty({ example: 15 }) @IsNumber() @Min(0) @Max(100) arrearsPenalty: number;
}

export class UpdateQuotaWeightsDto extends QuotaWeightsDto {
  @ApiProperty({ example: 'FTWG resolution 2026/14' }) @IsString() @MinLength(5) justification: string;
}

export class CreateQuotaRunDto {
  @ApiPropertyOptional({ type: QuotaWeightsDto }) @IsOptional() @ValidateNested() @Type(() => QuotaWeightsDto) weights?: QuotaWeightsDto;
  @ApiPropertyOptional({ example: 2350000 }) @IsOptional() @IsNumber() @IsPositive() totalMT?: number;
  @ApiPropertyOptional({ example: 'Meher baseline' }) @IsOptional() @IsString() label?: string;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() scenario?: boolean;
}

// ---------------- Adjustment requests (REQ-1.4-002) ----------------
export class EvidenceDto {
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() url?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() documentId?: string;
}

export class CreateAdjustmentRequestDto {
  @ApiProperty({ enum: ['INCREASE', 'DECREASE'] }) @IsIn(['INCREASE', 'DECREASE']) direction: 'INCREASE' | 'DECREASE';
  @ApiProperty({ example: 12000 }) @IsNumber() @IsPositive() amountMT: number;
  @ApiProperty({ enum: RULES.adjustmentJustificationTypes }) @IsIn(RULES.adjustmentJustificationTypes) justificationType: string;
  @ApiProperty({ minLength: 10 })
  @Transform(trim) @IsString() @MinLength(10, { message: 'Justification is required for any adjustment request' }) justification: string;
  @ApiPropertyOptional({ type: [EvidenceDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => EvidenceDto) evidence?: EvidenceDto[];
}

export class AdjustmentDecisionDto extends SignatureDto {
  @ApiProperty({ enum: ['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED'] }) @IsIn(['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'PARTIALLY_APPROVED' | 'REJECTED';
  @ApiPropertyOptional({ example: 8000 }) @IsOptional() @IsNumber() @Min(0) decisionMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() comments?: string;
}

export class AppealDto {
  @ApiProperty({ minLength: 10 }) @IsString() @MinLength(10) reason: string;
}

// ---------------- Allocations (REQ-1.4-004/005/007/008) ----------------
export class CreateChildAllocationDto {
  @ApiProperty({ example: 'KEB-02' }) @IsString() unitId: string;
  @ApiProperty({ example: 'Dungugi Boro Kebele' }) @IsString() @MinLength(2) recipientName: string;
  @ApiPropertyOptional() @IsOptional() @IsString() recipientNameAm?: string;
  @ApiProperty({ example: 900 }) @IsNumber() @Min(0) npsbMT: number;
  @ApiProperty({ example: 600 }) @IsNumber() @Min(0) ureaMT: number;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsNumber() @Min(0) otherMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() allocationSource?: string;
  @ApiPropertyOptional({ example: 'Sep 10 - Sep 25' }) @IsOptional() @IsString() deliveryWindow?: string;
  @ApiPropertyOptional({ description: 'Required when deviating >10% from the recommendation' }) @IsOptional() @IsString() justification?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export const DELIVERY_STATUSES = ['Planned', 'Scheduled Dispatch', 'In Transit', 'Delivered', 'Partially Delivered'];

export class DeliveryUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) receivedMT?: number;
  @ApiPropertyOptional({ enum: DELIVERY_STATUSES }) @IsOptional() @IsIn(DELIVERY_STATUSES) status?: string;
}

// ---------------- Amendments (REQ-1.4-009) ----------------
export class ProposedStateDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) npsbMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) ureaMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) otherMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() deliveryWindow?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() recipientName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() allocationSource?: string;
}

export class AmendmentEvidenceDto {
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() url?: string;
}

export class CreateAmendmentDto {
  @ApiProperty({ enum: RULES.amendmentTypes }) @IsIn(RULES.amendmentTypes) type: string;
  @ApiProperty({ type: ProposedStateDto }) @ValidateNested() @Type(() => ProposedStateDto) proposed: ProposedStateDto;
  @ApiProperty({ minLength: 10 })
  @Transform(trim) @IsString() @MinLength(10, { message: 'Justification is mandatory for all amendments' }) justification: string;
  @ApiPropertyOptional({ type: [AmendmentEvidenceDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AmendmentEvidenceDto) evidence?: AmendmentEvidenceDto[];
}

export class AmendmentDecisionDto extends SignatureDto {
  @ApiProperty() @IsBoolean() approve: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() comments?: string;
}

// ---------------- Letters (REQ-1.4-006) ----------------
export class CreateLettersDto extends SignatureDto {
  @ApiPropertyOptional({ example: ['REG-OROMIA'] }) @IsOptional() @IsArray() @IsString({ each: true }) regionIds?: string[];
}

// ---------------- Procurement requests (REQ-1.4-010) ----------------
export class CreateProcurementRequestDto extends SignatureDto {
  @ApiPropertyOptional({ enum: ['URGENT', 'STANDARD', 'SCHEDULED'], default: 'STANDARD' }) @IsOptional() @IsIn(['URGENT', 'STANDARD', 'SCHEDULED']) priority?: string;
  @ApiPropertyOptional({ enum: ['OPEN_BID', 'SHORTLIST', 'G2G'], default: 'OPEN_BID' }) @IsOptional() @IsIn(['OPEN_BID', 'SHORTLIST', 'G2G']) modality?: string;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() override?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() overrideReason?: string;
}

export const PO_STATUSES = ['RECEIVED', 'ACKNOWLEDGED', 'PROCESSING', 'CLARIFICATION_REQUESTED'];

export class ProcurementStatusDto {
  @ApiProperty({ enum: PO_STATUSES }) @IsIn(PO_STATUSES) status: string;
  @ApiPropertyOptional() @IsOptional() @IsString() note?: string;
}
