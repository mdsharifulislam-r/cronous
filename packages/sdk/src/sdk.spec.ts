import { describe, expect, it } from 'vitest';
import { agentSocketUrl, reconnectDelay } from './backoff';
import { Chronos, ChronosConfigError } from './index';

const options = { server: 'https://chronos.example.com', project: 'storefront', token: 'chr_a_x', logger: false as const };

describe('task registration', () => {
  it('registers tasks from any module on a shared instance', () => {
    const chronos = new Chronos(options);
    chronos.task('daily-report', { schedule: '0 2 * * *', timezone: 'Asia/Dhaka' }, async () => undefined);
    chronos.task('on-demand', async () => undefined);
    expect(chronos.taskNames).toEqual(['daily-report', 'on-demand']);
    expect(chronos.status).toBe('idle');
  });

  it('validates definitions at registration time', () => {
    const chronos = new Chronos(options);
    const noop = async () => undefined;
    expect(() => chronos.task('bad name', noop)).toThrow(ChronosConfigError);
    expect(() => chronos.task('x', { schedule: '61 * * * *' }, noop)).toThrow(/invalid cron/);
    expect(() => chronos.task('x', { schedule: '* * * * * *' }, noop)).toThrow(/5 fields/);
    expect(() => chronos.task('x', { schedule: '0 2 * * *', timezone: 'Mars/Base' }, noop)).toThrow(/time zone/);
    expect(() => chronos.task('x', { schedule: '0 2 * * *', runAt: new Date() }, noop)).toThrow(/either/);
    expect(() => chronos.task('x', { timeoutMs: 10 }, noop)).toThrow(/timeoutMs/);
    chronos.task('x', noop);
    expect(() => chronos.task('x', noop)).toThrow(/already registered/);
    expect(() => chronos.task('y', {} as never)).toThrow(/handler/);
  });

  it('applies the instance default time zone', () => {
    const chronos = new Chronos({ ...options, timezone: 'Asia/Dhaka' });
    chronos.task('t', { schedule: '0 2 * * *' }, async () => undefined);
    const registered = (chronos as unknown as { tasks: Map<string, { definition: { schedule: { timezone: string } } }> }).tasks.get('t');
    expect(registered?.definition.schedule.timezone).toBe('Asia/Dhaka');
  });

  it('validates constructor options and requires a token on start', async () => {
    expect(() => new Chronos({ ...options, server: '' })).toThrow(ChronosConfigError);
    expect(() => new Chronos({ ...options, server: 'ftp://x' })).toThrow(/scheme/);
    expect(() => new Chronos({ ...options, concurrency: 0 })).toThrow(/concurrency/);
    const previous = process.env.CHRONOS_AGENT_TOKEN;
    delete process.env.CHRONOS_AGENT_TOKEN;
    await expect(new Chronos({ ...options, token: undefined }).start()).rejects.toThrow(/token/);
    if (previous !== undefined) process.env.CHRONOS_AGENT_TOKEN = previous;
  });
});

describe('connection helpers', () => {
  it('derives the agent socket URL', () => {
    expect(agentSocketUrl('https://chronos.example.com', '/v1/agent/ws')).toBe('wss://chronos.example.com/v1/agent/ws');
    expect(agentSocketUrl('http://localhost:8080/', '/v1/agent/ws')).toBe('ws://localhost:8080/v1/agent/ws');
    expect(agentSocketUrl('https://example.com/chronos', '/v1/agent/ws')).toBe('wss://example.com/chronos/v1/agent/ws');
  });

  it('uses full-jitter exponential backoff with a cap', () => {
    expect(reconnectDelay(0, 500, 30_000, () => 0.999)).toBe(499);
    expect(reconnectDelay(3, 500, 30_000, () => 0.5)).toBe(2000);
    expect(reconnectDelay(30, 500, 30_000, () => 0.999)).toBeLessThan(30_000);
    expect(reconnectDelay(5, 500, 30_000, () => 0)).toBe(0);
  });
});
