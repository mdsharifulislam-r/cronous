import { describe, expect, it } from 'vitest';
import { matches } from './global-search';

describe('global search matching', () => {
  it('matches case-insensitively on any field and never on an empty query', () => {
    expect(matches('EMA', 'emails', null)).toBe(true);
    expect(matches('api-1', null, 'host', 'api-1.internal')).toBe(true);
    expect(matches('zzz', 'emails')).toBe(false);
    expect(matches('  ', 'anything')).toBe(false);
  });
});
