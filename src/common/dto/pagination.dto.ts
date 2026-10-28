import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Shared page/pageSize query params (cap 200). Extend this instead of redeclaring
 * page/pageSize on every list query DTO — e.g. `class ListFooQueryDto extends PageQueryDto { ... }`.
 * Pair with `pageParams()` from `common/utils/pagination` in the service.
 */
export class PageQueryDto {
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 50, maximum: 200 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

/**
 * Same as PageQueryDto but with a 1000 ceiling, for high-volume read endpoints
 * (e.g. GPS location history). Pass `pageParams(q, 1000)` in the service so the
 * runtime cap matches this DTO's validation — a mismatch here silently truncates pages.
 */
export class PageQueryDto1000 {
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 200, maximum: 1000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) pageSize?: number;
}
