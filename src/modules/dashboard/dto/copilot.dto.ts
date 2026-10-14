import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CopilotAskDto {
  @ApiProperty({ example: 'What is the net import requirement?' }) @IsString() @MinLength(1) @MaxLength(1000) message: string;
  @ApiPropertyOptional({ enum: ['en', 'am', 'om'], default: 'en' }) @IsOptional() @IsIn(['en', 'am', 'om']) lang?: 'en' | 'am' | 'om';
}
