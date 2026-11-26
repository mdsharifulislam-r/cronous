import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '@chronos/database';
import { API_VERSION, ApiFailure, ErrorCode } from './api-response';
import type { ChronosRequest } from './request-context';

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
};

interface Rendered {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Renders every error into the standard envelope. Internal errors are logged with the
 * request id and returned without stack traces or driver messages.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const request = http.getRequest<ChronosRequest>();
    const response = http.getResponse<Response>();

    const rendered = this.render(exception);
    if (rendered.status >= 500 && rendered.code === 'INTERNAL_ERROR') {
      this.logger.error(
        { err: exception, requestId: request.id, path: request.originalUrl },
        'Unhandled error while processing request',
      );
    }

    const retryAfter = (rendered.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if ((rendered.status === 429 || rendered.status === 503) && retryAfter) response.setHeader('Retry-After', String(retryAfter));

    const body: ApiFailure = {
      error: {
        code: rendered.code,
        message: rendered.message,
        ...(rendered.details !== undefined ? { details: rendered.details } : {}),
      },
      meta: { requestId: request.id, apiVersion: API_VERSION },
    };
    response.status(rendered.status).json(body);
  }

  private render(exception: unknown): Rendered {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'object' && payload !== null && 'code' in payload) {
        const { code, message, details } = payload as { code: ErrorCode; message: string; details?: unknown };
        return { status, code, message, details };
      }
      const message =
        typeof payload === 'string'
          ? payload
          : Array.isArray((payload as { message?: unknown }).message)
            ? ((payload as { message: string[] }).message.join('; '))
            : String((payload as { message?: unknown }).message ?? exception.message);
      return { status, code: STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'), message };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          status: HttpStatus.CONFLICT,
          code: 'CONFLICT',
          message: 'A resource with the same unique attributes already exists',
          details: { fields: (exception.meta as { target?: unknown } | undefined)?.target },
        };
      }
      // Pool exhausted / transaction could not start in time: transient overload, retryable.
      if (exception.code === 'P2024' || exception.code === 'P2028') {
        this.logger.warn(`Database busy (${exception.code}): ${exception.message}`);
        return {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'SERVICE_UNAVAILABLE',
          message: 'Database is busy, retry shortly',
          details: { retryAfterSeconds: 1 },
        };
      }
      if (exception.code === 'P2025') {
        return { status: HttpStatus.NOT_FOUND, code: 'NOT_FOUND', message: 'Resource not found' };
      }
    }

    // Body parser errors (malformed JSON, too large) carry a status and an `expose` flag.
    const maybeHttp = exception as { status?: number; expose?: boolean; message?: string; type?: string };
    if (typeof maybeHttp?.status === 'number' && maybeHttp.expose) {
      return {
        status: maybeHttp.status,
        code: STATUS_CODES[maybeHttp.status] ?? 'BAD_REQUEST',
        message: maybeHttp.type === 'entity.parse.failed' ? 'Malformed JSON body' : (maybeHttp.message ?? 'Bad request'),
      };
    }

    return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL_ERROR', message: 'Internal server error' };
  }
}
