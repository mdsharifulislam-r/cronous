import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from './api-response';

/**
 * Domain-level HTTP error with a stable machine-readable code. Services throw these;
 * the exception filter renders them into the standard error envelope.
 */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }

  static badRequest(message: string, details?: unknown): AppException {
    return new AppException(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message = 'Authentication required'): AppException {
    return new AppException(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'You do not have permission to perform this action'): AppException {
    return new AppException(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);
  }

  static notFound(resource: string): AppException {
    return new AppException(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${resource} not found`);
  }

  static conflict(message: string, details?: unknown): AppException {
    return new AppException(HttpStatus.CONFLICT, 'CONFLICT', message, details);
  }

  static tooManyRequests(message: string, retryAfterSeconds?: number): AppException {
    return new AppException(HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_REQUESTS', message, { retryAfterSeconds });
  }
}
