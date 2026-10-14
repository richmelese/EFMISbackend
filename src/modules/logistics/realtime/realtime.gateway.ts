import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer
} from '@nestjs/websockets';
import { DataSource, Repository } from 'typeorm';
import type { Server, Socket } from 'socket.io';
import { RevokedToken } from '../../auth/entities/revoked-token.entity';
import { UsersService } from '../../users/users.service';
import { FLEET_WIDE_ROLES } from '../../../common/constants/permissions';
import { AuthUser } from '../../../common/types/auth-user';
import { Driver } from '../drivers/entities/driver.entities';
import { Trip, TripShipment, Shipment } from '../shipments/entities/shipment.entities';
import { FLEET_ROOM, RealtimeService, rooms } from './realtime.service';

type SubscribeTarget = { type: 'truck' | 'trip' | 'shipment'; id: string };

/**
 * Live logistics WebSocket (Socket.IO) at namespace /realtime.
 * Auth: JWT in `auth.token` (or `?token=`) during the handshake — same tokens as the REST API; revoked tokens rejected.
 * Authorisation (Logistics doc §16 "do not broadcast all vehicles to every user"):
 *   - fleet-wide roles (Logistics Manager, Dispatcher, Fleet Manager, MoA, PMO, EABC, Admin, Auditor) join `fleet:all`
 *   - DRIVER joins `driver:<id>` (only their own assignments/trips)
 *   - WAREHOUSE_OPERATOR joins `warehouse:<id>` (shipments to/from their warehouse)
 *   - `subscribe` to a truck/trip/shipment room is checked against the same rules.
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger('RealtimeGateway');
  @WebSocketServer() server: Server;

  constructor(
    private readonly realtime: RealtimeService,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    @InjectRepository(RevokedToken) private readonly revoked: Repository<RevokedToken>,
    @InjectDataSource() private readonly ds: DataSource
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
  }

  private async authenticate(client: Socket): Promise<AuthUser | null> {
    const token = (client.handshake.auth?.token as string) || (client.handshake.query?.token as string) ||
      (client.handshake.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) return null;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; jti: string; iat: number }>(token);
      if (await this.revoked.exist({ where: { jti: payload.jti } })) return null;
      const user = await this.users.findActive(payload.sub, payload.iat);
      return user && !user.mustChangePassword ? user : null;
    } catch {
      return null;
    }
  }

  async handleConnection(client: Socket) {
    const user = await this.authenticate(client);
    if (!user) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Valid access token required' });
      client.disconnect(true);
      return;
    }
    client.data.user = user;
    const joined: string[] = [];
    if (FLEET_WIDE_ROLES.includes(user.role)) joined.push(FLEET_ROOM);
    if (user.role === 'DRIVER') {
      const driver = await this.ds.getRepository(Driver).findOneBy({ userId: user.id });
      if (driver) { client.data.driverId = driver.id; joined.push(rooms.driver(driver.id)); }
    }
    if (user.role === 'WAREHOUSE_OPERATOR' && user.warehouseId) joined.push(rooms.warehouse(user.warehouseId));
    await client.join(joined);
    client.emit('connected', { userId: user.id, role: user.role, rooms: joined });
  }

  /** Can this socket see the given truck/trip/shipment? */
  private async authorize(client: Socket, target: SubscribeTarget): Promise<boolean> {
    const user = client.data.user as AuthUser;
    if (FLEET_WIDE_ROLES.includes(user.role)) return true;
    const trips = this.ds.getRepository(Trip);
    let tripIds: string[] = [];
    if (target.type === 'trip') tripIds = [target.id];
    if (target.type === 'truck') tripIds = (await trips.find({ where: { truckId: target.id }, select: { id: true }, order: { createdAt: 'DESC' }, take: 5 })).map(t => t.id);
    if (target.type === 'shipment') tripIds = (await this.ds.getRepository(TripShipment).find({ where: { shipmentId: target.id } })).map(t => t.tripId);
    if (user.role === 'DRIVER' && client.data.driverId) {
      if (!tripIds.length) return false;
      const own = await trips.createQueryBuilder('t').where('t.id IN (:...ids)', { ids: tripIds }).andWhere('t.primaryDriverId = :d', { d: client.data.driverId }).getCount();
      return own > 0;
    }
    if (user.role === 'WAREHOUSE_OPERATOR' && user.warehouseId) {
      const shipmentIds = target.type === 'shipment' ? [target.id]
        : tripIds.length ? (await this.ds.getRepository(TripShipment).createQueryBuilder('ts').where('ts.tripId IN (:...ids)', { ids: tripIds }).getMany()).map(s => s.shipmentId) : [];
      if (!shipmentIds.length) return false;
      const n = await this.ds.getRepository(Shipment).createQueryBuilder('s').where('s.id IN (:...ids)', { ids: shipmentIds })
        .andWhere('(s.originWarehouseId = :w OR s.destinationWarehouseId = :w)', { w: user.warehouseId }).getCount();
      return n > 0;
    }
    return false;
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: SubscribeTarget) {
    if (!body || !['truck', 'trip', 'shipment'].includes(body.type) || typeof body.id !== 'string') {
      return { ok: false, error: 'Expected { type: "truck"|"trip"|"shipment", id }' };
    }
    if (!(await this.authorize(client, body))) return { ok: false, error: 'FORBIDDEN' };
    const room = rooms[body.type](body.id);
    await client.join(room);
    return { ok: true, room };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: SubscribeTarget) {
    if (body?.type && body?.id) await client.leave(rooms[body.type](body.id));
    return { ok: true };
  }
}
