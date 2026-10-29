import { ApiProperty } from '@nestjs/swagger';

export class CommentDto {
  @ApiProperty() id: number;
  @ApiProperty({ description: 'Author display name' }) author: string;
  @ApiProperty() text: string;
  @ApiProperty({ example: '14:20' }) time: string;
  @ApiProperty({ example: '2026-10-29 14:20:00' }) createdAt: string;
  @ApiProperty({ nullable: true, type: Number }) parentId: number | null;
  @ApiProperty({ type: [String], description: 'Names of users @mentioned (they are notified)' }) mentions: string[];
}

export class AddedCommentDto extends CommentDto {
  @ApiProperty() message: string;
}
