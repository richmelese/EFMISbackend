import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { SignatureDto } from '../../../common/dto/signature.dto';

export class SubmitRegionDto extends SignatureDto {
  @ApiPropertyOptional({ example: 'Final Meher demand' }) @IsOptional() @IsString() finalComments?: string;
}
