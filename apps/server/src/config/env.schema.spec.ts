import { describe, expect, it } from 'vitest';
import { EnvValidationError } from '@chronos/shared';
import { loadServerEnv } from './env.schema';

const base = {
  DATABASE_URL: 'postgresql://chronos:secret@localhost:5432/chronos',
  REDIS_URL: 'redis://localhost:6379',
};

describe('server environment', () => {
  it('applies safe defaults', () => {
    const env = loadServerEnv(base);
    expect(env.PORT).toBe(8080);
    expect(env.CHRONOS_NAMESPACE).toBe('chronos');
    expect(env.CHRONOS_TRUST_PROXY).toBe(false);
    expect(env.CHRONOS_CORS_ORIGINS).toEqual([]);
    expect(env.CHRONOS_BOOTSTRAP_TOKEN).toBeUndefined();
  });

  it('requires database and redis urls with the right scheme', () => {
    expect(() => loadServerEnv({})).toThrow(EnvValidationError);
    expect(() => loadServerEnv({ ...base, REDIS_URL: 'http://localhost:6379' })).toThrow(/REDIS_URL/);
    expect(() => loadServerEnv({ ...base, DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/);
    expect(loadServerEnv({ ...base, REDIS_URL: 'rediss://:pw@redis.internal:6380/2' }).REDIS_URL).toContain('rediss');
  });

  it('rejects unsafe namespaces and short bootstrap tokens', () => {
    expect(() => loadServerEnv({ ...base, CHRONOS_NAMESPACE: 'bull:queue' })).toThrow(/CHRONOS_NAMESPACE/);
    expect(() => loadServerEnv({ ...base, CHRONOS_BOOTSTRAP_TOKEN: 'short' })).toThrow(/CHRONOS_BOOTSTRAP_TOKEN/);
  });

  it('parses CORS origin lists', () => {
    const env = loadServerEnv({ ...base, CHRONOS_CORS_ORIGINS: 'https://a.example, https://b.example' });
    expect(env.CHRONOS_CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('forbids pretty logs in production', () => {
    expect(() => loadServerEnv({ ...base, NODE_ENV: 'production', LOG_PRETTY: 'true' })).toThrow(/LOG_PRETTY/);
  });
});
