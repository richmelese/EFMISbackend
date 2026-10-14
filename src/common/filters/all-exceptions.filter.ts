import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { MulterError } from 'multer';
import type { Response } from 'express';

/** Uniform error envelope: { error: { code, message, details? } } */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('EFMIS');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as any;
      if (typeof body === 'object' && body) {
        code = body.code || defaultCode(status);
        message = Array.isArray(body.message) ? body.message.join('; ') : body.message || exception.message;
        details = body.details;
      } else {
        code = defaultCode(status);
        message = String(body);
      }
    } else if (exception instanceof MulterError) {
      status = HttpStatus.BAD_REQUEST;
      code = 'BAD_REQUEST';
      message = exception.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the maximum upload size (MAX_UPLOAD_MB)' : exception.message;
    } else if (exception instanceof QueryFailedError && (exception as any).driverError?.code === '23505') {
      status = HttpStatus.CONFLICT;
      code = 'CONFLICT';
      message = `Duplicate record: ${(exception as any).driverError?.detail || 'unique constraint violated'}`;
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    if (status >= 500 && exception instanceof HttpException) this.logger.error(exception.stack);
    res.status(status).json({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
  }
}

function defaultCode(status: number): string {
  return (
    {
      400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT',
      422: 'VALIDATION_FAILED', 429: 'TOO_MANY_ATTEMPTS'
    } as Record<number, string>
  )[status] || 'ERROR';
}
