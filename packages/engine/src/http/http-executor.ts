import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { Agent, errors as undiciErrors, request } from 'undici';
import type { Prisma } from '@chronos/database';
import type { ClaimedExecution, FailureReport, SuccessReport } from '../executions';
import { BlockedDestinationError, DestinationGuard, DestinationPolicy } from './ssrf';
import { HttpConfig, httpConfigSchema } from './http-config';

export const WEBHOOK_USER_AGENT = 'Chronos-Webhook/0.1';
const MAX_RESPONSE_BYTES = 4096;

export type ExecutionOutcome = { ok: true; report: SuccessReport } | { ok: false; report: FailureReport };

/**
 * Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 * Receivers recompute it and reject stale timestamps to prevent replays.
 */
export function signWebhook(secret: string, timestampSeconds: number, body: string): string {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

/** Maps an HTTP status to retry semantics: 5xx, 408, 425 and 429 are transient. */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

/** Delivers HTTP-mode executions (Mode A). */
export class HttpExecutor {
  private readonly guard: DestinationGuard;
  private readonly dispatcher: Agent;

  constructor(policy: DestinationPolicy) {
    this.guard = new DestinationGuard(policy);
    this.dispatcher = new Agent({
      connect: { lookup: this.guard.lookup as never },
      keepAliveTimeout: 10_000,
      connections: 128,
    });
  }

  async execute(execution: ClaimedExecution, signal: AbortSignal): Promise<ExecutionOutcome> {
    const parsed = httpConfigSchema.safeParse(execution.httpConfig);
    if (!parsed.success) {
      return { ok: false, report: { message: 'Job has no valid HTTP configuration', code: 'INVALID_HTTP_CONFIG', retryable: false } };
    }
    const config: HttpConfig = parsed.data;
    const url = new URL(config.url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      // IP literals skip DNS lookup entirely, so they are checked here.
      const reason = this.guard.check(host);
      if (reason) return blocked(host, reason);
    }

    const body = config.method === 'GET' || config.method === 'DELETE' ? undefined : JSON.stringify(execution.payload ?? {});
    const headers: Record<string, string> = {
      'user-agent': WEBHOOK_USER_AGENT,
      ...lowercase(config.headers),
      'x-chronos-execution-id': execution.executionId,
      'x-chronos-attempt': String(execution.attempt),
      'x-chronos-idempotency-key': execution.idempotencyKey,
      'x-chronos-job': execution.jobName,
      'x-chronos-scheduled-for': execution.scheduledFor.toISOString(),
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (config.auth?.type === 'bearer') headers.authorization = `Bearer ${config.auth.token}`;
    if (config.auth?.type === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64')}`;
    }
    if (config.signingSecret) headers['x-chronos-signature'] = signWebhook(config.signingSecret, Math.floor(Date.now() / 1000), body ?? '');

    try {
      const response = await request(url, {
        method: config.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        dispatcher: this.dispatcher,
        signal,
        headersTimeout: execution.timeoutMs,
        bodyTimeout: execution.timeoutMs,
      });
      const text = await readLimited(response.body);
      const output: Prisma.InputJsonValue = { status: response.statusCode, body: text };
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return { ok: true, report: { httpStatus: response.statusCode, output } };
      }
      if (response.statusCode >= 300 && response.statusCode < 400) {
        return {
          ok: false,
          report: { message: `Endpoint redirected (${response.statusCode}); redirects are not followed`, code: 'REDIRECT', retryable: false, httpStatus: response.statusCode, output },
        };
      }
      return {
        ok: false,
        report: {
          message: `Endpoint responded with HTTP ${response.statusCode}`,
          code: `HTTP_${response.statusCode}`,
          retryable: isRetryableStatus(response.statusCode),
          httpStatus: response.statusCode,
          output,
        },
      };
    } catch (error) {
      return { ok: false, report: this.classify(error, signal) };
    }
  }

  private classify(error: unknown, signal: AbortSignal): FailureReport {
    const cause = (error as { cause?: unknown })?.cause;
    const blockedError = error instanceof BlockedDestinationError ? error : cause instanceof BlockedDestinationError ? cause : null;
    if (blockedError) return blocked(blockedError.address, blockedError.reason).report;
    if (signal.aborted) {
      const reason = signal.reason as { name?: string; message?: string } | undefined;
      const timedOut = reason?.name === 'TimeoutError';
      return { message: timedOut ? 'Webhook timed out' : `Webhook aborted: ${reason?.message ?? 'cancelled'}`, code: timedOut ? 'TIMEOUT' : 'ABORTED', retryable: true, timedOut };
    }
    if (error instanceof undiciErrors.HeadersTimeoutError || error instanceof undiciErrors.BodyTimeoutError) {
      return { message: 'Webhook timed out', code: 'TIMEOUT', retryable: true, timedOut: true };
    }
    const code = (error as { code?: string })?.code ?? (cause as { code?: string })?.code;
    const message = error instanceof Error ? error.message : String(error);
    return { message: `Webhook request failed: ${message}`, code: code ?? 'NETWORK_ERROR', retryable: true };
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}

function blocked(address: string, reason: string): { ok: false; report: FailureReport } {
  return {
    ok: false,
    report: {
      message: `Destination ${address} is blocked (${reason}). Allow it with CHRONOS_WEBHOOK_ALLOWED_CIDRS if intended.`,
      code: 'BLOCKED_DESTINATION',
      retryable: false,
    },
  };
}

function lowercase(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

async function readLimited(body: AsyncIterable<Buffer> & { destroy?: () => void }): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const remaining = MAX_RESPONSE_BYTES - size;
    if (remaining <= 0) break;
    chunks.push(chunk.subarray(0, remaining));
    size += Math.min(chunk.length, remaining);
    if (size >= MAX_RESPONSE_BYTES) break;
  }
  body.destroy?.();
  return Buffer.concat(chunks).toString('utf8');
}
