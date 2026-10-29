import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import { RevokedToken } from './entities/revoked-token.entity';
import { UsersService } from '../users/users.service';
import { AuthUser } from '../../common/types/auth-user';
import { AppError, Errors } from '../../common/utils/errors';
import { REALTIME_TICKET_AUDIENCE } from './realtime-ticket';

interface JwtPayload {
  sub: string;
  role: string;
  jti: string;
  exp: number;
  iat: number;
  aud?: string | string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly users: UsersService,
    @InjectRepository(RevokedToken) private readonly revoked: Repository<RevokedToken>
  ) {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), ignoreExpiration: false, secretOrKey: config.get<string>('jwt.secret')! });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    // Realtime tickets only open the socket; they never authenticate REST calls.
    const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    if (aud.includes(REALTIME_TICKET_AUDIENCE)) throw new AppError(401, 'TICKET_NOT_FOR_API', 'Realtime tickets cannot be used for API requests');
    if (await this.revoked.exist({ where: { jti: payload.jti } })) throw new AppError(401, 'TOKEN_REVOKED', 'Session has been signed out');
    const user = await this.users.findActive(payload.sub, payload.iat);
    if (!user) throw Errors.unauthorized('Session expired or account deactivated — please sign in again');
    return { ...user, jti: payload.jti, tokenExp: payload.exp };
  }
}
