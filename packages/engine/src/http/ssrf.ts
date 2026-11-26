import { lookup as dnsLookup, LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * Server-side request forgery protection for webhook delivery.
 *
 * Webhook URLs are user-controlled and are fetched from inside the operator's network,
 * so the destination is checked on every connection, against the *resolved* address,
 * inside the socket's DNS lookup. Checking the hostname up front is not enough: DNS
 * rebinding can return a safe address to the check and an internal one to the connect.
 */
export interface DestinationPolicy {
  /** Allow RFC 1918 / ULA / CGNAT ranges (common for self-hosted apps on a private network). */
  allowPrivate: boolean;
  /** CIDRs always allowed, overriding every block (e.g. "127.0.0.1/32" for a same-host app). */
  allowedCidrs: string[];
}

export class BlockedDestinationError extends Error {
  constructor(readonly address: string, readonly reason: string) {
    super(`Destination ${address} is not allowed (${reason})`);
    this.name = 'BlockedDestinationError';
  }
}

function list(entries: [string, number, 'ipv4' | 'ipv6'][]): BlockList {
  const blockList = new BlockList();
  for (const [network, prefix, type] of entries) blockList.addSubnet(network, prefix, type);
  return blockList;
}

/** Never reachable by default: loopback, link-local (incl. cloud metadata), multicast, reserved. */
const ALWAYS_BLOCKED = list([
  ['0.0.0.0', 8, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
]);

const PRIVATE = list([
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
]);

function parseCidr(cidr: string): [string, number, 'ipv4' | 'ipv6'] {
  const [network, prefixText] = cidr.split('/');
  const family = isIP(network ?? '');
  if (!network || family === 0) throw new Error(`Invalid CIDR "${cidr}"`);
  const max = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) throw new Error(`Invalid CIDR prefix in "${cidr}"`);
  return [network, prefix, family === 4 ? 'ipv4' : 'ipv6'];
}

export class DestinationGuard {
  private readonly allowed: BlockList;

  constructor(private readonly policy: DestinationPolicy) {
    this.allowed = list(policy.allowedCidrs.map(parseCidr));
  }

  /** Returns the reason an address is blocked, or null if it may be contacted. */
  check(address: string): string | null {
    let ip = address;
    let family = isIP(ip);
    if (family === 0) return 'not an IP address';
    // Unwrap IPv4-mapped IPv6 (::ffff:10.0.0.1) so it cannot bypass the IPv4 rules.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped?.[1]) {
      ip = mapped[1];
      family = 4;
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (this.allowed.check(ip, type)) return null;
    if (ALWAYS_BLOCKED.check(ip, type)) return 'loopback, link-local or reserved address';
    if (!this.policy.allowPrivate && PRIVATE.check(ip, type)) return 'private network address';
    return null;
  }

  assertAllowed(address: string): void {
    const reason = this.check(address);
    if (reason) throw new BlockedDestinationError(address, reason);
  }

  /**
   * Drop-in replacement for dns.lookup used by the HTTP client's sockets. Every
   * resolved address must pass, so a hostname resolving to both a public and an internal
   * address is rejected.
   */
  readonly lookup = (
    hostname: string,
    options: { all?: boolean; family?: number } | number | undefined,
    callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    const opts = typeof options === 'number' ? { family: options } : (options ?? {});
    dnsLookup(hostname, { all: true, ...(opts.family ? { family: opts.family } : {}) }, (error, addresses) => {
      if (error) return callback(error, opts.all ? [] : '', 0);
      for (const entry of addresses) {
        const reason = this.check(entry.address);
        if (reason) return callback(new BlockedDestinationError(entry.address, reason) as NodeJS.ErrnoException, opts.all ? [] : '', 0);
      }
      if (opts.all) return callback(null, addresses);
      const first = addresses[0];
      if (!first) return callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
      callback(null, first.address, first.family);
    });
  };
}
