import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { BootstrapService } from '../src/modules/bootstrap/bootstrap.service';
import { BootstrapResult, api, bearer, bootstrapInstallation, resetState, startTestApp } from './setup/test-app';

describe('API rate limiting', () => {
  let app: NestExpressApplication;
  let boot: BootstrapResult;

  beforeAll(async () => {
    app = await startTestApp({
      CHRONOS_RATE_LIMIT_ENABLED: 'true',
      CHRONOS_RATE_LIMIT_PER_TOKEN_PER_MINUTE: '5',
      CHRONOS_RATE_LIMIT_ANONYMOUS_PER_MINUTE: '4',
      CHRONOS_RATE_LIMIT_AUTH_FAILURES_PER_MINUTE: '3',
    });
  });

  beforeEach(async () => {
    await resetState(app);
    await app.get(BootstrapService).ensureBootstrapToken();
    boot = await bootstrapInstallation(app);
    // Bootstrap itself was an anonymous request: start every test with empty counters.
    const redis = app.get(RedisService);
    const keys = await redis.client.keys(redis.keyspace.key('ratelimit', '*'));
    if (keys.length) await redis.client.del(...keys);
  });

  afterAll(async () => {
    await app.close();
  });

  it('limits each bearer token independently and reports the budget in headers', async () => {
    const user = boot.credentials.userToken.token;
    for (let i = 1; i <= 5; i += 1) {
      const response = await api(app).get('/v1/auth/me').set(...bearer(user)).expect(200);
      expect(response.headers['x-ratelimit-limit']).toBe('5');
      expect(response.headers['x-ratelimit-remaining']).toBe(String(5 - i));
    }
    const limited = await api(app).get('/v1/auth/me').set(...bearer(user)).expect(429);
    expect(limited.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(limited.headers['x-ratelimit-remaining']).toBe('0');

    // Another credential has its own budget.
    await api(app).get(`/v1/projects/${boot.project.id}/jobs`).set(...bearer(boot.credentials.projectKey.token)).expect(200);
  });

  it('limits requests without a token per client address', async () => {
    for (let i = 0; i < 4; i += 1) await api(app).get('/v1/bootstrap/status').expect(200);
    const limited = await api(app).get('/v1/bootstrap/status').expect(429);
    expect(limited.body.error.message).toMatch(/address/);
  });

  it('refuses an address after repeated invalid credentials, before any lookup', async () => {
    for (let i = 0; i < 3; i += 1) await api(app).get('/v1/auth/me').set(...bearer(`chr_u_invalid-token-${i}-0123456789abcdef`)).expect(401);
    const refused = await api(app).get('/v1/auth/me').set(...bearer(boot.credentials.userToken.token)).expect(429);
    expect(refused.body.error.message).toMatch(/failed authentication/);
  });

  it('does not count expired or revoked sessions as attacks', async () => {
    for (let i = 0; i < 5; i += 1) {
      const login = await api(app).post('/v1/auth/login').send({ email: 'admin@example.com', password: 'correct-horse-battery' }).expect(200);
      await api(app).post('/v1/auth/logout').set(...bearer(login.body.data.token)).expect(204);
      await api(app).get('/v1/auth/me').set(...bearer(login.body.data.token)).expect(401); // revoked, but real
      const redis = app.get(RedisService);
      const keys = (await redis.client.keys(redis.keyspace.key('ratelimit', '*'))).filter((key) => key.includes(':ip:'));
      if (keys.length) await redis.client.del(...keys); // keep the anonymous login budget out of the way
    }
    await api(app).get('/v1/auth/me').set(...bearer(boot.credentials.userToken.token)).expect(200);
  });

  it('never limits health probes', async () => {
    for (let i = 0; i < 10; i += 1) await api(app).get('/health/live').expect(200);
  });
});

describe('API rate limiting disabled', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await startTestApp({ CHRONOS_RATE_LIMIT_ENABLED: 'false', CHRONOS_RATE_LIMIT_ANONYMOUS_PER_MINUTE: '1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets every request through and sends no rate-limit headers', async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await api(app).get('/v1/bootstrap/status').expect(200);
      expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });
});
