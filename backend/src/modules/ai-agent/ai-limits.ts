import { HttpException, HttpStatus, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.module';
import { openAiComplete, OpenAiMessage } from './openai-client';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Remi cost protection & anti-abuse.
//
// Independent layers, each enforced server-side on every request:
//   1. request rate per identity (logged-in user, else client IP) per minute / hour / day,
//      plus a per-session rate, and a cap on concurrent in-flight requests;
//   2. progressive cooldown for an identity that keeps hitting the limits;
//   3. token quotas — per identity per day, and a global daily token / request budget, with
//      an optional estimated-cost budget when model pricing is configured;
//   4. warning alerts at configurable % of the global budget, hard stop at 100%.
// Limits live in SiteSetting (group 'ai', admin-editable via PATCH /admin/settings/:key) with the
// code defaults below. Counters use Redis (REDIS_URL) with an atomic INCRBY+PEXPIRE script so
// parallel requests can't slip past a limit.
//
// Paid calls RESERVE their worst-case tokens (estimated input + max output) atomically before
// the provider is called and are reconciled with the provider's real usage afterwards, so
// parallel requests can never jointly spend more than the remaining budget.
//
// Failure policy: when Redis is configured but unreachable — or in production with no Redis
// at all — shared enforcement can't be guaranteed, so PAID calls are refused (chat answers
// with the rule-based assistant). Request-rate limits keep working from process memory, so
// nothing becomes unlimited.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Models Remi may call. Changing the model to one outside this list needs a code change (approval). */
export const AI_APPROVED_MODELS: readonly string[] = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano'];
export const isApprovedModel = (model: string | null | undefined) => !!model && AI_APPROVED_MODELS.includes(model);

/** Conservative token estimate: ~3.5 ASCII chars per token, non-ASCII (e.g. Devanagari) 1 char per token. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++; else other++;
  return Math.ceil(ascii / 3.5) + other;
}

export const AI_LIMIT_DEFAULTS = {
  'ai.user.perMinute': 10,
  'ai.user.perHour': 60,
  'ai.user.perDay': 200,
  // Anonymous traffic is keyed by IP. Mobile carriers put many people behind one IP, so these
  // are per-IP ceilings, backed by the per-session limit and the global budget.
  'ai.anon.perMinute': 20,
  'ai.anon.perHour': 150,
  'ai.anon.perDay': 500,
  'ai.session.perMinute': 8,
  'ai.concurrency.user': 2,
  'ai.concurrency.anon': 3,
  'ai.message.maxChars': 1000,
  'ai.field.maxChars': 120,
  'ai.history.maxMessages': 12,
  'ai.session.maxMessages': 80,
  'ai.output.maxTokens': 300,
  'ai.tools.maxRounds': 4,
  'ai.request.timeoutMs': 20000,
  // Whole interaction (all tool rounds together), not just one provider call.
  'ai.interaction.maxMs': 30000,
  'ai.tools.maxCallsPerRound': 4,
  // Estimated input tokens of a single provider call (system prompt + history + tool results).
  'ai.request.maxInputTokens': 12000,
  'ai.user.dailyTokens': 60000,
  'ai.anon.dailyTokens': 100000,
  // Admin content generation ('admin-tools' / 'admin-content' keys), incl. the bulk
  // "generate for all empty services" button. Still inside the global budget.
  'ai.admin.dailyTokens': 300000,
  'ai.session.dailyTokens': 40000,
  // All anonymous visitors TOGETHER — a botnet with many IPs can't use more than this, and
  // logged-in customers keep the rest of the global budget.
  'ai.anonPool.dailyTokens': 1000000,
  'ai.anonPool.dailyRequests': 4000,
  'ai.global.dailyTokens': 3000000,
  'ai.global.dailyRequests': 10000,
  // 1 = allow paid calls on in-process counters in production when no Redis is configured
  // (only safe with exactly one backend instance). Default 0 = fail closed.
  'ai.store.allowMemoryInProduction': 0,
  // Estimated INR cost budget per day; 0 = off. Needs ai.pricing.<model>.* to be set.
  'ai.global.dailyCostBudget': 0,
  // Seller AI enrichment (products/ai/execute) — counted per seller and globally per day, even
  // when the feature is priced at ₹0. Image generation is the expensive one.
  'ai.enrichment.perSellerDaily': 20,
  'ai.images.perSellerDaily': 4,
  'ai.images.globalDaily': 40,
  'ai.cooldown.rejections': 10,
  'ai.cooldown.minutes': 15,
} as const;
export type AiLimitKey = keyof typeof AI_LIMIT_DEFAULTS;
export const AI_ALERT_THRESHOLDS_KEY = 'ai.alerts.thresholds'; // e.g. "50,80,100"

/** 429 with a generic message — never reveals which limit or its configured value. */
export class AiRateLimitException extends HttpException {
  constructor(retryAfterSeconds = 60) {
    super({ statusCode: 429, message: 'Too many requests. Please wait a moment and try again.', retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export interface AiIdentity {
  userId?: string | null;
  ip?: string | null;
  sessionId?: string | null;
}

interface CounterStore {
  incr(key: string, by: number, ttlMs: number): Promise<number>;
  get(key: string): Promise<number>;
}

class MemoryStore implements CounterStore {
  private m = new Map<string, { v: number; exp: number }>();
  async incr(key: string, by: number, ttlMs: number) {
    const now = Date.now();
    const cur = this.m.get(key);
    if (!cur || cur.exp <= now) { this.m.set(key, { v: by, exp: now + ttlMs }); return by; }
    cur.v += by;
    return cur.v;
  }
  async get(key: string) {
    const cur = this.m.get(key);
    return cur && cur.exp > Date.now() ? cur.v : 0;
  }
  sweep() { const now = Date.now(); for (const [k, v] of this.m) if (v.exp <= now) this.m.delete(k); }
}

const INCR_SCRIPT = "local v=redis.call('INCRBYFLOAT',KEYS[1],ARGV[1]) if tonumber(v)==tonumber(ARGV[1]) then redis.call('PEXPIRE',KEYS[1],ARGV[2]) end return v";

const DAY_MS = 86_400_000;
const istDay = (d = new Date()) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const hashId = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * The network an anonymous caller is counted under: the IPv4 address, or the /64 prefix of an
 * IPv6 address — one subscriber/host usually holds a whole /64, so per-address keys would let
 * one attacker rotate through billions of "identities".
 */
export function clientNetwork(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.toLowerCase().split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

// ─── session references ─────────────────────────────────────────────────────────────────────
// AiSession ids are Prisma cuids (timestamp + counter based — guessable). The client therefore
// gets `<id>.<hmac>` and an anonymous session can only be continued with a valid signature.
// Logged-in owners may also use the raw id (ownership is checked against the JWT anyway).
let sessionSecret: string | null = null;
const secretFor = () => (sessionSecret ??= process.env.AI_SESSION_SECRET || process.env.JWT_SECRET || randomBytes(32).toString('hex'));
const sessionSig = (id: string) => createHmac('sha256', secretFor()).update(`ai-session:${id}`).digest('base64url').slice(0, 22);

export function signSessionId(id: string): string {
  return `${id}.${sessionSig(id)}`;
}
/** Parses a client session reference. `signed` is true only for an untampered `<id>.<hmac>`. */
export function parseSessionRef(ref: unknown): { id: string; signed: boolean } | null {
  if (typeof ref !== 'string' || !ref || ref.length > 64) return null;
  const dot = ref.lastIndexOf('.');
  if (dot < 0) return /^[A-Za-z0-9_-]{1,40}$/.test(ref) ? { id: ref, signed: false } : null;
  const id = ref.slice(0, dot);
  const sig = Buffer.from(ref.slice(dot + 1));
  const want = Buffer.from(sessionSig(id));
  return sig.length === want.length && timingSafeEqual(sig, want) ? { id, signed: true } : null;
}

export interface AiReservation {
  ok: boolean;
  reason?: string;
  /** Reconciles the reservation with the provider's real usage (or the input estimate if none). Idempotent. */
  settle: (usage?: { prompt_tokens?: number; completion_tokens?: number } | null) => Promise<void>;
}

@Injectable()
export class AiLimitsService implements OnModuleDestroy {
  private readonly logger = new Logger(AiLimitsService.name);
  private memory = new MemoryStore();
  private redis: any = null;
  private redisBroken = false;
  private redisBrokenAt = 0;
  // Counts commands that fell back to memory while Redis is configured. reserve() and
  // consumeDailyQuota() compare it before/after, so Redis dying MID-reservation (later counters
  // landing in fresh, empty memory) refuses the reservation instead of approving it.
  private storeFallbacks = 0;
  private redisReadyLogged = false;
  // Set from the environment; fields (not constants) so tests can exercise the outage policy.
  private redisConfigured = false;
  private productionMode = process.env.NODE_ENV === 'production';
  private cfg: Record<string, number> = { ...AI_LIMIT_DEFAULTS };
  private pricing: Record<string, { input: number; output: number }> = {};
  private thresholds = [50, 80, 100];
  private cfgLoadedAt = 0;
  private cfgLoading: Promise<void> | null = null;
  private cfgEverLoaded = false;
  private alerted = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private prisma: PrismaService) {
    const url = process.env.REDIS_URL;
    if (url && process.env.NODE_ENV !== 'test') {
      this.redisConfigured = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional dependency, loaded only when REDIS_URL is set
        const IORedis = require('ioredis');
        this.redis = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000, commandTimeout: 1000 });
        this.redis.on('error', (e: any) => this.markRedisBroken(e));
        this.redis.on('ready', () => {
          // One non-secret line so deploy checks can confirm shared counters are live.
          if (this.redisBroken || !this.redisReadyLogged) this.logger.log('AI limits: shared Redis counters ready — paid AI calls enabled');
          this.redisReadyLogged = true;
          this.redisBroken = false;
        });
        this.redis.connect().catch((e: any) => this.markRedisBroken(e));
      } catch (e) { this.markRedisBroken(e); }
    } else if (this.productionMode && process.env.NODE_ENV !== 'test') {
      this.logger.error('AI limits: no REDIS_URL in production — paid AI calls stay off unless ai.store.allowMemoryInProduction=1');
    }
    this.sweepTimer = setInterval(() => this.memory.sweep(), 5 * 60_000);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.redis?.disconnect?.();
  }

  // ─── config ────────────────────────────────────────────────────────────────────────────
  async config(): Promise<Record<string, number>> {
    if (Date.now() - this.cfgLoadedAt < 60_000) return this.cfg;
    // Concurrent callers share one load — and before the FIRST load completes they wait for it,
    // so a burst at startup can't run on the built-in defaults instead of admin-lowered limits.
    if (!this.cfgLoading) this.cfgLoading = this.loadConfig().finally(() => { this.cfgLoading = null; });
    if (!this.cfgEverLoaded) await this.cfgLoading;
    return this.cfg;
  }

  private async loadConfig(): Promise<void> {
    try {
      const rows: Array<{ key: string; value: string }> = await this.prisma.siteSetting.findMany({ where: { group: 'ai' }, select: { key: true, value: true } });
      const next: Record<string, number> = { ...AI_LIMIT_DEFAULTS };
      const pricing: Record<string, { input: number; output: number }> = {};
      for (const r of rows) {
        const n = Number(r.value);
        if (r.key in AI_LIMIT_DEFAULTS && Number.isFinite(n) && n >= 0) next[r.key] = n;
        const pm = /^ai\.pricing\.(.+)\.(input|output)Per1M$/.exec(r.key);
        if (pm && Number.isFinite(n) && n >= 0) (pricing[pm[1]] ??= { input: 0, output: 0 })[pm[2] as 'input' | 'output'] = n;
        if (r.key === AI_ALERT_THRESHOLDS_KEY) {
          const t = r.value.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0 && x <= 100).sort((a, b) => a - b);
          if (t.length) this.thresholds = t;
        }
      }
      this.cfg = next;
      this.pricing = pricing;
      this.cfgLoadedAt = Date.now();
    } catch (e: any) {
      this.logger.warn(`AI limits: could not load settings, using the last known values (${e?.message})`);
      this.cfgLoadedAt = Date.now() - 50_000; // retry in ~10s
    }
    this.cfgEverLoaded = true;
  }

  private markRedisBroken(e?: any) {
    if (!this.redisBroken) this.logger.error(`AI limits: Redis unavailable (${e?.code || 'error'}) — paid AI calls paused, rate limits continue in memory`);
    this.redisBroken = true;
    this.redisBrokenAt = Date.now();
  }
  /** Redis usable right now? A failed command is retried at most every 30s once the client reports ready. */
  private useRedis(): boolean {
    if (!this.redis) return false;
    if (this.redisBroken && this.redis.status === 'ready' && Date.now() - this.redisBrokenAt > 30_000) this.redisBroken = false;
    return !this.redisBroken;
  }
  /**
   * Whether counters are shared and reliable enough to allow PAID calls. Configured Redis must be
   * up; production without Redis needs the explicit single-instance opt-in.
   */
  async sharedStoreOk(): Promise<boolean> {
    if (this.redisConfigured) return this.useRedis() && (!this.redis?.status || this.redis.status === 'ready');
    if (!this.productionMode) return true;
    return (await this.config())['ai.store.allowMemoryInProduction'] === 1;
  }

  private async incr(key: string, by: number, ttlMs: number): Promise<number> {
    if (this.useRedis()) {
      try {
        return Number(await this.redis.eval(INCR_SCRIPT, 1, `ai:${key}`, String(by), String(ttlMs)));
      } catch (e) { this.markRedisBroken(e); }
    }
    if (this.redisConfigured) this.storeFallbacks++;
    return this.memory.incr(key, by, ttlMs);
  }
  private async get(key: string): Promise<number> {
    if (this.useRedis()) {
      try { return Number((await this.redis.get(`ai:${key}`)) || 0); } catch (e) { this.markRedisBroken(e); }
    }
    return this.memory.get(key);
  }

  /** Stable, non-reversible key for an identity — raw IPs/user ids never go into logs. */
  identityKey(id: AiIdentity): string {
    return id.userId ? `u:${hashId(id.userId)}` : `ip:${hashId(clientNetwork(id.ip))}`;
  }

  /** Per-identity daily token cap: anonymous IP, admin feature keys ('admin-*'), or a user. */
  private identityTokenLimit(c: Record<string, number>, identityKey: string, anon: boolean) {
    if (anon) return c['ai.anon.dailyTokens'];
    return identityKey.startsWith('admin-') ? c['ai.admin.dailyTokens'] : c['ai.user.dailyTokens'];
  }

  // ─── 1+2. rate, cooldown, concurrency ─────────────────────────────────────────────────
  /**
   * Admits one request or throws AiRateLimitException. Returns release() to call when the
   * request finishes (frees its concurrency slot). Counts are taken BEFORE any work, so
   * parallel requests each consume a slot and cannot bypass the limit together.
   */
  async admit(id: AiIdentity): Promise<{ release: () => Promise<void>; identityKey: string }> {
    const c = await this.config();
    const key = this.identityKey(id);
    const anon = !id.userId;

    const cooldown = await this.get(`cooldown:${key}`);
    if (cooldown > 0) { await this.reject(key, 'cooldown'); throw new AiRateLimitException(Math.ceil(c['ai.cooldown.minutes'] * 60)); }

    const prefix = anon ? 'ai.anon' : 'ai.user';
    const windows: Array<[string, number, number]> = [
      ['m', 60_000, c[`${prefix}.perMinute`]],
      ['h', 3_600_000, c[`${prefix}.perHour`]],
      ['d', DAY_MS, c[`${prefix}.perDay`]],
    ];
    for (const [w, ms, limit] of windows) {
      const n = await this.incr(`rate:${w}:${key}`, 1, ms);
      if (n > limit) { await this.reject(key, `rate-${w}`); throw new AiRateLimitException(w === 'm' ? 60 : w === 'h' ? 600 : 3600); }
    }
    if (id.sessionId) {
      const n = await this.incr(`rate:s:${hashId(id.sessionId)}`, 1, 60_000);
      if (n > c['ai.session.perMinute']) { await this.reject(key, 'rate-session'); throw new AiRateLimitException(60); }
    }

    const maxConc = anon ? c['ai.concurrency.anon'] : c['ai.concurrency.user'];
    const inFlight = await this.incr(`conc:${key}`, 1, 120_000); // TTL = safety net if a release is lost
    let released = false;
    const release = async () => { if (!released) { released = true; await this.incr(`conc:${key}`, -1, 120_000); } };
    if (inFlight > maxConc) { await release(); await this.reject(key, 'concurrency'); throw new AiRateLimitException(5); }
    return { release, identityKey: key };
  }

  /** Counts a rejection; enough of them in 10 min puts the identity on a cooldown that doubles (max 2h). */
  async reject(identityKey: string, reason: string) {
    const c = await this.config();
    await this.incr(`rejected:${istDay()}`, 1, 2 * DAY_MS);
    const n = await this.incr(`rejections:${identityKey}`, 1, 10 * 60_000);
    if (n === c['ai.cooldown.rejections']) {
      const strikes = await this.incr(`strikes:${identityKey}`, 1, DAY_MS);
      const minutes = Math.min(120, c['ai.cooldown.minutes'] * 2 ** (strikes - 1));
      await this.incr(`cooldown:${identityKey}`, 1, minutes * 60_000);
      this.logger.warn(`AI abuse: identity ${identityKey} hit limits ${n}x in 10 min (last: ${reason}) — cooldown ${minutes} min`);
    }
  }

  // ─── 3. token / budget quotas ──────────────────────────────────────────────────────────
  /** Whether a PAID model call may be made now for this identity. Never throws. */
  // Quick pre-check (skip the paid path early). The binding check is reserve() below.
  async budgetAllows(identityKey: string, anon: boolean): Promise<{ allowed: boolean; reason?: string }> {
    const c = await this.config();
    if (!(await this.sharedStoreOk())) return { allowed: false, reason: 'store-unavailable' };
    const day = istDay();
    const [gTok, gReq, gCost, idTok, poolTok, poolReq] = await Promise.all([
      this.get(`tokens:${day}`), this.get(`requests:${day}`), this.get(`cost:${day}`), this.get(`tokens:${day}:${identityKey}`),
      anon ? this.get(`anon_tokens:${day}`) : Promise.resolve(0), anon ? this.get(`anon_requests:${day}`) : Promise.resolve(0),
    ]);
    if (gTok >= c['ai.global.dailyTokens']) return { allowed: false, reason: 'global-tokens' };
    if (gReq >= c['ai.global.dailyRequests']) return { allowed: false, reason: 'global-requests' };
    if (c['ai.global.dailyCostBudget'] > 0 && gCost >= c['ai.global.dailyCostBudget']) return { allowed: false, reason: 'global-cost' };
    if (idTok >= this.identityTokenLimit(c, identityKey, anon)) return { allowed: false, reason: 'identity-tokens' };
    if (anon && poolTok >= c['ai.anonPool.dailyTokens']) return { allowed: false, reason: 'anon-pool-tokens' };
    if (anon && poolReq >= c['ai.anonPool.dailyRequests']) return { allowed: false, reason: 'anon-pool-requests' };
    return { allowed: true };
  }

  /**
   * Atomically reserves one paid provider call's worst case (estimated input + max output tokens,
   * one request, and its estimated cost) against every applicable budget BEFORE the call. Each
   * counter is incremented first and checked after, so concurrent reservations can't both fit
   * into the same remaining budget; a refused reservation rolls back what it took. The caller
   * must call settle() once the call ends (success, error or timeout).
   */
  async reserve(r: {
    identityKey: string; anon: boolean; sessionId?: string | null; model: string;
    estInputTokens: number; maxOutputTokens: number;
  }): Promise<AiReservation> {
    const denied = (reason: string): AiReservation => {
      this.logger.warn(`AI paid call refused (${reason}) for ${r.identityKey}`);
      return { ok: false, reason, settle: async () => undefined };
    };
    const c = await this.config();
    if (!isApprovedModel(r.model)) return denied('model-not-approved');
    if (!(await this.sharedStoreOk())) return denied('store-unavailable');
    if (r.estInputTokens > c['ai.request.maxInputTokens']) return denied('request-too-large');

    const day = istDay();
    const est = Math.ceil(r.estInputTokens) + Math.ceil(r.maxOutputTokens);
    const price = this.pricing[r.model];
    const estCost = price ? (r.estInputTokens * price.input + r.maxOutputTokens * price.output) / 1_000_000 : 0;
    const tokenKeys = [`tokens:${day}`, `tokens:${day}:${r.identityKey}`];
    if (r.anon) tokenKeys.push(`anon_tokens:${day}`);
    if (r.sessionId) tokenKeys.push(`tokens:${day}:s:${hashId(r.sessionId)}`);

    const plan: Array<[key: string, by: number, limit: number, reason: string]> = [
      [`requests:${day}`, 1, c['ai.global.dailyRequests'], 'global-requests'],
      [`tokens:${day}`, est, c['ai.global.dailyTokens'], 'global-tokens'],
      [`tokens:${day}:${r.identityKey}`, est, this.identityTokenLimit(c, r.identityKey, r.anon), 'identity-tokens'],
    ];
    if (r.anon) {
      plan.push([`anon_requests:${day}`, 1, c['ai.anonPool.dailyRequests'], 'anon-pool-requests']);
      plan.push([`anon_tokens:${day}`, est, c['ai.anonPool.dailyTokens'], 'anon-pool-tokens']);
    }
    if (r.sessionId) plan.push([`tokens:${day}:s:${hashId(r.sessionId)}`, est, c['ai.session.dailyTokens'], 'session-tokens']);
    if (price && c['ai.global.dailyCostBudget'] > 0) plan.push([`cost:${day}`, estCost, c['ai.global.dailyCostBudget'], 'global-cost']);

    const ttl = 3 * DAY_MS;
    const taken: Array<[string, number]> = [];
    const fallbacksBefore = this.storeFallbacks;
    for (const [key, by, limit, reason] of plan) {
      const n = await this.incr(key, by, ttl);
      taken.push([key, by]);
      if (n > limit) {
        for (const [k, b] of taken) await this.incr(k, -b, ttl);
        await this.checkThresholds(day);
        return denied(reason);
      }
    }
    if (this.storeFallbacks !== fallbacksBefore) {
      for (const [k, b] of taken) await this.incr(k, -b, ttl); // best effort
      return denied('store-unavailable');
    }
    if (price && !(c['ai.global.dailyCostBudget'] > 0)) { await this.incr(`cost:${day}`, estCost, ttl); }

    let settled = false;
    const settle = async (usage?: { prompt_tokens?: number; completion_tokens?: number } | null) => {
      if (settled) return;
      settled = true;
      const exact = !!usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens);
      // No provider numbers (error/timeout): keep the input estimate charged, output assumed 0.
      const input = exact ? Number(usage!.prompt_tokens) : Math.ceil(r.estInputTokens);
      const output = exact ? Number(usage!.completion_tokens) : 0;
      const delta = input + output - est;
      await Promise.all([
        ...tokenKeys.map((k) => (delta ? this.incr(k, delta, ttl) : Promise.resolve(0))),
        this.incr(`tokens_in:${day}`, input, ttl),
        this.incr(`tokens_out:${day}`, output, ttl),
        exact ? Promise.resolve(0) : this.incr(`estimated_calls:${day}`, 1, ttl),
        price ? this.incr(`cost:${day}`, (input * price.input + output * price.output) / 1_000_000 - estCost, ttl) : Promise.resolve(0),
      ]);
      await this.checkThresholds(day);
    };
    return { ok: true, settle };
  }

  /** Records one provider call using the provider's own usage numbers when it returned them. */
  async recordUsage(identityKey: string, model: string, usage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined, estimatedInputChars = 0) {
    const day = istDay();
    const exact = !!usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens);
    // Without provider numbers, ~4 chars/token is used and the figure is marked as an estimate.
    const input = exact ? Number(usage!.prompt_tokens) : Math.ceil(estimatedInputChars / 4);
    const output = exact ? Number(usage!.completion_tokens) : 0;
    const ttl = 3 * DAY_MS;
    await Promise.all([
      this.incr(`tokens:${day}`, input + output, ttl),
      this.incr(`tokens_in:${day}`, input, ttl),
      this.incr(`tokens_out:${day}`, output, ttl),
      this.incr(`requests:${day}`, 1, ttl),
      this.incr(`tokens:${day}:${identityKey}`, input + output, ttl),
      exact ? Promise.resolve(0) : this.incr(`estimated_calls:${day}`, 1, ttl),
    ]);
    await this.config();
    const price = this.pricing[model];
    if (price) await this.incr(`cost:${day}`, (input * price.input + output * price.output) / 1_000_000, ttl);
    await this.checkThresholds(day);
  }

  /**
   * Daily count quotas for paid features that aren't billed in tokens (e.g. image generation).
   * All-or-nothing and race-safe like reserve(): increments first, rolls back on any refusal.
   * `quotas` are [name, limitSettingKey] pairs; the identity is hashed into the counter key.
   */
  async consumeDailyQuota(identityKey: string, quotas: Array<[name: string, limitKey: AiLimitKey, scope: 'identity' | 'global']>): Promise<{ ok: boolean; reason?: string }> {
    const c = await this.config();
    if (!(await this.sharedStoreOk())) { this.logger.warn(`AI paid feature refused (store-unavailable) for ${identityKey}`); return { ok: false, reason: 'store-unavailable' }; }
    const day = istDay();
    const taken: string[] = [];
    const fallbacksBefore = this.storeFallbacks;
    for (const [name, limitKey, scope] of quotas) {
      const key = scope === 'global' ? `quota:${day}:${name}` : `quota:${day}:${name}:${identityKey}`;
      const n = await this.incr(key, 1, 2 * DAY_MS);
      taken.push(key);
      if (n > c[limitKey]) {
        for (const k of taken) await this.incr(k, -1, 2 * DAY_MS);
        this.logger.warn(`AI paid feature refused (${name} ${scope} daily quota) for ${identityKey}`);
        return { ok: false, reason: `${name}-${scope}` };
      }
    }
    if (this.storeFallbacks !== fallbacksBefore) {
      for (const k of taken) await this.incr(k, -1, 2 * DAY_MS);
      return { ok: false, reason: 'store-unavailable' };
    }
    return { ok: true };
  }

  private async checkThresholds(day: string) {
    const c = this.cfg;
    const pct = Math.max(
      (100 * (await this.get(`tokens:${day}`))) / c['ai.global.dailyTokens'],
      (100 * (await this.get(`requests:${day}`))) / c['ai.global.dailyRequests'],
      c['ai.global.dailyCostBudget'] > 0 ? (100 * (await this.get(`cost:${day}`))) / c['ai.global.dailyCostBudget'] : 0,
    );
    for (const t of this.thresholds) {
      const tag = `${day}:${t}`;
      if (pct >= t && !this.alerted.has(tag)) {
        this.alerted.add(tag);
        const msg = `AI usage reached ${t}% of today's budget (${pct.toFixed(1)}%).${t >= 100 ? ' Paid AI calls are stopped until tomorrow (IST); chat falls back to the rule-based assistant.' : ''}`;
        if (t >= 100) this.logger.error(msg); else this.logger.warn(msg);
      }
    }
  }

  /** Admin view: today's usage against the limits. Cost is an estimate from configured pricing. */
  async usageSnapshot() {
    const c = await this.config();
    const day = istDay();
    const [tokens, tokensIn, tokensOut, requests, cost, rejected, estimatedCalls, anonTokens, anonRequests] = await Promise.all([
      this.get(`tokens:${day}`), this.get(`tokens_in:${day}`), this.get(`tokens_out:${day}`), this.get(`requests:${day}`),
      this.get(`cost:${day}`), this.get(`rejected:${day}`), this.get(`estimated_calls:${day}`),
      this.get(`anon_tokens:${day}`), this.get(`anon_requests:${day}`),
    ]);
    return {
      day, store: this.useRedis() ? 'redis' : 'memory',
      paidCallsEnabled: await this.sharedStoreOk(),
      approvedModels: AI_APPROVED_MODELS,
      usage: { requests, tokens, tokensIn, tokensOut, anonymousRequests: anonRequests, anonymousTokens: anonTokens, rejectedRequests: rejected, callsWithoutProviderUsage: estimatedCalls },
      estimatedCostInr: Object.keys(this.pricing).length ? Math.round(cost * 100) / 100 : null,
      costNote: Object.keys(this.pricing).length ? 'Estimate from configured ai.pricing.<model>.* rates — not the provider invoice.' : 'No model pricing configured (ai.pricing.<model>.inputPer1M / outputPer1M).',
      budgetPercent: Math.round(100 * Math.max(tokens / c['ai.global.dailyTokens'], requests / c['ai.global.dailyRequests'], c['ai.global.dailyCostBudget'] > 0 ? cost / c['ai.global.dailyCostBudget'] : 0)),
      limits: c, alertThresholds: this.thresholds, pricing: this.pricing,
    };
  }
}

/** A paid call was refused by the budget/quota/store/model checks — no provider request was made. */
export class AiBudgetRefusedError extends Error {
  constructor(public readonly reason: string) { super(`AI call refused (${reason})`); }
}

/**
 * The one way non-chat features (admin tools, admin content generation, seller enrichment)
 * make a paid text call: approved model only, worst case reserved atomically first, one
 * attempt with a hard timeout, reconciled with real usage after. Without a limits service it
 * refuses in production (fail closed); unit tests may run without one.
 */
export async function completeWithinBudget(limits: AiLimitsService | null | undefined, o: {
  identityKey: string; apiKey: string; model: string; messages: OpenAiMessage[];
  maxTokens: number; temperature?: number; jsonMode?: boolean; timeoutMs?: number;
}): Promise<string> {
  if (!isApprovedModel(o.model)) throw new AiBudgetRefusedError('model-not-approved');
  if (!limits && process.env.NODE_ENV === 'production') throw new AiBudgetRefusedError('limits-unavailable');
  const maxTokens = Math.min(Math.max(1, Math.floor(o.maxTokens)), 1000);
  const reservation = limits
    ? await limits.reserve({
      identityKey: o.identityKey, anon: false, model: o.model, maxOutputTokens: maxTokens,
      estInputTokens: o.messages.reduce((n, m) => n + estimateTokens(m.content || '') + 4, 0),
    })
    : null;
  if (reservation && !reservation.ok) throw new AiBudgetRefusedError(reservation.reason || 'refused');
  let usage: any = null;
  try {
    return await openAiComplete(o.apiKey, o.model, o.messages, {
      maxTokens, temperature: o.temperature, jsonMode: o.jsonMode, timeoutMs: o.timeoutMs ?? 30000,
      onUsage: (u) => { usage = u; },
    });
  } finally {
    await reservation?.settle(usage);
  }
}

/** One shared limits instance for every module that spends AI budget (chat, admin tools, seller enrichment). */
@Module({ providers: [AiLimitsService], exports: [AiLimitsService] })
export class AiLimitsModule {}
