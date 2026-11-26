import { CronExpressionParser } from 'cron-parser';
import { isValidTimeZone } from './timezone';

/**
 * Cron and one-time schedule arithmetic. Pure functions: callers pass `now` (the
 * scheduler passes the PostgreSQL clock) so behaviour is deterministic and testable.
 *
 * DST behaviour (inherited from cron-parser and covered by tests):
 * - a local time skipped by a spring-forward transition fires once, shifted forward
 *   by the transition (02:30 becomes 03:30);
 * - a local time repeated by a fall-back transition fires once, on its first occurrence.
 */

export type ScheduleKind = 'CRON' | 'ONCE';
export type MisfirePolicyName = 'FIRE_ONCE' | 'SKIP' | 'FIRE_ALL';

/** Standard 5-field cron (minute granularity). Seconds fields are rejected on purpose. */
export function validateCronExpression(expression: string): string | null {
  const trimmed = expression.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return 'cron expression must be 1-120 characters';
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return 'cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week)';
  try {
    CronExpressionParser.parse(trimmed, { tz: 'UTC' });
    return null;
  } catch (error) {
    return `invalid cron expression: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function assertZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) throw new Error(`Invalid IANA time zone "${timeZone}"`);
}

/** First occurrence strictly after `after`. */
export function nextCronOccurrence(expression: string, timeZone: string, after: Date): Date {
  assertZone(timeZone);
  return CronExpressionParser.parse(expression, { currentDate: after, tz: timeZone }).next().toDate();
}

/** The next `count` occurrences strictly after `after` (for previews). */
export function upcomingCronOccurrences(expression: string, timeZone: string, after: Date, count: number): Date[] {
  assertZone(timeZone);
  const iterator = CronExpressionParser.parse(expression, { currentDate: after, tz: timeZone });
  return Array.from({ length: count }, () => iterator.next().toDate());
}

/**
 * Occurrences t with notBefore <= t <= atOrBefore, newest first, at most `limit`.
 * Walking backwards from `now` bounds the work after a long outage: a per-minute
 * schedule that was down for a month costs `limit` iterations, not 43,200.
 */
export function recentCronOccurrences(
  expression: string,
  timeZone: string,
  atOrBefore: Date,
  notBefore: Date,
  limit: number,
): Date[] {
  assertZone(timeZone);
  // prev() is exclusive of currentDate, so start one second later to include an exact match.
  const iterator = CronExpressionParser.parse(expression, {
    currentDate: new Date(atOrBefore.getTime() + 1000),
    tz: timeZone,
  });
  const result: Date[] = [];
  while (result.length < limit) {
    const occurrence = iterator.prev().toDate();
    if (occurrence.getTime() < notBefore.getTime()) break;
    if (occurrence.getTime() <= atOrBefore.getTime()) result.push(occurrence);
  }
  return result;
}

/** Bound on how far back missed occurrences are counted (keeps planning O(1) after long outages). */
export const MISFIRE_COUNT_LIMIT = 1000;

export interface DueScheduleInput {
  type: ScheduleKind;
  cronExpression: string | null;
  runAt: Date | null;
  timezone: string;
  misfirePolicy: MisfirePolicyName;
  misfireGraceMs: number;
  maxCatchUp: number;
  /** The persisted next occurrence; the caller only plans schedules where nextRunAt <= now. */
  nextRunAt: Date;
}

export interface DuePlan {
  /** Occurrences to create executions for, oldest first. */
  fire: Date[];
  /** Due occurrences dropped by the policy or cap (counted up to MISFIRE_COUNT_LIMIT). */
  dropped: number;
  /** The new persisted next occurrence; null when the schedule is finished. */
  nextRunAt: Date | null;
  completed: boolean;
}

/** Decides what to run for a schedule whose nextRunAt has passed, applying the misfire policy. */
export function planDueSchedule(input: DueScheduleInput, now: Date): DuePlan {
  const isLate = (occurrence: Date) => now.getTime() - occurrence.getTime() > input.misfireGraceMs;

  if (input.type === 'ONCE') {
    const due = input.runAt ?? input.nextRunAt;
    const skip = input.misfirePolicy === 'SKIP' && isLate(due);
    return { fire: skip ? [] : [due], dropped: skip ? 1 : 0, nextRunAt: null, completed: true };
  }

  if (!input.cronExpression) throw new Error('CRON schedule without cron expression');
  const nextRunAt = nextCronOccurrence(input.cronExpression, input.timezone, now);
  const cap = input.misfirePolicy === 'FIRE_ALL' ? Math.max(1, input.maxCatchUp) : 1;
  const recent = recentCronOccurrences(
    input.cronExpression,
    input.timezone,
    now,
    input.nextRunAt,
    Math.max(cap, MISFIRE_COUNT_LIMIT),
  );
  const latest = recent[0];
  if (!latest) return { fire: [], dropped: 0, nextRunAt, completed: false };

  let fire: Date[];
  switch (input.misfirePolicy) {
    case 'FIRE_ALL':
      fire = recent.slice(0, cap).reverse();
      break;
    case 'FIRE_ONCE':
      fire = [latest];
      break;
    case 'SKIP':
      fire = isLate(latest) ? [] : [latest];
      break;
  }
  return { fire, dropped: recent.length - fire.length, nextRunAt, completed: false };
}

/** Initial nextRunAt for a newly created or re-timed schedule. */
export function initialNextRunAt(
  spec: { type: ScheduleKind; cronExpression: string | null; runAt: Date | null; timezone: string },
  now: Date,
): Date {
  if (spec.type === 'ONCE') {
    if (!spec.runAt) throw new Error('ONCE schedule without runAt');
    return spec.runAt;
  }
  if (!spec.cronExpression) throw new Error('CRON schedule without cron expression');
  return nextCronOccurrence(spec.cronExpression, spec.timezone, now);
}

/** Idempotency key of a scheduled occurrence; unique per job in job_executions. */
export function occurrenceKey(occurrence: Date): string {
  return `sched:${occurrence.toISOString()}`;
}

/**
 * Exponential backoff with "equal jitter": the delay is uniformly drawn from
 * [d/2, d] where d = min(max, base * 2^(attempt-1)). Jitter prevents synchronised
 * retry storms when many executions fail at once (e.g. a downstream outage).
 */
export function retryDelayMs(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  if (baseMs <= 0) return 0;
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
