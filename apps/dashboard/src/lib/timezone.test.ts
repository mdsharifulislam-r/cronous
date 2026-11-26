import { describe, expect, it } from 'vitest';
import { utcToZonedLocal, zonedLocalToUtc } from './timezone';

describe('time zone conversion', () => {
  it('converts wall-clock time in a zone to UTC', () => {
    expect(zonedLocalToUtc('2026-12-01T09:00', 'Asia/Dhaka')?.toISOString()).toBe('2026-12-01T03:00:00.000Z');
    expect(zonedLocalToUtc('2026-07-01T09:00', 'America/New_York')?.toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedLocalToUtc('2026-01-01T09:00', 'America/New_York')?.toISOString()).toBe('2026-01-01T14:00:00.000Z');
  });

  it('round-trips through the zone', () => {
    expect(utcToZonedLocal('2026-12-01T03:00:00.000Z', 'Asia/Dhaka')).toBe('2026-12-01T09:00');
  });

  it('handles a skipped DST hour by moving forward', () => {
    // 02:30 does not exist on 2026-03-08 in New York (clocks jump 02:00 -> 03:00).
    const result = zonedLocalToUtc('2026-03-08T02:30', 'America/New_York');
    expect(result?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('rejects malformed input and unknown zones', () => {
    expect(zonedLocalToUtc('tomorrow', 'UTC')).toBeNull();
    expect(zonedLocalToUtc('2026-01-01T00:00', 'Mars/Base')).toBeNull();
  });
});
