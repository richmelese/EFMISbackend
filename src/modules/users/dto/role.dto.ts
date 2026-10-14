import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ example: 'REGIONAL_LOGISTICS_OFFICER', description: 'Code: A–Z, 0–9 and _ (3–40)' })
  @Matches(/^[A-Za-z][A-Za-z0-9_]{2,39}$/, { message: 'id must be 3–40 characters: letters, digits, underscore; starting with a letter' })
  id: string;

  @ApiProperty({ example: 'Regional Logistics Officer' }) @IsString() @MinLength(3) @MaxLength(160) name: string;

  @ApiProperty({ example: 'DISPATCHER', description: 'System role whose data scope applies' }) @IsString() baseRole: string;

  @ApiPropertyOptional({ example: 'Region' }) @IsOptional() @IsString() @MaxLength(40) level?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @ApiProperty({ type: [String], example: ['shipments:read', 'tracking:read'] })
  @IsArray() @ArrayUnique() @ArrayMaxSize(200) @IsString({ each: true })
  permissions: string[];
}

export class UpdateRoleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(3) @MaxLength(160) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) level?: string;
  @ApiPropertyOptional({ description: 'Custom roles only' }) @IsOptional() @IsString() baseRole?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Full permission set (replaces the current one)' })
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(200) @IsString({ each: true })
  permissions?: string[];
}
