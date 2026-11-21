import { ResilientThrottlerStorage, throttlerStorageFromEnv } from './resilient-throttler-storage';

jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({
  on: jest.fn(), connect: jest.fn().mockResolvedValue(undefined), eval: jest.fn(),
})), { virtual: false });

describe('ResilientThrottlerStorage', () => {
  // the library's in-memory store keeps a timer per hit — clear them so jest can exit
  const made: ResilientThrottlerStorage[] = [];
  afterEach(() => made.splice(0).forEach((s) => (s as any).memory.onApplicationShutdown()));
  const track = (s: ResilientThrottlerStorage) => { made.push(s); return s; };
  it('uses Redis counters when connected', async () => {
    const s = track(new ResilientThrottlerStorage('redis://x'));
    (s as any).ready = true;
    (s as any).redis.eval.mockResolvedValue([3, 41_500]);
    await expect(s.increment('otp-phone:9999999999', 60_000)).resolves.toEqual({ totalHits: 3, timeToExpire: 42 });
    expect((s as any).redis.eval).toHaveBeenCalledWith(expect.any(String), 1, 'throttle:otp-phone:9999999999', '60000');
  });

  it('falls back to in-memory counting when Redis is not ready — limiting never switches off', async () => {
    const s = track(new ResilientThrottlerStorage('redis://x'));
    (s as any).ready = false;
    expect((await s.increment('k', 60_000)).totalHits).toBe(1);
    expect((await s.increment('k', 60_000)).totalHits).toBe(2);
    expect((s as any).redis.eval).not.toHaveBeenCalled();
  });

  it('falls back to memory for a request whose Redis call fails', async () => {
    const s = track(new ResilientThrottlerStorage('redis://x'));
    (s as any).ready = true;
    (s as any).redis.eval.mockRejectedValue(new Error('timeout'));
    expect((await s.increment('k2', 60_000)).totalHits).toBe(1);
  });

  it('is only used when REDIS_URL is set and never in tests', () => {
    const saved = { url: process.env.REDIS_URL, env: process.env.NODE_ENV };
    process.env.REDIS_URL = 'redis://x';
    process.env.NODE_ENV = 'test';
    expect(throttlerStorageFromEnv()).toBeUndefined();
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = 'production';
    expect(throttlerStorageFromEnv()).toBeUndefined();
    process.env.REDIS_URL = saved.url as any; if (saved.url === undefined) delete process.env.REDIS_URL;
    process.env.NODE_ENV = saved.env;
  });
});
