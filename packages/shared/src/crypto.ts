import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/**
 * Credential token kinds. The prefix is part of the token so leaked tokens are
 * recognisable by secret scanners, and so the server can reject a token presented in
 * the wrong context before touching the database.
 */
export const TOKEN_PREFIXES = {
  user: 'chr_u_',
  project: 'chr_p_',
  agent: 'chr_a_',
  bootstrap: 'chr_b_',
} as const;

export type TokenKind = keyof typeof TOKEN_PREFIXES;

const TOKEN_BYTES = 32; // 256 bits of entropy
const DISPLAY_PREFIX_LENGTH = 12;

export interface GeneratedToken {
  /** Full plaintext token. Returned to the caller exactly once and never stored. */
  token: string;
  /** SHA-256 hex digest stored in the database for lookup. */
  hash: string;
  /** Non-secret prefix shown in listings to help humans identify a credential. */
  displayPrefix: string;
}

export function generateToken(kind: TokenKind): GeneratedToken {
  const token = `${TOKEN_PREFIXES[kind]}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return { token, hash: hashToken(token), displayPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH) };
}

/**
 * Tokens carry 256 bits of entropy, so a fast unsalted digest is sufficient: offline
 * brute force against a leaked hash is infeasible, and a deterministic digest allows
 * an indexed lookup without a separate public identifier.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenKindOf(token: string): TokenKind | null {
  for (const [kind, prefix] of Object.entries(TOKEN_PREFIXES) as [TokenKind, string][]) {
    if (token.startsWith(prefix)) return kind;
  }
  return null;
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Password hashing: scrypt is memory-hard and built into Node, so no native addon
// has to be compiled in Docker images or on developer machines.
// ---------------------------------------------------------------------------

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, { N: n, r, p, maxmem: 256 * n * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Returns a self-describing hash string: `scrypt$N$r$p$salt$hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

const MAX_SCRYPT_N = 2 ** 20;

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [string, string, string, string, string, string];
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![n, r, p].every((value) => Number.isInteger(value) && value > 0) || n > MAX_SCRYPT_N || r > 32 || p > 16) {
    return false;
  }
  const expected = Buffer.from(hashRaw, 'base64');
  if (expected.length === 0) return false;
  const actual = await scrypt(password, Buffer.from(saltRaw, 'base64'), n, r, p, expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * A valid hash of a random password, used to equalise login timing when the user
 * does not exist (prevents account enumeration through response latency).
 */
let dummyHash: Promise<string> | undefined;
export function getDummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}
