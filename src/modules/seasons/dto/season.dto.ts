import { ApiProperty } from '@nestjs/swagger';
import { SEASON_STATUSES, SEASON_TYPES, SeasonStatus, SeasonType } from '../season-calendar';

export class SeasonDto {
  @ApiProperty({ example: 'MEHER-2026' }) id: string;
  @ApiProperty({ example: 'Meher 2026' }) name: string;
  @ApiProperty({ enum: SEASON_TYPES }) type: SeasonType;
  @ApiProperty({ example: 2026 }) year: number;
  @ApiProperty({ example: '2026-06-01', format: 'date' }) startsOn: string;
  @ApiProperty({ example: '2026-12-31', format: 'date' }) endsOn: string;
  @ApiProperty({ example: '2026-03-31', format: 'date' }) collectionDeadline: string;
  @ApiProperty({ enum: SEASON_STATUSES }) status: SeasonStatus;
  @ApiProperty({ description: 'The season new records default to' }) isCurrent: boolean;
}
