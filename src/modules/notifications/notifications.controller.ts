import { Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import { AuthUser } from '../../common/types/auth-user';
import { NotificationsService } from './notifications.service';
import { NotificationDto, OkDto } from './dto/notification.dto';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'My in-app notifications (?unread=true)' })
  @ApiQuery({ name: 'unread', required: false, enum: ['true', 'false'] })
  @ApiOkResponse({ type: NotificationDto, isArray: true })
  list(@CurrentUser() user: AuthUser, @Query('unread') unread?: string) {
    return this.notifications.forUser(user, { unreadOnly: unread === 'true' });
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all my notifications read' })
  @ApiCreatedResponse({ type: OkDto })
  async readAll(@CurrentUser() user: AuthUser) {
    await this.notifications.markAllRead(user);
    return { ok: true };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one notification read' })
  @ApiCreatedResponse({ type: OkDto })
  async read(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.notifications.markRead(user, id);
    return { ok: true };
  }
}
