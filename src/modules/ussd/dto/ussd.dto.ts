import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Either the gateway form (Africa's Talking style { sessionId, phoneNumber, text } — text is the "*"-joined input history)
 * or the simulator form { input, sessionId? } used by the QuotaAllocation screen. JSON or x-www-form-urlencoded.
 */
export class UssdRequestDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) sessionId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phoneNumber?: string;
  @ApiPropertyOptional({ description: 'Gateway mode: "*"-joined input history' }) @IsOptional() @IsString() @MaxLength(500) text?: string;
  @ApiPropertyOptional({ description: 'Simulator mode: one entry per request' }) @IsOptional() @IsString() @MaxLength(500) input?: string;
  @ApiPropertyOptional({ enum: ['en', 'am'] }) @IsOptional() @IsString() @MaxLength(5) lang?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() serviceCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() networkCode?: string;
}
