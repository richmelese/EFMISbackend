import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { SignatureDto } from '../../../common/dto/signature.dto';

const VOTE_ALIASES: Record<string, string> = { favor: 'FAVOR', oppose: 'OPPOSE', opposed: 'OPPOSE', abstain: 'ABSTAIN' };

/** PATCH /national/carry-over/:type (REQ-1.3-004) */
export class UpdateCarryOverDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) stockMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) usableMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) expiredMT?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() qcStatus?: string;
  @ApiPropertyOptional({ description: 'Required when usable stock changes by more than 10%' }) @IsOptional() @IsString() justification?: string;
}

export class ExportQueryDto {
  @ApiPropertyOptional({ enum: ['csv', 'json'] }) @IsOptional() @IsString() format?: string;
}

export class MinutesQueryDto {
  @ApiPropertyOptional({ enum: ['text', 'json'] }) @IsOptional() @IsString() format?: string;
}

/** POST /national/ftwg/sessions */
export class CreateFtwgSessionDto {
  @ApiProperty({ example: 'Meher 2026 national demand endorsement' }) @IsString() @MinLength(3) title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() agenda?: string;
}

/** POST /national/ftwg/sessions/:id/vote — accepts favor/oppose/opposed/abstain in any case */
export class FtwgVoteDto {
  @ApiProperty({ enum: ['FAVOR', 'OPPOSE', 'ABSTAIN'], example: 'favor' })
  @Transform(({ value }) => (typeof value === 'string' ? VOTE_ALIASES[value.toLowerCase()] || value.toUpperCase() : value))
  @IsIn(['FAVOR', 'OPPOSE', 'ABSTAIN'])
  vote: 'FAVOR' | 'OPPOSE' | 'ABSTAIN';

  @ApiPropertyOptional() @IsOptional() @IsString() comment?: string;
}

/** POST /national/ftwg/sessions/:id/close */
export class CloseFtwgSessionDto {
  @ApiPropertyOptional({ description: 'Defaults to CONSENSUS_REACHED / NO_CONSENSUS from the tally' }) @IsOptional() @IsString() decision?: string;
}

/** POST /national/ftwg/sessions/:id/action-items */
export class CreateActionItemDto {
  @ApiProperty() @IsString() @MinLength(3) description: string;
  @ApiPropertyOptional() @IsOptional() @IsString() assignee?: string;
  @ApiPropertyOptional({ example: '2026-09-30' }) @IsOptional() @IsString() dueDate?: string;
}

/** PATCH /national/ftwg/action-items/:itemId */
export class UpdateActionItemDto {
  @ApiProperty({ enum: ['OPEN', 'IN_PROGRESS', 'DONE'] }) @IsIn(['OPEN', 'IN_PROGRESS', 'DONE']) status: 'OPEN' | 'IN_PROGRESS' | 'DONE';
}

/** POST /national/documents/:id/sign */
export class SignDocumentDto extends SignatureDto {}

/** POST /national/documents/:id/reject */
export class RejectDocumentDto {
  @ApiProperty({ example: 'Regional breakdown for Somali needs revision' }) @IsString() @MinLength(3) comments: string;
}
