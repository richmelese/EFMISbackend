import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

/** At least 10 characters with upper case, lower case and a digit. */
export const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,128}$/;
export const PASSWORD_MESSAGE = 'password must be 10–128 characters and contain upper case, lower case and a digit';
const PHONE_RULE = /^0[79]\d{8}$/;

export class ListUsersQueryDto {
  @ApiPropertyOptional({ description: 'Search name, email, phone, title' }) @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() role?: string;
  @ApiPropertyOptional({ enum: ['true', 'false'] }) @IsOptional() @IsIn(['true', 'false']) active?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() regionId?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 50, maximum: 200 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

export class CreateUserDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(160) name: string;
  @ApiProperty() @IsEmail() @MaxLength(160) email: string;
  @ApiPropertyOptional({ example: '0911223344' }) @IsOptional() @Matches(PHONE_RULE, { message: 'phone must be 09XXXXXXXX or 07XXXXXXXX' }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) faydaId?: string;
  @ApiProperty({ description: 'Role id (system or custom)' }) @IsString() role: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) title?: string;
  @ApiPropertyOptional({ description: 'Initial password. Omit to generate a temporary one (returned once).' })
  @IsOptional() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) password?: string;
  @ApiPropertyOptional({ description: 'E-signature PIN (4–8 digits) for users who sign documents' })
  @IsOptional() @Matches(/^\d{4,8}$/, { message: 'pin must be 4-8 digits' }) pin?: string;
  @ApiPropertyOptional({ default: true, description: 'Force a password change at first sign-in' }) @IsOptional() @IsBoolean() mustChangePassword?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() regionId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() zoneId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() woredaId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() kebeleId?: string;
  @ApiPropertyOptional({ description: 'Warehouse scope (warehouse-based roles)' }) @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional({ enum: ['en', 'am', 'om'] }) @IsOptional() @IsIn(['en', 'am', 'om']) preferredLanguage?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(3) @MaxLength(160) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(160) email?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(PHONE_RULE, { message: 'phone must be 09XXXXXXXX or 07XXXXXXXX' }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) faydaId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() role?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) title?: string;
  @ApiPropertyOptional({ description: 'Send null to clear' }) @IsOptional() @IsString() regionId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() zoneId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() woredaId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() kebeleId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string | null;
  @ApiPropertyOptional({ enum: ['en', 'am', 'om'] }) @IsOptional() @IsIn(['en', 'am', 'om']) preferredLanguage?: string;
  /** Deprecated: use /deactivate and /reactivate (kept for older clients) */
  @ApiPropertyOptional({ deprecated: true }) @IsOptional() @IsBoolean() active?: boolean;
}

export class ReasonDto {
  @ApiProperty({ example: 'Left the organisation' }) @IsString() @MinLength(3) @MaxLength(1000) reason: string;
}

export class ResetPasswordDto {
  @ApiPropertyOptional({ description: 'Temporary password; omit to generate one (returned once)' })
  @IsOptional() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) temporaryPassword?: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MinLength(1) currentPassword: string;
  @ApiProperty() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) newPassword: string;
}
