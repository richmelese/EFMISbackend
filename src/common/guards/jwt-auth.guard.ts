import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators';
import { AppError } from '../utils/errors';

/** Global JWT guard; routes marked @Public() are skipped. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    return super.canActivate(ctx);
  }

  handleRequest<T>(err: unknown, user: T, info: unknown): T {
    if (err) throw err;
    if (!user) {
      const expired = info instanceof Error && info.name === 'TokenExpiredError';
      throw new AppError(401, expired ? 'TOKEN_INVALID' : 'UNAUTHORIZED', expired ? 'Session expired. Please sign in again.' : 'Authentication required');
    }
    return user;
  }
}
