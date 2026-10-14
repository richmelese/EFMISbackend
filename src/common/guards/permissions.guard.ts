import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_PENDING_PASSWORD_KEY, IS_PUBLIC_KEY, PERMISSIONS_KEY } from '../decorators';
import { can, Permission } from '../constants/permissions';
import { AppError, Errors } from '../utils/errors';

/** Global RBAC guard: enforces @RequirePermissions (any-of) against the user's permissions from the database. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const user = ctx.switchToHttp().getRequest().user;
    if (user?.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_KEY, targets)) {
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your temporary password before continuing');
    }
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, targets);
    if (!required || !required.length) return true;
    if (!user) throw Errors.unauthorized();
    if (required.some(p => can(user, p))) return true;
    throw Errors.forbidden(`Your role (${user.roleName || user.roleId || user.role}) is not permitted to perform: ${required.join(' / ')}`);
  }
}
