import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class FaydaVerifyDto {
  @ApiProperty({ example: 'FAN-9482-1049-3821' }) @IsString() @MinLength(5) faydaId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() gender?: string;
}

export class NrlaisVerifyDto {
  @ApiProperty({ example: 'NRLAIS-OR-AD-99001-2025' }) @IsString() landCertNumber: string;
}
