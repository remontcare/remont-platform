// How many reverse-proxy hops sit in front of this API, for Express's `trust proxy`.
//
// Production is api.remontindia.com -> CNAME -> *.up.railway.app: exactly ONE proxy (Railway's
// edge, which appends the real client address to X-Forwarded-For). Without `trust proxy`,
// req.ip is the edge's own address, so the ThrottlerGuard (which keys on req.ip) puts many
// unrelated users in one bucket — one abuser can exhaust e.g. the OTP limit for everyone.
//
// Trusting exactly the number of real hops makes Express take the client address from the
// RIGHT end of X-Forwarded-For (the entry Railway itself wrote); anything a client prepends
// is ignored, so the header can't be spoofed to dodge limits. Never use `true` (trust all),
// which would let a client choose its own IP.
//
// Default: 1 hop when running on Railway (it sets RAILWAY_* variables), otherwise 0 — the
// pre-existing behaviour. TRUST_PROXY_HOPS overrides it (e.g. 2 if a CDN is ever put in front).
export function resolveTrustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = env.TRUST_PROXY_HOPS;
  if (explicit !== undefined && explicit.trim() !== '') {
    const n = Number(explicit);
    return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
  }
  const onRailway = !!(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PUBLIC_DOMAIN);
  return onRailway ? 1 : 0;
}
