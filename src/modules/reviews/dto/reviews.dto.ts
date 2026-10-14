import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { SignatureDto } from '../../../common/dto/signature.dto';
import { COMMENT_SCOPES } from '../../comments/comments.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const DECISION_ACTIONS = ['APPROVE', 'RETURN', 'PARTIAL_APPROVE', 'HOLD', 'DISPUTE'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export class AdjustmentQueryDto {
  @ApiPropertyOptional({ enum: ['WOREDA', 'ZONE'] }) @IsOptional() @IsString() level?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() unitId?: string;
}

export class CreateAdjustmentDto {
  @ApiProperty({ example: 'KEB-02', description: 'Kebele id (woreda officer) or woreda id (zone officer)' })
  @IsString()
  unitId: string;

  @ApiPropertyOptional({ example: -10 }) @IsOptional() @IsNumber() @Min(-100) @Max(200) changePct?: number;

  @ApiPropertyOptional({ example: 1305 }) @IsOptional() @IsNumber() @Min(0) adjustedMT?: number;

  @ApiProperty({ example: 'Flooding in lowland area, reduce demand' })
  @Transform(trim)
  @IsString({ message: 'Adjustments require justification (free text mandatory)' })
  @MinLength(5, { message: 'Adjustments require justification (free text mandatory)' })
  justification: string;
}

export class CommentQueryDto {
  @ApiProperty({ enum: COMMENT_SCOPES }) @IsIn(COMMENT_SCOPES as unknown as string[]) scopeType: string;
  @ApiProperty() @IsString() scopeId: string;
}

export class CreateCommentDto {
  @ApiProperty({ enum: COMMENT_SCOPES }) @IsIn(COMMENT_SCOPES as unknown as string[]) scopeType: string;
  @ApiProperty({ example: 'ZONE-OR-ESHEWA' }) @IsString() scopeId: string;
  @ApiProperty({ example: 'Please check @Adama Woreda figures' }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(4000) text: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() parentId?: number;
}

export class DecisionDto extends SignatureDto {
  @ApiProperty({ enum: DECISION_ACTIONS }) @IsIn(DECISION_ACTIONS as unknown as string[]) action: DecisionAction;
  @ApiPropertyOptional() @IsOptional() @IsString() comments?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) approveChildIds?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) returnChildIds?: string[];
}

export class ScenarioAdjustmentDto {
  @ApiProperty({ example: 'WOR-OR-ADAMA' }) @IsString() childId: string;
  @ApiProperty({ example: -10 }) @IsNumber() @Min(-100) @Max(200) changePct: number;
}

export class ScenarioDto {
  @ApiProperty({ enum: ['WOREDA', 'ZONE', 'REGION'] }) @IsIn(['WOREDA', 'ZONE', 'REGION']) level: 'WOREDA' | 'ZONE' | 'REGION';
  @ApiProperty({ example: 'ZONE-OR-ESHEWA' }) @IsString() unitId: string;
  @ApiProperty({ type: [ScenarioAdjustmentDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScenarioAdjustmentDto)
  adjustments: ScenarioAdjustmentDto[];
}
