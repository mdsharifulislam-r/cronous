import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { API_VERSION, ApiSuccess } from './api-response';
import type { ChronosRequest } from './request-context';

/** Wraps every successful controller result in `{ data, meta }`. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<ChronosRequest>();
    return next.handle().pipe(
      map((data: unknown) => {
        if (data instanceof StreamableFile) return data;
        const body: ApiSuccess<unknown> = {
          data: data ?? null,
          meta: { requestId: request.id, apiVersion: API_VERSION },
        };
        return body;
      }),
    );
  }
}
