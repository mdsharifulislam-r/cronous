const NAMESPACE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidNamespace(namespace: string): boolean {
  return NAMESPACE_PATTERN.test(namespace);
}

/**
 * Builds Redis keys under a single configurable namespace so Chronos can share a
 * Redis instance with existing applications without key or queue collisions.
 */
export class Keyspace {
  constructor(public readonly namespace: string) {
    if (!isValidNamespace(namespace)) {
      throw new Error(`Invalid Redis namespace "${namespace}": must match ${NAMESPACE_PATTERN}`);
    }
  }

  key(...parts: (string | number)[]): string {
    if (parts.length === 0) throw new Error('Keyspace.key requires at least one part');
    const values = parts.map(String);
    if (values.some((value) => value.length === 0)) throw new Error('Redis key parts must not be empty');
    return [this.namespace, ...values].join(':');
  }

  /** Prefix passed to BullMQ; BullMQ appends `:<queue>:<suffix>` itself. */
  get bullPrefix(): string {
    return `${this.namespace}:bull`;
  }

  /** Glob pattern matching every key owned by this namespace (for operational tooling). */
  get pattern(): string {
    return `${this.namespace}:*`;
  }
}
