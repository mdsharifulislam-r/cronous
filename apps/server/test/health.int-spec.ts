import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { api, startTestApp } from './setup/test-app';

describe('health endpoints (PostgreSQL + Redis)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live responds without auth or prefix', async () => {
    const response = await api(app).get('/health/live').expect(200);
    expect(response.body.data.status).toBe('alive');
  });

  it('GET /health/ready reports both dependencies up', async () => {
    const response = await api(app).get('/health/ready').expect(200);
    expect(response.body.data.status).toBe('ready');
    expect(response.body.data.checks.postgres.status).toBe('up');
    expect(response.body.data.checks.redis.status).toBe('up');
  });

  it('echoes a safe X-Request-Id and generates one otherwise', async () => {
    const echoed = await api(app).get('/health/live').set('X-Request-Id', 'trace-123');
    expect(echoed.headers['x-request-id']).toBe('trace-123');
    expect(echoed.body.meta.requestId).toBe('trace-123');

    const generated = await api(app).get('/health/live').set('X-Request-Id', 'bad id\twith tab');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('renders unknown routes with the error envelope', async () => {
    // The router rejects unmatched paths before guards run, so no auth is needed for a 404.
    const response = await api(app).get('/v1/does-not-exist').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.meta.requestId).toBe(response.headers['x-request-id']);
  });

  it('serves the dashboard with strict security headers', async () => {
    await api(app).get('/').expect(302).expect('Location', '/dashboard/');
    const page = await api(app).get('/dashboard/').expect(200);
    expect(page.text).toContain('<div id="app"');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['x-frame-options']).toBe('DENY');
    const script = await api(app).get('/dashboard/app.js').expect(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    // No HTML-string sinks: all dynamic text goes through text nodes.
    expect(script.text).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/);
  });

  it('namespaces Redis keys', async () => {
    const redis = app.get(RedisService);
    expect(redis.keyspace.key('probe')).toBe('chronos_test:probe');
    expect(redis.status).toBe('ready');
  });
});
