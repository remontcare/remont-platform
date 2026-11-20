// eslint-disable-next-line @typescript-eslint/no-require-imports -- same import style as main.ts
const express = require('express');
import { AddressInfo } from 'net';
import { resolveTrustProxyHops } from './trust-proxy';

/**
 * Per-client rate limits (ThrottlerGuard, Remi AI limits) key on req.ip, so behind Railway's
 * edge it must be the real client — taken from the entry Railway itself appends, never one a
 * client can forge.
 */
describe('resolveTrustProxyHops', () => {
  it('trusts exactly one hop on Railway and none elsewhere', () => {
    expect(resolveTrustProxyHops({ RAILWAY_ENVIRONMENT_ID: 'x' } as any)).toBe(1);
    expect(resolveTrustProxyHops({} as any)).toBe(0);
  });

  it('TRUST_PROXY_HOPS overrides, and an invalid value falls back to 0 (never "trust all")', () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '2', RAILWAY_ENVIRONMENT_ID: 'x' } as any)).toBe(2);
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: 'true' } as any)).toBe(0);
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '99' } as any)).toBe(0);
  });

  it('with one hop, req.ip is the address the proxy appended — a client-prepended value is ignored', async () => {
    const app = express();
    app.set('trust proxy', resolveTrustProxyHops({ RAILWAY_ENVIRONMENT_ID: 'x' } as any));
    app.get('/', (req, res) => { res.json({ ip: req.ip }); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'X-Forwarded-For': '6.6.6.6, 203.0.113.7' } });
      expect((await res.json()).ip).toBe('203.0.113.7');
    } finally {
      server.close();
    }
  });
});
