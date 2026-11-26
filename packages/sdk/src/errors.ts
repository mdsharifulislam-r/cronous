/** Throw from a handler to mark a permanent failure: Chronos will not retry it. */
export class NonRetryableError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/** Invalid SDK configuration or task definition (thrown synchronously). */
export class ChronosConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChronosConfigError';
  }
}

/**
 * The server rejected this agent in a way reconnecting cannot fix: bad token, wrong
 * project, unsupported protocol version or invalid task definitions.
 */
export class ChronosConnectionError extends Error {
  constructor(
    message: string,
    readonly closeCode: number,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = 'ChronosConnectionError';
  }
}

/** A REST call to Chronos failed. */
export class ChronosRequestError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 for network errors and timeouts. */
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ChronosRequestError';
  }
}

/** 400: the request is invalid (unknown fields, bad delay, payload fails the job's schema). */
export class ChronosValidationError extends ChronosRequestError {
  override name = 'ChronosValidationError';
}

/** 401/403: the token is missing, revoked or not allowed to do this. */
export class ChronosAuthError extends ChronosRequestError {
  override name = 'ChronosAuthError';
}

/** 404: the job, queue or execution does not exist in this project. */
export class ChronosNotFoundError extends ChronosRequestError {
  override name = 'ChronosNotFoundError';
}

/** 409: a state conflict, e.g. the job is disabled, a name exists, or the execution already finished. */
export class ChronosConflictError extends ChronosRequestError {
  override name = 'ChronosConflictError';
}

/** ChronosAdmin.executions.wait() gave up before the execution finished. */
export class ChronosWaitTimeoutError extends Error {
  constructor(
    message: string,
    /** The status when waiting stopped. */
    readonly lastStatus: string,
  ) {
    super(message);
    this.name = 'ChronosWaitTimeoutError';
  }
}
