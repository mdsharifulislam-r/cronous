import { describe, expect, it } from 'vitest';
import { cronCategory, dayKey, groupByDay, monthGrid, timeInZone } from './schedule-utils';

describe('schedule helpers', () => {
  it('categorises cron expressions', () => {
    expect(cronCategory('0 2 * * *')).toBe('Daily');
    expect(cronCategory('0 9 * * 1')).toBe('Weekly');
    expect(cronCategory('0 9 * * 1-5')).toBe('Weekly');
    expect(cronCategory('0 0 1 * *')).toBe('Monthly');
    expect(cronCategory('15 * * * *')).toBe('Hourly');
    expect(cronCategory('* * * * *')).toBe('Every minute');
    expect(cronCategory('*/5 * * * *')).toBe('Custom');
    expect(cronCategory(null)).toBe('Custom');
  });

  it('builds Monday-first month grids', () => {
    const grid = monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(grid[0]?.[0]).toBe('2026-10-26');
    expect(grid[0]?.[6]).toBe('2026-11-01');
    expect(grid.flat()).toContain('2026-11-30');
    expect(grid.every((week) => week.length === 7)).toBe(true);
  });

  it('assigns instants to days in the display time zone', () => {
    expect(dayKey('2026-11-26T20:00:00Z', 'Asia/Dhaka')).toBe('2026-11-27');
    expect(dayKey('2026-11-26T20:00:00Z', 'UTC')).toBe('2026-11-26');
    expect(timeInZone('2026-11-26T20:00:00Z', 'Asia/Dhaka')).toBe('02:00');
    const grouped = groupByDay([{ at: '2026-11-26T20:00:00Z' }, { at: '2026-11-26T01:00:00Z' }], 'Asia/Dhaka');
    expect([...grouped.keys()].sort()).toEqual(['2026-11-26', '2026-11-27']);
  });
});
