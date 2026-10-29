import { ApiProperty } from '@nestjs/swagger';

export class NotificationDto {
  @ApiProperty() id: number;
  @ApiProperty() title: string;
  @ApiProperty() message: string;
  @ApiProperty({ nullable: true, type: String, description: 'In-app route to open, e.g. /workflow/cases/WFC-…' }) link: string | null;
  @ApiProperty() read: boolean;
  @ApiProperty({ example: '2026-10-29 10:15:00' }) createdAt: string;
}

export class OkDto {
  @ApiProperty({ example: true }) ok: boolean;
}
