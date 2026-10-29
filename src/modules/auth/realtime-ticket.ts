import { ApiProperty } from '@nestjs/swagger';

/**
 * Audience of short-lived tickets for the realtime socket (/realtime). A ticket lets the browser open the socket
 * without holding the session token (which the portal keeps in an httpOnly cookie). The REST API rejects tickets.
 */
export const REALTIME_TICKET_AUDIENCE = 'efmis-realtime';
export const REALTIME_TICKET_TTL_SECONDS = 60;

export class RealtimeTicketDto {
  @ApiProperty({ description: 'JWT accepted only by the realtime socket handshake (auth.token)' })
  ticket: string;

  @ApiProperty({ description: 'ISO time after which the ticket can no longer open a connection', example: '2026-10-29T12:00:00.000Z' })
  expiresAt: string;
}
