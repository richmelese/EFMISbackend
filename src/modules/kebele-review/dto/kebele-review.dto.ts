import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { SignatureDto } from '../../../common/dto/signature.dto';
import { RULES } from '../../../common/constants/rules';

export class KebeleApproveDto extends SignatureDto {
  @ApiPropertyOptional() @IsOptional() @IsString() comments?: string;

  @ApiPropertyOptional({ example: { NPSB: 7.5, UREA: 9 }, description: 'Approved quintals per fertilizer type (defaults to min(requested, recommended))' })
  @IsOptional()
  @IsObject()
  approvedQtl?: Record<string, number>;
}

export class KebeleRejectDto extends SignatureDto {
  @ApiProperty({ example: 'Land certificate does not match the holder' })
  @IsString()
  @MinLength(3, { message: 'Rejection reason is required' })
  reason: string;
}

export class KebeleRevisionDto extends SignatureDto {
  @ApiProperty({ example: 'Please re-measure the plot size' })
  @IsString()
  @MinLength(3, { message: 'Revision comments are required' })
  comments: string;

  @ApiPropertyOptional({ enum: RULES.fertilizerTypes, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(RULES.fertilizerTypes, { each: true })
  types?: string[];
}

export class PartialApproveLineDto {
  @ApiProperty({ enum: RULES.fertilizerTypes }) @IsIn(RULES.fertilizerTypes) type: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) approvedQtl?: number;
}

export class PartialReviseLineDto {
  @ApiProperty({ enum: RULES.fertilizerTypes }) @IsIn(RULES.fertilizerTypes) type: string;
  @ApiProperty() @IsString() @MinLength(3) comment: string;
}

export class KebelePartialDto extends SignatureDto {
  @ApiProperty({ type: [PartialApproveLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PartialApproveLineDto)
  approve: PartialApproveLineDto[];

  @ApiProperty({ type: [PartialReviseLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PartialReviseLineDto)
  revise: PartialReviseLineDto[];
}

export class KebeleBulkDto extends SignatureDto {
  @ApiPropertyOptional({ enum: ['APPROVE', 'REJECT', 'REQUEST_REVISION'], default: 'APPROVE' })
  @IsOptional()
  @IsIn(['APPROVE', 'REJECT', 'REQUEST_REVISION'])
  action: 'APPROVE' | 'REJECT' | 'REQUEST_REVISION' = 'APPROVE';

  @ApiPropertyOptional({ type: [String], description: `Max ${RULES.bulkApprovalMax}; omitted = all pending in your kebele` })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RULES.bulkApprovalMax)
  @IsString({ each: true })
  farmerIds?: string[];

  @ApiProperty({ example: 'Seasonal batch approval' })
  @IsString()
  @MinLength(3, { message: 'A common reason is required for bulk operations' })
  reason: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  includeWarnings: boolean = false;
}
