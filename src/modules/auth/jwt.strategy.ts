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

interface JwtPayload {
  sub: string;
  role: string;
  jti: string;
  exp: number;
  iat: number;
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
    if (await this.revoked.exist({ where: { jti: payload.jti } })) throw new AppError(401, 'TOKEN_REVOKED', 'Session has been signed out');
    const user = await this.users.findActive(payload.sub, payload.iat);
    if (!user) throw Errors.unauthorized('Session expired or account deactivated — please sign in again');
    return { ...user, jti: payload.jti, tokenExp: payload.exp };
  }
}
