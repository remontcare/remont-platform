import { Logger } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';

// One atomic round trip: count the hit, start the window on the first one, report ms left.
const INCREMENT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) t = tonumber(ARGV[1]) end
return {n, t}`;

/**
 * Rate-limit counters in Redis, so OTP/login/API limits hold across instances and survive a
 * deploy (the in-memory default resets on every restart and is per instance). Whenever Redis is
 * unreachable or slow, each call falls back to the built-in in-memory store — limiting never
 * switches off, and a Redis outage never fails a request.
 */
export class ResilientThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('RateLimit');
  private readonly memory = new ThrottlerStorageService();
  private redis: any = null;
  private ready = false;

  constructor(url: string) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- already a dependency; loaded only when REDIS_URL is set
      const IORedis = require('ioredis');
      this.redis = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000, commandTimeout: 500 });
      this.redis.on('ready', () => {
        if (!this.ready) this.logger.log('Rate limits: shared Redis counters active');
        this.ready = true;
      });
      this.redis.on('error', () => {
        if (this.ready) this.logger.warn('Rate limits: Redis unavailable — using in-memory counters');
        this.ready = false;
      });
      this.redis.connect().catch(() => { this.ready = false; });
    } catch {
      this.redis = null;
    }
  }

  async increment(key: string, ttl: number): Promise<{ totalHits: number; timeToExpire: number }> {
    if (this.redis && this.ready) {
      try {
        const [hits, pttl] = await this.redis.eval(INCREMENT_SCRIPT, 1, `throttle:${key}`, String(ttl));
        return { totalHits: Number(hits), timeToExpire: Math.max(0, Math.ceil(Number(pttl) / 1000)) };
      } catch {
        // fall through to memory for this request
      }
    }
    return this.memory.increment(key, ttl);
  }
}

/** The storage for ThrottlerModule: Redis-backed when REDIS_URL is set (never in tests), else the default. */
export function throttlerStorageFromEnv(): ThrottlerStorage | undefined {
  const url = process.env.REDIS_URL;
  if (!url || process.env.NODE_ENV === 'test') return undefined;
  return new ResilientThrottlerStorage(url);
}
