import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EnvValidationError,
  Keyspace,
  envBoolean,
  generateToken,
  hashPassword,
  hashToken,
  isValidTimeZone,
  parseEnv,
  safeEqualHex,
  slugSchema,
  tokenKindOf,
  verifyPassword,
} from './index';

describe('parseEnv', () => {
  const schema = z.object({
    PORT: z.coerce.number().int().default(8080),
    FLAG: envBoolean(false),
    SECRET: z.string().min(8),
  });

  it('applies defaults and treats empty strings as unset', () => {
    const env = parseEnv(schema, { PORT: '', FLAG: 'yes', SECRET: 'abcdefgh' });
    expect(env).toEqual({ PORT: 8080, FLAG: true, SECRET: 'abcdefgh' });
  });

  it('reports every invalid variable without echoing values', () => {
    try {
      parseEnv(schema, { PORT: 'x', FLAG: 'ture', SECRET: 'short-s' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as Error).message;
      expect(message).toContain('PORT');
      expect(message).toContain('FLAG');
      expect(message).toContain('SECRET');
      expect(message).not.toContain('short-s');
    }
  });
});

describe('tokens', () => {
  it('generates prefixed, high-entropy tokens whose hash matches', () => {
    const a = generateToken('project');
    const b = generateToken('project');
    expect(a.token).toMatch(/^chr_p_[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.displayPrefix).toBe(a.token.slice(0, 12));
    expect(tokenKindOf(a.token)).toBe('project');
    expect(tokenKindOf(generateToken('agent').token)).toBe('agent');
    expect(tokenKindOf('ghp_xxx')).toBeNull();
  });

  it('compares digests in constant time and rejects malformed input', () => {
    const h = hashToken('x');
    expect(safeEqualHex(h, hashToken('x'))).toBe(true);
    expect(safeEqualHex(h, hashToken('y'))).toBe(false);
    expect(safeEqualHex(h, '')).toBe(false);
  });
});

describe('passwords', () => {
  it('hashes with a random salt and verifies', async () => {
    const one = await hashPassword('correct horse battery staple');
    const two = await hashPassword('correct horse battery staple');
    expect(one).not.toBe(two);
    expect(one.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', one)).toBe(true);
    expect(await verifyPassword('wrong password!!', one)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    // Refuses attacker-supplied parameters that would exhaust memory.
    expect(await verifyPassword('anything', 'scrypt$1073741824$8$1$AAAA$AAAA')).toBe(false);
  });
});

describe('Keyspace', () => {
  it('namespaces keys and the BullMQ prefix', () => {
    const ks = new Keyspace('chronos');
    expect(ks.key('agent', 'abc', 'heartbeat')).toBe('chronos:agent:abc:heartbeat');
    expect(ks.bullPrefix).toBe('chronos:bull');
    expect(ks.pattern).toBe('chronos:*');
  });

  it('rejects unsafe namespaces and empty parts', () => {
    expect(() => new Keyspace('Chronos')).toThrow();
    expect(() => new Keyspace('a:b')).toThrow();
    expect(() => new Keyspace('')).toThrow();
    expect(() => new Keyspace('chronos').key('a', '')).toThrow();
  });
});

describe('validation helpers', () => {
  it('validates IANA time zones', () => {
    expect(isValidTimeZone('Asia/Dhaka')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('validates slugs', () => {
    expect(slugSchema.safeParse('storefront').success).toBe(true);
    expect(slugSchema.safeParse('my-project-2').success).toBe(true);
    expect(slugSchema.safeParse('My Project').success).toBe(false);
    expect(slugSchema.safeParse('a--b').success).toBe(false);
  });
});
