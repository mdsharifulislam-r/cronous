/** Calendar and cron helpers for the Schedules page (display only; timing comes from the API). */

/** Human category of a 5-field cron expression. */
export function cronCategory(cron: string | null): 'Every minute' | 'Hourly' | 'Daily' | 'Weekly' | 'Monthly' | 'Custom' {
  if (!cron) return 'Custom';
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return 'Custom';
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const fixed = (value: string) => /^\d+$/.test(value);
  if (cron.trim() === '* * * * *') return 'Every minute';
  if (fixed(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') return 'Hourly';
  if (fixed(minute) && fixed(hour) && dom === '*' && month === '*' && dow === '*') return 'Daily';
  if (fixed(minute) && fixed(hour) && dom === '*' && month === '*' && dow !== '*') return 'Weekly';
  if (fixed(minute) && fixed(hour) && fixed(dom) && month === '*' && dow === '*') return 'Monthly';
  return 'Custom';
}

/** "YYYY-MM-DD" of an instant in a time zone. */
export function dayKey(value: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function timeInZone(value: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

/** Weeks (Monday first) covering a month: arrays of "YYYY-MM-DD", with neighbouring days included. */
export function monthGrid(year: number, month: number): string[][] {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (first.getUTCDay() + 6) % 7; // Monday = 0
  const start = Date.UTC(year, month, 1 - offset);
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const weeks = Math.ceil((offset + daysInMonth) / 7);
  return Array.from({ length: weeks }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => new Date(start + (week * 7 + day) * 86_400_000).toISOString().slice(0, 10)),
  );
}

export function groupByDay<T extends { at: string }>(items: T[], timeZone: string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = dayKey(item.at, timeZone);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}
