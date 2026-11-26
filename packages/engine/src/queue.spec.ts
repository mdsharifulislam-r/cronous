import { describe, expect, it } from 'vitest';
import { PayloadSchemaValidator } from './payload-schema';
import { bullPriority } from './queues';

describe('bullPriority', () => {
  it('maps 0-100 (higher first) onto BullMQ 101-1 (lower first) and clamps', () => {
    expect(bullPriority(100)).toBe(1);
    expect(bullPriority(50)).toBe(51);
    expect(bullPriority(0)).toBe(101);
    expect(bullPriority(150)).toBe(1);
    expect(bullPriority(-5)).toBe(101);
    expect(bullPriority(90)).toBeLessThan(bullPriority(10));
  });
});

describe('PayloadSchemaValidator', () => {
  const validator = new PayloadSchemaValidator();
  const schema = { type: 'object', required: ['to'], additionalProperties: false, properties: { to: { type: 'string', format: 'email' } } };

  it('accepts valid payloads and reports JSON-pointer issues for invalid ones', () => {
    expect(validator.validate(schema, { to: 'a@example.com' })).toEqual([]);
    expect(validator.validate(schema, { to: 'nope' })).toEqual([{ path: '/to', message: expect.stringContaining('email') }]);
    expect(validator.validate(schema, {})).toEqual([{ path: '', message: expect.stringContaining('(to)') }]);
    expect(validator.validate(schema, { to: 'a@example.com', extra: 1 })).toEqual([{ path: '', message: expect.stringContaining('(extra)') }]);
    expect(validator.validate(schema, undefined)).toHaveLength(1); // undefined is validated as null
  });

  it('rejects schemas that do not compile', () => {
    expect(validator.checkSchema({ type: 'no-such-type' })).toMatch(/invalid payloadSchema/);
    expect(validator.checkSchema([])).toMatch(/JSON object/);
    expect(validator.checkSchema(schema)).toBeNull();
  });

  it('compiles schemas with the same $id repeatedly', () => {
    const withId = { $id: 'https://example.com/s', type: 'number' };
    expect(validator.validate(withId, 1)).toEqual([]);
    expect(validator.validate({ ...withId, minimum: 5 }, 1)).toHaveLength(1);
  });
});
