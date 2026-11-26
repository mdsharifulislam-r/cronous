import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Prisma } from '@chronos/database';
import { AppException } from './app-exception';
import { HttpExceptionFilter } from './http-exception.filter';
import { sanitizeRequestId } from './request-context';
import { ZodValidationPipe } from './zod-validation.pipe';

function render(exception: unknown) {
  const response = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  response.status.mockReturnValue(response);
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ id: 'req-1', originalUrl: '/x' }), getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(exception, host);
  return { status: response.status.mock.calls[0]?.[0] as number, body: response.json.mock.calls[0]?.[0], response };
}

describe('HttpExceptionFilter', () => {
  it('renders AppException with its code and details', () => {
    const { status, body } = render(AppException.conflict('dup', { field: 'slug' }));
    expect(status).toBe(409);
    expect(body).toEqual({
      error: { code: 'CONFLICT', message: 'dup', details: { field: 'slug' } },
      meta: { requestId: 'req-1', apiVersion: '1' },
    });
  });

  it('maps built-in Nest exceptions', () => {
    const { status, body } = render(new NotFoundException('Cannot GET /nope'));
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('maps Prisma unique violations to 409', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['slug'] },
    });
    const { status, body } = render(error);
    expect(status).toBe(409);
    expect(body.error.details).toEqual({ fields: ['slug'] });
  });

  it('maps transaction-start and pool timeouts to a retryable 503', () => {
    for (const code of ['P2024', 'P2028']) {
      const error = new Prisma.PrismaClientKnownRequestError('Unable to start a transaction', { code, clientVersion: 'test' });
      const { status, body, response } = render(error);
      expect(status).toBe(503);
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    }
  });

  it('hides internal error details', () => {
    const { status, body } = render(new Error('password=hunter2 connection refused'));
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  it('sets Retry-After on 429', () => {
    const { response } = render(AppException.tooManyRequests('slow down', 30));
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '30');
  });

  it('reports malformed JSON bodies as 400', () => {
    const { status, body } = render(Object.assign(new Error('Unexpected token'), { status: 400, expose: true, type: 'entity.parse.failed' }));
    expect(status).toBe(400);
    expect(body.error.message).toBe('Malformed JSON body');
  });
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(z.object({ name: z.string().min(2) }).strict());

  it('returns parsed data', () => {
    expect(pipe.transform({ name: 'ok' })).toEqual({ name: 'ok' });
  });

  it('throws VALIDATION_FAILED with issue paths', () => {
    try {
      pipe.transform({ name: 'x', extra: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('VALIDATION_FAILED');
      expect((error as AppException).details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'name' })]),
      );
    }
  });
});

describe('sanitizeRequestId', () => {
  it('accepts short safe ids and rejects anything else', () => {
    expect(sanitizeRequestId('abc-123_x.y:z')).toBe('abc-123_x.y:z');
    expect(sanitizeRequestId('a\nb')).toBeUndefined();
    expect(sanitizeRequestId('x'.repeat(129))).toBeUndefined();
    expect(sanitizeRequestId(['a'])).toBeUndefined();
  });
});
