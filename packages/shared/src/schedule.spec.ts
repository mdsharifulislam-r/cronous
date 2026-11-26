import { describe, expect, it } from 'vitest';
import {
  DueScheduleInput,
  initialNextRunAt,
  nextCronOccurrence,
  occurrenceKey,
  planDueSchedule,
  recentCronOccurrences,
  retryDelayMs,
  upcomingCronOccurrences,
  validateCronExpression,
} from './schedule';

const iso = (value: string) => new Date(value);

describe('cron validation', () => {
  it('accepts standard 5-field expressions', () => {
    expect(validateCronExpression('0 2 * * *')).toBeNull();
    expect(validateCronExpression('*/15 9-17 * * 1-5')).toBeNull();
  });

  it('rejects malformed, out-of-range and seconds-level expressions', () => {
    expect(validateCronExpression('')).toMatch(/1-120/);
    expect(validateCronExpression('61 * * * *')).toMatch(/invalid/);
    expect(validateCronExpression('*/5 * * * * *')).toMatch(/exactly 5 fields/);
    expect(validateCronExpression('every day')).toMatch(/exactly 5 fields/);
  });
});

describe('timezone-aware occurrences', () => {
  it('evaluates the expression in the schedule time zone', () => {
    // 02:00 in Dhaka (UTC+6) is 20:00 UTC the previous day.
    expect(nextCronOccurrence('0 2 * * *', 'Asia/Dhaka', iso('2026-11-25T00:00:00Z')).toISOString()).toBe(
      '2026-11-25T20:00:00.000Z',
    );
    expect(nextCronOccurrence('0 2 * * *', 'UTC', iso('2026-11-25T00:00:00Z')).toISOString()).toBe('2026-11-25T02:00:00.000Z');
  });

  it('returns strictly-later occurrences', () => {
    expect(nextCronOccurrence('*/15 * * * *', 'UTC', iso('2026-11-25T10:15:00Z')).toISOString()).toBe('2026-11-25T10:30:00.000Z');
  });

  it('fires a time skipped by spring-forward once, shifted by the transition', () => {
    // 2026-03-08 02:30 does not exist in New York; it fires at 03:30 EDT (07:30Z).
    const [first, second] = upcomingCronOccurrences('30 2 * * *', 'America/New_York', iso('2026-03-07T12:00:00Z'), 2);
    expect(first?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(second?.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('fires a time repeated by fall-back only once', () => {
    // 2026-11-01 01:30 happens twice in New York; only the first (EDT, 05:30Z) fires.
    const occurrences = upcomingCronOccurrences('30 1 * * *', 'America/New_York', iso('2026-10-31T12:00:00Z'), 2);
    expect(occurrences.map((d) => d.toISOString())).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  });

  it('walks back over recent occurrences inclusively and bounded', () => {
    const recent = recentCronOccurrences('*/15 * * * *', 'UTC', iso('2026-11-25T10:15:00Z'), iso('2026-11-25T09:30:00Z'), 10);
    expect(recent.map((d) => d.toISOString())).toEqual([
      '2026-11-25T10:15:00.000Z',
      '2026-11-25T10:00:00.000Z',
      '2026-11-25T09:45:00.000Z',
      '2026-11-25T09:30:00.000Z',
    ]);
    expect(recentCronOccurrences('* * * * *', 'UTC', iso('2026-11-25T10:00:00Z'), iso('2026-10-01T00:00:00Z'), 3)).toHaveLength(3);
  });
});

describe('planDueSchedule', () => {
  const base: DueScheduleInput = {
    type: 'CRON',
    cronExpression: '*/10 * * * *',
    runAt: null,
    timezone: 'UTC',
    misfirePolicy: 'FIRE_ONCE',
    misfireGraceMs: 60_000,
    maxCatchUp: 5,
    nextRunAt: iso('2026-11-25T10:00:00Z'),
  };

  it('fires an on-time occurrence under every policy', () => {
    const now = iso('2026-11-25T10:00:00.700Z');
    for (const misfirePolicy of ['FIRE_ONCE', 'SKIP', 'FIRE_ALL'] as const) {
      const plan = planDueSchedule({ ...base, misfirePolicy }, now);
      expect(plan.fire.map((d) => d.toISOString())).toEqual(['2026-11-25T10:00:00.000Z']);
      expect(plan.nextRunAt?.toISOString()).toBe('2026-11-25T10:10:00.000Z');
      expect(plan.dropped).toBe(0);
    }
  });

  // Down from 10:00 to 10:35: missed 10:00, 10:10, 10:20, 10:30.
  const afterOutage = iso('2026-11-25T10:35:00Z');

  it('FIRE_ONCE runs a single catch-up for the latest missed occurrence', () => {
    const plan = planDueSchedule(base, afterOutage);
    expect(plan.fire.map((d) => d.toISOString())).toEqual(['2026-11-25T10:30:00.000Z']);
    expect(plan.dropped).toBe(3);
    expect(plan.nextRunAt?.toISOString()).toBe('2026-11-25T10:40:00.000Z');
  });

  it('SKIP drops late occurrences', () => {
    const plan = planDueSchedule({ ...base, misfirePolicy: 'SKIP' }, afterOutage);
    expect(plan.fire).toEqual([]);
    expect(plan.dropped).toBe(4);
    expect(plan.nextRunAt?.toISOString()).toBe('2026-11-25T10:40:00.000Z');
  });

  it('SKIP still fires an occurrence that is within the grace period', () => {
    const plan = planDueSchedule({ ...base, misfirePolicy: 'SKIP' }, iso('2026-11-25T10:30:30Z'));
    expect(plan.fire.map((d) => d.toISOString())).toEqual(['2026-11-25T10:30:00.000Z']);
  });

  it('FIRE_ALL replays missed occurrences oldest first, capped by maxCatchUp', () => {
    const all = planDueSchedule({ ...base, misfirePolicy: 'FIRE_ALL' }, afterOutage);
    expect(all.fire.map((d) => d.toISOString().slice(11, 16))).toEqual(['10:00', '10:10', '10:20', '10:30']);
    expect(all.dropped).toBe(0);

    const capped = planDueSchedule({ ...base, misfirePolicy: 'FIRE_ALL', maxCatchUp: 2 }, afterOutage);
    expect(capped.fire.map((d) => d.toISOString().slice(11, 16))).toEqual(['10:20', '10:30']);
    expect(capped.dropped).toBe(2);
  });

  it('completes ONCE schedules and honours SKIP for late one-time runs', () => {
    const once = { ...base, type: 'ONCE' as const, cronExpression: null, runAt: iso('2026-11-25T10:00:00Z') };
    expect(planDueSchedule(once, iso('2026-11-25T10:00:01Z'))).toMatchObject({ completed: true, nextRunAt: null });
    expect(planDueSchedule(once, iso('2026-11-25T10:00:01Z')).fire).toHaveLength(1);
    expect(planDueSchedule({ ...once, misfirePolicy: 'SKIP' }, iso('2026-11-25T12:00:00Z')).fire).toHaveLength(0);
    expect(planDueSchedule({ ...once, misfirePolicy: 'FIRE_ONCE' }, iso('2026-11-25T12:00:00Z')).fire).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('computes initial next run times', () => {
    const now = iso('2026-11-25T10:05:00Z');
    expect(initialNextRunAt({ type: 'CRON', cronExpression: '0 * * * *', runAt: null, timezone: 'UTC' }, now).toISOString()).toBe(
      '2026-11-25T11:00:00.000Z',
    );
    const runAt = iso('2026-12-01T00:00:00Z');
    expect(initialNextRunAt({ type: 'ONCE', cronExpression: null, runAt, timezone: 'UTC' }, now)).toEqual(runAt);
  });

  it('builds stable occurrence keys', () => {
    expect(occurrenceKey(iso('2026-11-25T10:00:00Z'))).toBe('sched:2026-11-25T10:00:00.000Z');
  });

  it('backs off exponentially with bounded jitter', () => {
    expect(retryDelayMs(1, 1000, 60_000, () => 0)).toBe(500);
    expect(retryDelayMs(1, 1000, 60_000, () => 1)).toBe(1000);
    expect(retryDelayMs(4, 1000, 60_000, () => 1)).toBe(8000);
    expect(retryDelayMs(20, 1000, 60_000, () => 1)).toBe(60_000);
    expect(retryDelayMs(3, 0, 60_000)).toBe(0);
  });
});
