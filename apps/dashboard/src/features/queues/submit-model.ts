import { z } from 'zod';
import { toMs } from '@/components/forms/duration-input';
import { jsonError } from '@/components/forms/json-editor';
import { isValidTimeZone, zonedLocalToUtc } from '@/lib/timezone';
import type { QueueSubmissionInput } from '@/types/api';

const unit = z.enum(['ms', 's', 'm', 'h', 'd']);
const optionalInt = (min: number, max: number) => z.string().refine((value) => value.trim() === '' || (/^\d+$/.test(value.trim()) && Number(value) >= min && Number(value) <= max), `Empty, or a whole number from ${min} to ${max}`);

/**
 * Submission of an existing job for immediate or delayed execution (POST /queue).
 * Delays are a duration or an absolute time in a time zone; never a cron expression.
 */
export const submitSchema = z
  .object({
    job: z.string().min(1, 'Choose a job'),
    queue: z.string(), // '' = the job's own queue
    payloadText: z.string(),
    delivery: z.enum(['immediate', 'delayed']),
    delayMode: z.enum(['duration', 'datetime']),
    delayValue: z.number(),
    delayUnit: unit,
    runAtLocal: z.string(),
    timezone: z.string(),
    priority: optionalInt(0, 100),
    idempotencyKey: z.string().max(200).regex(/^[\x21-\x7e]*$/, 'Printable characters without spaces'),
    maxAttempts: optionalInt(1, 100),
    backoffValue: z.string(),
    backoffMaxValue: z.string(),
    backoffUnit: unit,
    timeoutValue: z.string(),
    timeoutUnit: unit,
  })
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    const problem = jsonError(value.payloadText);
    if (problem) issue('payloadText', problem);
    if (value.delivery === 'delayed') {
      if (value.delayMode === 'duration') {
        const ms = toMs(value.delayValue, value.delayUnit);
        if (!Number.isFinite(ms) || ms <= 0) issue('delayValue', 'Enter a delay greater than zero');
        else if (ms > 365 * 86_400_000) issue('delayValue', 'At most 365 days');
      } else {
        if (!isValidTimeZone(value.timezone)) issue('timezone', 'Unknown time zone');
        const at = zonedLocalToUtc(value.runAtLocal, value.timezone);
        if (!at) issue('runAtLocal', 'Choose a date and time');
        else if (at.getTime() <= Date.now()) issue('runAtLocal', 'Must be in the future');
        else if (at.getTime() > Date.now() + 365 * 86_400_000) issue('runAtLocal', 'At most 365 days ahead');
      }
    }
    for (const [field, text] of [['backoffValue', value.backoffValue], ['backoffMaxValue', value.backoffMaxValue], ['timeoutValue', value.timeoutValue]] as const) {
      if (text.trim() && !/^\d+(\.\d+)?$/.test(text.trim())) issue(field, 'Enter a number');
    }
    if (value.backoffValue.trim() && value.backoffMaxValue.trim() && Number(value.backoffMaxValue) < Number(value.backoffValue)) issue('backoffMaxValue', 'Must be at least the base delay');
    if (value.timeoutValue.trim()) {
      const ms = toMs(Number(value.timeoutValue), value.timeoutUnit);
      if (ms < 1000 || ms > 86_400_000) issue('timeoutValue', 'Between 1 second and 24 hours');
    }
  });

export type SubmitValues = z.infer<typeof submitSchema>;

export function toQueueSubmission(values: SubmitValues): QueueSubmissionInput {
  const delayed = values.delivery === 'delayed';
  const runAt = delayed && values.delayMode === 'datetime' ? zonedLocalToUtc(values.runAtLocal, values.timezone) : null;
  return {
    job: values.job,
    ...(values.payloadText.trim() ? { payload: JSON.parse(values.payloadText) as unknown } : {}),
    ...(values.queue ? { queue: values.queue } : {}),
    ...(delayed && values.delayMode === 'duration' ? { delayMs: toMs(values.delayValue, values.delayUnit) } : {}),
    ...(runAt ? { runAt: runAt.toISOString() } : {}),
    ...(values.priority.trim() ? { priority: Number(values.priority) } : {}),
    ...(values.idempotencyKey.trim() ? { idempotencyKey: values.idempotencyKey.trim() } : {}),
    ...(values.maxAttempts.trim() ? { maxAttempts: Number(values.maxAttempts) } : {}),
    ...(values.backoffValue.trim() ? { retryBackoffMs: toMs(Number(values.backoffValue), values.backoffUnit) } : {}),
    ...(values.backoffMaxValue.trim() ? { retryBackoffMaxMs: toMs(Number(values.backoffMaxValue), values.backoffUnit) } : {}),
    ...(values.timeoutValue.trim() ? { timeoutMs: toMs(Number(values.timeoutValue), values.timeoutUnit) } : {}),
  };
}

export function expectedAt(values: Pick<SubmitValues, 'delivery' | 'delayMode' | 'delayValue' | 'delayUnit' | 'runAtLocal' | 'timezone'>, now = Date.now()): Date | null {
  if (values.delivery !== 'delayed') return null;
  if (values.delayMode === 'duration') {
    const ms = toMs(values.delayValue, values.delayUnit);
    return Number.isFinite(ms) && ms > 0 ? new Date(now + ms) : null;
  }
  return zonedLocalToUtc(values.runAtLocal, values.timezone);
}
