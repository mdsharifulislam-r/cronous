/**
 * Converts a wall-clock time in an IANA zone ("2026-12-01T09:00" in "Asia/Dhaka") to a UTC
 * instant. Handles DST: for a skipped local time the result moves forward by the gap, and
 * for a repeated one the earlier instant is used.
 */
function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  try {
    const first = wall - offsetMs(wall, timeZone);
    const refined = wall - offsetMs(first, timeZone);
    // A local time inside a DST gap does not exist: the refined guess then maps back to a
    // different wall-clock time. Use the first guess, which lands after the gap.
    const wanted = local.slice(0, 16);
    return new Date(utcToZonedLocal(new Date(refined), timeZone) === wanted ? refined : first);
  } catch {
    return null; // unknown zone
  }
}

/** UTC instant → "YYYY-MM-DDTHH:mm" in the zone (for datetime-local inputs). */
export function utcToZonedLocal(value: string | Date, timeZone: string): string {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone.length > 0;
  } catch {
    return false;
  }
}
