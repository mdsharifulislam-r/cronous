/** Every JSON response uses one of these two envelopes. */
export interface ApiSuccess<T> {
  data: T;
  meta: { requestId: string; apiVersion: typeof API_VERSION };
}

export interface ApiFailure {
  error: { code: ErrorCode; message: string; details?: unknown };
  meta: { requestId: string; apiVersion: typeof API_VERSION };
}

export const API_VERSION = '1' as const;

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'TOO_MANY_REQUESTS'
  | 'SERVICE_UNAVAILABLE'
  | 'ALREADY_BOOTSTRAPPED'
  | 'INTERNAL_ERROR';
