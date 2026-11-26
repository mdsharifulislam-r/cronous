import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { hashToken } from '@chronos/shared';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { API_VERSION } from '../../common/http/api-response';
import { clientIp, type ChronosRequest } from '../../common/http/request-context';

export interface Hit {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window resets. */
  resetSeconds: number;
}

const WINDOW_SECONDS = 60;

/**
 * Fixed-window request limits kept in Redis, so every server replica enforces the same
 * budget. Three buckets:
 *  - per bearer token (keyed by a hash of the token: no database lookup is needed);
 *  - per client IP for requests without a token (login, bootstrap);
 *  - failed authentications per client IP: once exceeded, that IP's token-bearing
 *    requests are refused before any credential lookup (protects against token floods).
 *
 * If Redis is unavailable the limiter fails open (requests pass, a warning is logged):
 * rate limiting is protective, and an outage of it must not take the API down.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private lastWarning = 0;

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: ServerEnv,
  ) {}

  get enabled(): boolean {
    return this.config.CHRONOS_RATE_LIMIT_ENABLED;
  }

  private key(bucket: string, id: string): string {
    return this.redis.keyspace.key('ratelimit', bucket, id);
  }

  /** Counts one request against `bucket/id` and reports whether it is within `limit`. */
  async hit(bucket: string, id: string, limit: number): Promise<Hit> {
    const key = this.key(bucket, id);
    try {
      // SET NX starts the window on the first request; INCR counts; TTL tells the reset time.
      const result = await this.redis.client.multi().set(key, '0', 'EX', WINDOW_SECONDS, 'NX').incr(key).ttl(key).exec();
      const count = Number(result?.[1]?.[1] ?? 0);
      const ttl = Number(result?.[2]?.[1] ?? WINDOW_SECONDS);
      return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetSeconds: ttl > 0 ? ttl : WINDOW_SECONDS };
    } catch (error) {
      this.warn(error);
      return { allowed: true, limit, remaining: limit, resetSeconds: WINDOW_SECONDS };
    }
  }

  /** Reads a counter without incrementing it. */
  async peek(bucket: string, id: string): Promise<{ count: number; resetSeconds: number }> {
    const key = this.key(bucket, id);
    try {
      const [count, ttl] = await Promise.all([this.redis.client.get(key), this.redis.client.ttl(key)]);
      return { count: Number(count ?? 0), resetSeconds: ttl > 0 ? ttl : WINDOW_SECONDS };
    } catch (error) {
      this.warn(error);
      return { count: 0, resetSeconds: WINDOW_SECONDS };
    }
  }

  /** Called by the auth guard for every rejected credential. */
  async recordAuthFailure(ip: string | undefined): Promise<void> {
    if (!this.enabled || !ip) return;
    await this.hit('authfail', ip, Number.MAX_SAFE_INTEGER);
  }

  private warn(error: unknown): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    this.logger.warn(`Rate limiter unavailable, allowing requests: ${String(error)}`);
  }

  /**
   * Express middleware for /v1 routes. Health probes are never limited, and the agent
   * WebSocket upgrade does not pass through Express middleware.
   */
  middleware() {
    return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
      if (!this.enabled || !request.path.startsWith('/v1/')) return next();
      const ip = clientIp(request) ?? 'unknown';
      const token = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? '')?.[1];
      try {
        if (token) {
          const failures = await this.peek('authfail', ip);
          if (failures.count >= this.config.CHRONOS_RATE_LIMIT_AUTH_FAILURES_PER_MINUTE) {
            return this.reject(request, response, { allowed: false, limit: this.config.CHRONOS_RATE_LIMIT_AUTH_FAILURES_PER_MINUTE, remaining: 0, resetSeconds: failures.resetSeconds }, 'Too many failed authentication attempts from this address');
          }
          const hit = await this.hit('token', hashToken(token).slice(0, 32), this.config.CHRONOS_RATE_LIMIT_PER_TOKEN_PER_MINUTE);
          this.headers(response, hit);
          if (!hit.allowed) return this.reject(request, response, hit, 'Rate limit exceeded for this credential');
        } else {
          const hit = await this.hit('ip', ip, this.config.CHRONOS_RATE_LIMIT_ANONYMOUS_PER_MINUTE);
          this.headers(response, hit);
          if (!hit.allowed) return this.reject(request, response, hit, 'Rate limit exceeded for this address');
        }
      } catch (error) {
        this.warn(error);
      }
      next();
    };
  }

  private headers(response: Response, hit: Hit): void {
    response.setHeader('X-RateLimit-Limit', String(hit.limit));
    response.setHeader('X-RateLimit-Remaining', String(hit.remaining));
    response.setHeader('X-RateLimit-Reset', String(hit.resetSeconds));
  }

  private reject(request: Request, response: Response, hit: Hit, message: string): void {
    this.headers(response, hit);
    response.setHeader('Retry-After', String(hit.resetSeconds));
    response.status(429).json({
      error: { code: 'TOO_MANY_REQUESTS', message, details: { retryAfterSeconds: hit.resetSeconds } },
      meta: { requestId: (request as ChronosRequest).id, apiVersion: API_VERSION },
    });
  }
}
