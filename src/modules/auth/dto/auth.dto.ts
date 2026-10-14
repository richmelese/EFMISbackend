import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class LoginDto {
  @ApiPropertyOptional({ example: 'admin.moa@efmis.gov.et' }) @IsOptional() @IsString() email?: string;
  @ApiPropertyOptional({ example: '0911234567' }) @IsOptional() @IsString() phone?: string;
  @ApiProperty({ example: 'Efmis@2026' }) @IsString() @MinLength(1) password: string;
}

export class OtpRequestDto {
  @ApiProperty({ enum: ['FAYDA', 'PHONE'] }) @IsIn(['FAYDA', 'PHONE']) channel: 'FAYDA' | 'PHONE';
  @ApiProperty({ example: 'FAYDA-ETH-8829-4921' }) @IsString() @MinLength(3) identifier: string;
}

export class OtpVerifyDto extends OtpRequestDto {
  @ApiProperty({ example: '123456' }) @Matches(/^\d{6}$/, { message: 'OTP must be 6 digits' }) otp: string;
}

export class DemoLoginDto {
  @ApiProperty({ example: 'MOA' }) @IsString() @MinLength(2) role: string;
}

export class UpdateMeDto {
  @ApiPropertyOptional({ enum: ['en', 'am', 'om'] }) @IsOptional() @IsIn(['en', 'am', 'om']) preferredLanguage?: string;
}

export class ChangePinDto {
  @IsString() currentPassword: string;
  @Matches(/^\d{4,8}$/, { message: 'PIN must be 4-8 digits' }) newPin: string;
}
