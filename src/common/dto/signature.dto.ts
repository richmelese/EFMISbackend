import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * Electronic signature credentials (Proclamation No. 1078/2018). Every approval endpoint extends this:
 * the signer re-authenticates with their e-signature PIN (or password).
 */
export class SignatureDto {
  @ApiPropertyOptional({ example: '1234', description: 'E-signature PIN' })
  @IsOptional()
  @IsString()
  pin?: string;

  @ApiPropertyOptional({ description: 'Account password (alternative to PIN)' })
  @IsOptional()
  @IsString()
  password?: string;
}
