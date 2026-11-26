import { describe, expect, it } from 'vitest';
import type { Job } from '@/types/api';
import { defaultValues, expectedRunTime, fieldForApiPath, jobFormSchema, stepOf, toJobInput, toSubmission, valuesFromJob, type JobFormValues } from './job-form-model';

const base = (patch: Partial<JobFormValues> = {}): JobFormValues => ({ ...defaultValues('UTC'), name: 'sync-invoices', httpUrl: 'https://app.example.com/hook', ...patch });
const issues = (values: JobFormValues) => {
  const result = jobFormSchema.safeParse(values);
  return result.success ? {} : Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]));
};

describe('job form validation', () => {
  it('accepts a valid scheduled HTTP job', () => {
    expect(issues(base())).toEqual({});
  });

  it('rejects bad names, URLs, JSON and cron', () => {
    const errors = issues(base({ name: '-bad name', httpUrl: 'ftp://x', payloadText: '{oops', cron: '* * *' }));
    expect(Object.keys(errors).sort()).toEqual(['cron', 'httpUrl', 'name', 'payloadText']);
    expect(issues(base({ httpUrl: 'https://user:pw@app.example.com' })).httpUrl).toMatch(/credentials/);
  });

  it('requires a future time or positive delay for delayed jobs', () => {
    expect(issues(base({ kind: 'delayed', delayValue: 0 })).delayValue).toBeDefined();
    expect(issues(base({ kind: 'delayed', delayMode: 'datetime', delayRunAtLocal: '2000-01-01T00:00' })).delayRunAtLocal).toMatch(/future/);
    expect(issues(base({ kind: 'delayed', delayValue: 400, delayUnit: 'd' })).delayValue).toMatch(/365/);
  });

  it('checks retry bounds and the schema JSON', () => {
    expect(issues(base({ backoffValue: 10, backoffUnit: 'm', backoffMaxValue: 1, backoffMaxUnit: 'm' })).backoffMaxValue).toBeDefined();
    expect(issues(base({ payloadSchemaText: '[1]' })).payloadSchemaText).toMatch(/object/);
    expect(issues(base({ priority: '101' })).priority).toBeDefined();
    expect(issues(base({ timeoutValue: 0, timeoutUnit: 's' })).timeoutValue).toBeDefined();
  });

  it('does not require an URL for agent jobs', () => {
    expect(issues(base({ mode: 'AGENT', httpUrl: '' }))).toEqual({});
  });
});

describe('request mapping', () => {
  it('builds a scheduled job request', () => {
    const input = toJobInput(base({ headers: [{ key: 'X-Api-Key', value: 'k' }, { key: '', value: 'ignored' }], authType: 'bearer', authToken: 't', priority: '80', payloadText: '{"a":1}' }), 'create');
    expect(input).toMatchObject({
      name: 'sync-invoices',
      mode: 'HTTP',
      http: { url: 'https://app.example.com/hook', method: 'POST', headers: { 'X-Api-Key': 'k' }, auth: { type: 'bearer', token: 't' } },
      schedule: { cron: '0 2 * * *', timezone: 'UTC', misfirePolicy: 'FIRE_ONCE' },
      payload: { a: 1 },
      priority: 80,
      maxConcurrency: null,
      timeoutMs: 300_000,
      retryBackoffMs: 10_000,
      retryBackoffMaxMs: 3_600_000,
      queue: 'default',
    });
  });

  it('converts a one-time schedule from the chosen zone', () => {
    const input = toJobInput(base({ scheduleType: 'once', runAtLocal: '2026-12-01T09:00', timezone: 'Asia/Dhaka' }), 'create');
    expect(input.schedule).toEqual({ runAt: '2026-12-01T03:00:00.000Z', timezone: 'Asia/Dhaka', misfirePolicy: 'FIRE_ONCE' });
  });

  it('never puts immediate or delayed jobs on a schedule, and submits them separately', () => {
    const immediate = base({ kind: 'immediate', mode: 'WORKER', submitPriority: '90', idempotencyKey: 'k-1' });
    expect(toJobInput(immediate, 'create').schedule).toBeNull();
    expect(toSubmission(immediate)).toEqual({ job: 'sync-invoices', priority: 90, idempotencyKey: 'k-1' });
    expect(toSubmission(base({ kind: 'delayed', delayValue: 5, delayUnit: 'm' }))).toEqual({ job: 'sync-invoices', delayMs: 300_000 });
    expect(toSubmission(base({ kind: 'delayed', delayMode: 'datetime', delayRunAtLocal: '2099-01-01T09:00', timezone: 'Asia/Dhaka' }), Date.UTC(2026, 0, 1))).toEqual({ job: 'sync-invoices', runAt: '2099-01-01T03:00:00.000Z' });
    expect(toSubmission(base({ kind: 'immediate', submitNow: false }))).toBeNull();
    expect(toSubmission(base())).toBeNull();
  });

  it('previews the expected run time of delayed jobs', () => {
    expect(expectedRunTime(base({ kind: 'delayed', delayValue: 2, delayUnit: 'h' }), 0)?.toISOString()).toBe('1970-01-01T02:00:00.000Z');
    expect(expectedRunTime(base())).toBeNull();
  });

  it('keeps masked secrets when editing, and sends null to clear optional settings', () => {
    const job = {
      id: 'j', projectId: 'p', name: 'hook', description: null, mode: 'HTTP', source: 'API', enabled: true, queueId: 'q', queue: 'emails', priority: null, maxConcurrency: 3,
      payloadSchema: null, payload: null, timeoutMs: 60_000, maxAttempts: 5, retryBackoffMs: 2000, retryBackoffMaxMs: 60_000, concurrencyPolicy: 'ALLOW', createdAt: '', updatedAt: '',
      http: { url: 'https://x.example', method: 'POST', headers: { 'X-Api-Key': '********' }, auth: { type: 'bearer', token: '********' }, signingSecret: '********' },
      schedule: null,
    } as Job;
    const values = valuesFromJob(job, 'UTC');
    expect(values).toMatchObject({ kind: 'immediate', queue: 'emails', maxConcurrency: '3', timeoutValue: 1, timeoutUnit: 'm' });
    expect(issues(values)).toEqual({});
    const input = toJobInput(values, 'edit');
    expect(input.name).toBeUndefined();
    expect(input.http).toEqual({ url: 'https://x.example', method: 'POST', headers: { 'X-Api-Key': '********' }, auth: { type: 'bearer', token: '********' }, signingSecret: '********' });
    expect(input).toMatchObject({ schedule: null, payload: null, payloadSchema: null, priority: null, maxConcurrency: 3 });
  });

  it('maps API validation paths to fields and steps', () => {
    expect(fieldForApiPath('schedule.cron')).toBe('cron');
    expect(fieldForApiPath('http.url')).toBe('httpUrl');
    expect(fieldForApiPath('payload.to')).toBe('payloadText');
    expect(fieldForApiPath('unknown')).toBeNull();
    expect(stepOf('cron')).toBe(2);
    expect(stepOf('httpUrl')).toBe(1);
  });
});
