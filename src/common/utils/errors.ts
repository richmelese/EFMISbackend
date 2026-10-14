import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Domain error with a stable machine-readable code.
 * Rendered by AllExceptionsFilter as { error: { code, message, details } }.
 */
export class AppError extends HttpException {
  constructor(status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super({ code, message, details }, status);
  }
}

export const Errors = {
  badRequest: (message: string, details?: unknown) => new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', message, details),
  unauthorized: (message = 'Authentication required', code = 'UNAUTHORIZED') => new AppError(HttpStatus.UNAUTHORIZED, code, message),
  forbidden: (message = 'You do not have permission to perform this action') => new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message),
  notFound: (what = 'Resource') => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`),
  conflict: (message: string, details?: unknown) => new AppError(HttpStatus.CONFLICT, 'CONFLICT', message, details),
  unprocessable: (message: string, details?: unknown) => new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED', message, details),
  tooMany: (message: string) => new AppError(HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_ATTEMPTS', message)
};
