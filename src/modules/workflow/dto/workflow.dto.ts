import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { SignatureDto } from '../../../common/dto/signature.dto';

export class WorkflowCaseDto {
  @ApiProperty({ example: 'WFC-8F2K1Q' }) id: string;
  @ApiProperty({ example: 'DEMAND_PACKAGE_REVIEW' }) definition: string;
  @ApiProperty({ example: 'WOREDA', description: 'Record type, or the unit type for per-unit-and-season cases' }) entityType: string;
  @ApiProperty({ example: 'WOR-OR-ADAMA' }) entityId: string;
  @ApiProperty({ nullable: true, type: String, example: 'MEHER-2026' }) seasonId: string | null;
  @ApiProperty({ example: 'ZONE', description: 'Type of the unit that must act next' }) level: string;
  @ApiProperty({ example: 'PENDING_ZONE', description: 'Status code (translated by the frontend)' }) status: string;
  @ApiProperty({ example: 'ZONE-OR-ESHEWA' }) assigneeUnitId: string;
  @ApiProperty({ example: 'WOR-OR-ADAMA' }) originUnitId: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) dueAt: string | null;
  @ApiProperty() escalationLevel: number;
  @ApiProperty({ description: 'Send back as expectedVersion to detect concurrent changes' }) version: number;
  @ApiProperty() closed: boolean;
}

export class AvailableActionDto {
  @ApiProperty({ example: 'APPROVE' }) action: string;
  @ApiProperty({ example: 'APPROVED' }) toStatus: string;
  @ApiProperty() signatureRequired: boolean;
  @ApiProperty() commentsRequired: boolean;
}

export class WorkflowHistoryEntryDto {
  @ApiProperty({ enum: ['LEGACY', 'WORKFLOW'], description: 'LEGACY = approval_actions recorded before the workflow engine' })
  source: 'LEGACY' | 'WORKFLOW';
  @ApiProperty({ nullable: true, type: String }) caseId: string | null;
  @ApiProperty({ nullable: true, type: String }) definition: string | null;
  @ApiProperty({ example: 'WOREDA' }) level: string;
  @ApiProperty({ example: 'APPROVE' }) action: string;
  @ApiProperty({ nullable: true, type: String }) fromStatus: string | null;
  @ApiProperty({ nullable: true, type: String }) toStatus: string | null;
  @ApiProperty({ nullable: true, type: String }) comments: string | null;
  @ApiProperty({ nullable: true, type: Object }) details: unknown;
  @ApiProperty({ nullable: true, type: String, description: 'Actor name ("system" for scheduled actions)' }) by: string | null;
  @ApiProperty({ example: '2026-10-29 10:15:00' }) at: string;
  @ApiProperty({ nullable: true, type: String }) signatureId: string | null;
}

export class WorkflowCaseDetailDto {
  @ApiProperty({ type: WorkflowCaseDto }) case: WorkflowCaseDto;
  @ApiProperty({ type: [AvailableActionDto], description: 'Actions the current user may take now' }) available: AvailableActionDto[];
  @ApiProperty({ type: [WorkflowHistoryEntryDto] }) history: WorkflowHistoryEntryDto[];
}

export class WorkflowActDto extends SignatureDto {
  @ApiProperty({ example: 'APPROVE' }) @IsString() @Matches(/^[A-Z][A-Z0-9_]{1,29}$/) action: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) comments?: string;
  @ApiPropertyOptional({ type: Object }) @IsOptional() @IsObject() details?: Record<string, unknown>;
  @ApiPropertyOptional({ description: 'Version the user saw; 409 when the case changed since' }) @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}

export class WorkflowEntityQueryDto {
  @ApiProperty({ example: 'WOREDA' }) @IsString() @MaxLength(40) entityType: string;
  @ApiProperty({ example: 'WOR-OR-ADAMA' }) @IsString() @MaxLength(60) entityId: string;
}
