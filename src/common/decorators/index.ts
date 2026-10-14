import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { Permission } from '../constants/permissions';
import { AuthUser, RequestContext } from '../types/auth-user';

export const IS_PUBLIC_KEY = 'isPublic';
/** Skip JWT authentication for this route/controller. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'permissions';
/** Require ANY of the listed permissions (see common/constants/permissions.ts). */
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

export const ALLOW_PENDING_PASSWORD_KEY = 'allowPendingPassword';
/** Route stays usable while the user still has to replace a temporary password (me, change password, logout). */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);

/** Inject the authenticated user. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

/** Inject audit context (ip, source header, session id). */
export const ReqCtx = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  return { ip: req.ip, source: (req.headers['x-client-source'] as string) || 'API', sessionId: req.user?.jti };
});
