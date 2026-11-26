import { z } from 'zod';
import { fromMs, toMs, type DurationUnit } from '@/components/forms/duration-input';
import { jsonError } from '@/components/forms/json-editor';
import { isValidTimeZone, utcToZonedLocal, zonedLocalToUtc } from '@/lib/timezone';
import type { ExecutionMode, HttpConfig, Job, JobInput, QueueSubmissionInput } from '@/types/api';

/**
 * Form model for creating and editing jobs. "Kind" is how the job will run:
 *  - scheduled: a cron or one-time schedule is saved on the job
 *  - immediate / delayed: an on-demand job (no schedule); optionally submitted right away
 *    through POST /queue, now or after a delay. Delays are never expressed as cron.
 */
export const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const unit = z.enum(['ms', 's', 'm', 'h', 'd']);
const optionalInt = (min: number, max: number) =>
  z.string().refine((value) => value.trim() === '' || (/^\d+$/.test(value.trim()) && Number(value) >= min && Number(value) <= max), { message: `Whole number from ${min} to ${max}` });

export const CRON_PRESETS = [
  { label: 'Every minute', value: '* * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Daily at 02:00', value: '0 2 * * *' },
  { label: 'Weekdays at 09:00', value: '0 9 * * 1-5' },
  { label: 'Weekly, Monday 09:00', value: '0 9 * * 1' },
  { label: 'Monthly, 1st at 00:00', value: '0 0 1 * *' },
] as const;

export const jobFormSchema = z
  .object({
    name: z.string().trim().regex(JOB_NAME, 'Start with a letter or digit; letters, digits, ".", "_", ":" and "-" only (max 128)'),
    description: z.string().max(500),
    kind: z.enum(['scheduled', 'immediate', 'delayed']),
    queue: z.string().min(1, 'Choose a queue'),
    mode: z.enum(['HTTP', 'AGENT', 'WORKER']),
    httpUrl: z.string(),
    httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    headers: z.array(z.object({ key: z.string(), value: z.string() })),
    authType: z.enum(['none', 'bearer', 'basic']),
    authToken: z.string(),
    authUsername: z.string(),
    authPassword: z.string(),
    signingSecret: z.string(),
    payloadText: z.string(),
    timeoutValue: z.number(),
    timeoutUnit: unit,
    priority: optionalInt(0, 100),
    maxConcurrency: optionalInt(1, 100_000),
    scheduleType: z.enum(['cron', 'once']),
    cron: z.string(),
    runAtLocal: z.string(),
    timezone: z.string(),
    misfirePolicy: z.enum(['FIRE_ONCE', 'SKIP', 'FIRE_ALL']),
    enabled: z.boolean(),
    submitNow: z.boolean(),
    submitPriority: optionalInt(0, 100),
    idempotencyKey: z.string().max(200).regex(/^[\x21-\x7e]*$/, 'Printable characters without spaces'),
    delayMode: z.enum(['duration', 'datetime']),
    delayValue: z.number(),
    delayUnit: unit,
    delayRunAtLocal: z.string(),
    maxAttempts: z.number().int('Whole number').min(1, 'At least 1').max(100, 'At most 100'),
    backoffValue: z.number().min(0),
    backoffUnit: unit,
    backoffMaxValue: z.number().min(0),
    backoffMaxUnit: unit,
    concurrencyPolicy: z.enum(['ALLOW', 'FORBID']),
    payloadSchemaText: z.string(),
  })
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (value.mode === 'HTTP') {
      try {
        const url = new URL(value.httpUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') issue('httpUrl', 'Must be an http(s) URL');
        if (url.username || url.password) issue('httpUrl', 'Do not put credentials in the URL; use Authentication');
      } catch {
        issue('httpUrl', 'Enter a full URL, e.g. https://app.example.com/hooks/sync');
      }
      if (value.authType === 'bearer' && !value.authToken) issue('authToken', 'Required');
      if (value.authType === 'basic' && !value.authUsername) issue('authUsername', 'Required');
      if (value.signingSecret && value.signingSecret !== '********' && value.signingSecret.length < 16) issue('signingSecret', 'At least 16 characters');
      value.headers.forEach((header, index) => {
        if (header.key && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(header.key)) issue(`headers.${index}.key`, 'Invalid header name');
      });
    }
    const payloadProblem = jsonError(value.payloadText);
    if (payloadProblem) issue('payloadText', payloadProblem);
    const schemaProblem = jsonError(value.payloadSchemaText);
    if (schemaProblem) issue('payloadSchemaText', schemaProblem);
    else if (value.payloadSchemaText.trim() && (typeof JSON.parse(value.payloadSchemaText) !== 'object' || Array.isArray(JSON.parse(value.payloadSchemaText)))) issue('payloadSchemaText', 'Must be a JSON object');
    const timeout = toMs(value.timeoutValue, value.timeoutUnit);
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 86_400_000) issue('timeoutValue', 'Between 1 second and 24 hours');
    if (!isValidTimeZone(value.timezone)) issue('timezone', 'Unknown time zone');

    if (value.kind === 'scheduled') {
      if (value.scheduleType === 'cron' && value.cron.trim().split(/\s+/).length !== 5) issue('cron', 'Five fields: minute hour day-of-month month day-of-week');
      if (value.scheduleType === 'once') {
        const at = zonedLocalToUtc(value.runAtLocal, value.timezone);
        if (!at) issue('runAtLocal', 'Choose a date and time');
      }
    }
    if (value.kind === 'delayed' && value.submitNow) {
      if (value.delayMode === 'duration') {
        const ms = toMs(value.delayValue, value.delayUnit);
        if (!Number.isFinite(ms) || ms <= 0) issue('delayValue', 'Enter a delay greater than zero');
        else if (ms > 365 * 86_400_000) issue('delayValue', 'At most 365 days');
      } else {
        const at = zonedLocalToUtc(value.delayRunAtLocal, value.timezone);
        if (!at) issue('delayRunAtLocal', 'Choose a date and time');
        else if (at.getTime() <= Date.now()) issue('delayRunAtLocal', 'Must be in the future');
      }
    }
    const base = toMs(value.backoffValue, value.backoffUnit);
    const max = toMs(value.backoffMaxValue, value.backoffMaxUnit);
    if (base > 86_400_000) issue('backoffValue', 'At most 24 hours');
    if (max > 7 * 86_400_000) issue('backoffMaxValue', 'At most 7 days');
    if (max < base) issue('backoffMaxValue', 'Must be at least the base delay');
  });

export type JobFormValues = z.infer<typeof jobFormSchema>;

/** Fields validated by each wizard step. */
export const STEP_FIELDS: (keyof JobFormValues)[][] = [
  ['name', 'description', 'kind', 'queue'],
  ['mode', 'httpUrl', 'httpMethod', 'headers', 'authType', 'authToken', 'authUsername', 'authPassword', 'signingSecret', 'payloadText', 'timeoutValue', 'priority', 'maxConcurrency'],
  ['scheduleType', 'cron', 'runAtLocal', 'timezone', 'misfirePolicy', 'enabled', 'submitNow', 'submitPriority', 'idempotencyKey', 'delayValue', 'delayRunAtLocal'],
  ['maxAttempts', 'backoffValue', 'backoffMaxValue', 'concurrencyPolicy', 'payloadSchemaText'],
];

/** Maps API validation paths (e.g. "http.url", "schedule.cron") to form fields. */
export function fieldForApiPath(path: string): keyof JobFormValues | null {
  if (path === 'name') return 'name';
  if (path === 'queue') return 'queue';
  if (path.startsWith('http.url')) return 'httpUrl';
  if (path.startsWith('http.headers')) return 'headers';
  if (path.startsWith('http.auth')) return 'authToken';
  if (path.startsWith('http.signingSecret')) return 'signingSecret';
  if (path.startsWith('http')) return 'httpUrl';
  if (path === 'schedule.cron' || path === 'schedule') return 'cron';
  if (path === 'schedule.runAt') return 'runAtLocal';
  if (path === 'schedule.timezone') return 'timezone';
  if (path.startsWith('payloadSchema')) return 'payloadSchemaText';
  if (path.startsWith('payload')) return 'payloadText';
  if (path === 'timeoutMs') return 'timeoutValue';
  if (path === 'maxAttempts') return 'maxAttempts';
  if (path === 'retryBackoffMs') return 'backoffValue';
  if (path === 'retryBackoffMaxMs') return 'backoffMaxValue';
  if (path === 'priority') return 'priority';
  if (path === 'maxConcurrency') return 'maxConcurrency';
  return null;
}

export function stepOf(field: keyof JobFormValues): number {
  const index = STEP_FIELDS.findIndex((fields) => fields.includes(field));
  return index < 0 ? 0 : index;
}

export function defaultValues(timezone: string, queue = 'default'): JobFormValues {
  return {
    name: '',
    description: '',
    kind: 'scheduled',
    queue,
    mode: 'HTTP',
    httpUrl: '',
    httpMethod: 'POST',
    headers: [],
    authType: 'none',
    authToken: '',
    authUsername: '',
    authPassword: '',
    signingSecret: '',
    payloadText: '',
    timeoutValue: 5,
    timeoutUnit: 'm',
    priority: '',
    maxConcurrency: '',
    scheduleType: 'cron',
    cron: '0 2 * * *',
    runAtLocal: '',
    timezone,
    misfirePolicy: 'FIRE_ONCE',
    enabled: true,
    submitNow: true,
    submitPriority: '',
    idempotencyKey: '',
    delayMode: 'duration',
    delayValue: 5,
    delayUnit: 'm',
    delayRunAtLocal: '',
    maxAttempts: 3,
    backoffValue: 10,
    backoffUnit: 's',
    backoffMaxValue: 1,
    backoffMaxUnit: 'h',
    concurrencyPolicy: 'ALLOW',
    payloadSchemaText: '',
  };
}

/** Values for editing an existing job. Masked secrets ("********") are kept as-is: the API restores them. */
export function valuesFromJob(job: Job, projectTimeZone: string): JobFormValues {
  const timeout = fromMs(job.timeoutMs);
  const backoff = fromMs(job.retryBackoffMs);
  const backoffMax = fromMs(job.retryBackoffMaxMs);
  const http = job.http;
  const zone = job.schedule?.timezone ?? projectTimeZone;
  return {
    ...defaultValues(zone, job.queue),
    name: job.name,
    description: job.description ?? '',
    kind: job.schedule ? 'scheduled' : 'immediate',
    mode: job.mode,
    httpUrl: http?.url ?? '',
    httpMethod: http?.method ?? 'POST',
    headers: Object.entries(http?.headers ?? {}).map(([key, value]) => ({ key, value })),
    authType: http?.auth?.type ?? 'none',
    authToken: http?.auth?.type === 'bearer' ? http.auth.token : '',
    authUsername: http?.auth?.type === 'basic' ? http.auth.username : '',
    authPassword: http?.auth?.type === 'basic' ? http.auth.password : '',
    signingSecret: http?.signingSecret ?? '',
    payloadText: job.payload === null || job.payload === undefined ? '' : JSON.stringify(job.payload, null, 2),
    timeoutValue: timeout.value,
    timeoutUnit: timeout.unit,
    priority: job.priority === null ? '' : String(job.priority),
    maxConcurrency: job.maxConcurrency === null ? '' : String(job.maxConcurrency),
    scheduleType: job.schedule?.type === 'ONCE' ? 'once' : 'cron',
    cron: job.schedule?.cron ?? '0 2 * * *',
    runAtLocal: job.schedule?.runAt ? utcToZonedLocal(job.schedule.runAt, zone) : '',
    misfirePolicy: job.schedule?.misfirePolicy ?? 'FIRE_ONCE',
    enabled: job.enabled,
    submitNow: false,
    maxAttempts: job.maxAttempts,
    backoffValue: backoff.value,
    backoffUnit: backoff.unit,
    backoffMaxValue: backoffMax.value,
    backoffMaxUnit: backoffMax.unit,
    concurrencyPolicy: job.concurrencyPolicy,
    payloadSchemaText: job.payloadSchema ? JSON.stringify(job.payloadSchema, null, 2) : '',
  };
}

function httpConfig(values: JobFormValues): HttpConfig {
  const headers = Object.fromEntries(values.headers.filter((header) => header.key.trim()).map((header) => [header.key.trim(), header.value]));
  return {
    url: values.httpUrl.trim(),
    method: values.httpMethod,
    headers,
    ...(values.authType === 'bearer' ? { auth: { type: 'bearer' as const, token: values.authToken } } : {}),
    ...(values.authType === 'basic' ? { auth: { type: 'basic' as const, username: values.authUsername, password: values.authPassword } } : {}),
    ...(values.signingSecret ? { signingSecret: values.signingSecret } : {}),
  };
}

const intOrNull = (text: string) => (text.trim() === '' ? null : Number(text));

/** Request body for POST/PATCH /jobs. */
export function toJobInput(values: JobFormValues, purpose: 'create' | 'edit'): JobInput {
  const mode: ExecutionMode = values.mode;
  const payload = values.payloadText.trim() ? (JSON.parse(values.payloadText) as unknown) : null;
  const schedule =
    values.kind === 'scheduled'
      ? values.scheduleType === 'cron'
        ? { cron: values.cron.trim(), timezone: values.timezone, misfirePolicy: values.misfirePolicy }
        : { runAt: zonedLocalToUtc(values.runAtLocal, values.timezone)!.toISOString(), timezone: values.timezone, misfirePolicy: values.misfirePolicy }
      : null;
  return {
    ...(purpose === 'create' ? { name: values.name.trim() } : {}),
    description: values.description.trim() || null,
    mode,
    enabled: values.enabled,
    ...(mode === 'HTTP' ? { http: httpConfig(values) } : {}),
    ...(purpose === 'create' ? (payload === null ? {} : { payload }) : { payload }),
    schedule,
    timeoutMs: toMs(values.timeoutValue, values.timeoutUnit),
    maxAttempts: values.maxAttempts,
    retryBackoffMs: toMs(values.backoffValue, values.backoffUnit),
    retryBackoffMaxMs: toMs(values.backoffMaxValue, values.backoffMaxUnit),
    concurrencyPolicy: values.concurrencyPolicy,
    queue: values.queue,
    priority: intOrNull(values.priority),
    maxConcurrency: intOrNull(values.maxConcurrency),
    payloadSchema: values.payloadSchemaText.trim() ? (JSON.parse(values.payloadSchemaText) as Record<string, unknown>) : null,
  };
}

/** Submission after creating an immediate/delayed job (null when nothing should be submitted). */
export function toSubmission(values: JobFormValues, now = Date.now()): QueueSubmissionInput | null {
  if (values.kind === 'scheduled' || !values.submitNow) return null;
  const base: QueueSubmissionInput = {
    job: values.name.trim(),
    ...(values.submitPriority.trim() ? { priority: Number(values.submitPriority) } : {}),
    ...(values.idempotencyKey.trim() ? { idempotencyKey: values.idempotencyKey.trim() } : {}),
  };
  if (values.kind === 'immediate') return base;
  if (values.delayMode === 'duration') return { ...base, delayMs: toMs(values.delayValue, values.delayUnit as DurationUnit) };
  const at = zonedLocalToUtc(values.delayRunAtLocal, values.timezone);
  return at ? { ...base, ...(at.getTime() > now ? { runAt: at.toISOString() } : {}) } : base;
}

/** When a delayed submission is expected to run (for the preview). */
export function expectedRunTime(values: JobFormValues, now = Date.now()): Date | null {
  if (values.kind !== 'delayed') return null;
  if (values.delayMode === 'duration') {
    const ms = toMs(values.delayValue, values.delayUnit);
    return Number.isFinite(ms) && ms > 0 ? new Date(now + ms) : null;
  }
  return zonedLocalToUtc(values.delayRunAtLocal, values.timezone);
}
