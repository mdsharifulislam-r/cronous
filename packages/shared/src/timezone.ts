const cache = new Map<string, boolean>();

/** True when `timeZone` is an IANA zone name supported by the runtime's ICU data. */
export function isValidTimeZone(timeZone: string): boolean {
  const cached = cache.get(timeZone);
  if (cached !== undefined) return cached;
  let valid = false;
  if (timeZone.length > 0 && timeZone.length <= 64) {
    try {
      // Throws RangeError for unknown zones.
      new Intl.DateTimeFormat('en-US', { timeZone });
      valid = true;
    } catch {
      valid = false;
    }
  }
  cache.set(timeZone, valid);
  return valid;
}
