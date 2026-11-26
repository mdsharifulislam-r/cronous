import { Inject, Injectable } from '@nestjs/common';
import { hashToken } from '@chronos/shared';
import { APP_CONFIG } from '../../config/config.module';
import { ServerEnv } from '../../config/env.schema';
import { RedisService } from '../../infrastructure/redis/redis.service';

/**
 * Locks out an account identifier after too many failed logins within a window.
 * Counters live in Redis so the limit holds across server replicas. The email is
 * hashed so Redis never stores user identifiers in plain text.
 */
@Injectable()
export class LoginThrottleService {
  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: ServerEnv,
  ) {}

  private key(email: string): string {
    return this.redis.keyspace.key('ratelimit', 'login', hashToken(email).slice(0, 32));
  }

  /** Seconds until the lockout ends, or 0 if the identifier may attempt a login. */
  async lockedForSeconds(email: string): Promise<number> {
    const key = this.key(email);
    const [count, ttl] = await Promise.all([this.redis.client.get(key), this.redis.client.ttl(key)]);
    if (Number(count ?? 0) < this.config.CHRONOS_LOGIN_MAX_FAILURES) return 0;
    return ttl > 0 ? ttl : this.config.CHRONOS_LOGIN_LOCKOUT_SECONDS;
  }

  async recordFailure(email: string): Promise<void> {
    const key = this.key(email);
    // SET NX starts a fixed window at the first failure (instead of sliding forever);
    // unlike EXPIRE ... NX it also works on Redis 6.
    await this.redis.client
      .multi()
      .set(key, '0', 'EX', this.config.CHRONOS_LOGIN_LOCKOUT_SECONDS, 'NX')
      .incr(key)
      .exec();
  }

  async reset(email: string): Promise<void> {
    await this.redis.client.del(this.key(email));
  }
}
