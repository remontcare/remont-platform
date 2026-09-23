import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

// DNS is mocked so the private-address guard can be exercised without real lookups.
jest.mock('dns/promises', () => ({ lookup: jest.fn() }));

import { lookup } from 'dns/promises';
import sharp from 'sharp';
import {
  MAX_REFERENCE_BYTES, buildProductQuery, fetchExternalImage, isPrivateAddress, searchProductImages, tavilySearch,
} from './product-search';

sharp.concurrency(1);
const mockLookup = lookup as unknown as jest.Mock;
const publicIp = () => mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.clearAllMocks(); });

const png = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#888' } }).png().toBuffer();
const asArrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

describe('Tavily search — the seller flow’s request, reused', () => {
  it('sends the same advanced/5-result request the seller enrichment has always sent', async () => {
    let body: any;
    global.fetch = jest.fn(async (_u: string, init: any) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ images: [] }) }; }) as any;
    await tavilySearch({ apiKey: 'tvly-test', query: 'q', includeImages: true });
    expect(body).toEqual({ api_key: 'tvly-test', query: 'q', search_depth: 'advanced', include_images: true, max_results: 5 });
  });

  it('builds a query from brand + name + model/SKU + category', () => {
    const q = buildProductQuery({ name: 'Ceiling Fan', brand: 'Acme', model: 'AC-1200X', category: 'Fans' });
    expect(q).toContain('Acme');
    expect(q).toContain('Ceiling Fan');
    expect(q).toContain('AC-1200X');
    expect(q).toContain('Fans');
  });

  it('returns https candidates only, de-duplicated and capped', async () => {
    const images = [
      'https://cdn.example.com/a.jpg', 'https://cdn.example.com/a.jpg', // duplicate
      'http://insecure.example.com/b.jpg',                              // http dropped
      ...Array.from({ length: 10 }, (_, i) => `https://cdn.example.com/x${i}.jpg`),
    ];
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ images }) })) as any;
    const out = await searchProductImages('tvly-test', { name: 'Fan' });
    expect(out).toHaveLength(8);
    expect(new Set(out).size).toBe(8);
    expect(out.every((u) => u.startsWith('https://'))).toBe(true);
  });
});

describe('private-address guard', () => {
  it.each([
    ['127.0.0.1', true], ['10.1.2.3', true], ['172.16.0.9', true], ['172.31.255.1', true],
    ['192.168.1.5', true], ['169.254.169.254', true], ['100.64.0.1', true], ['0.0.0.0', true],
    ['::1', true], ['fd00::1', true], ['fe80::1', true], ['::ffff:10.0.0.1', true],
    ['93.184.216.34', false], ['1.1.1.1', false], ['172.32.0.1', false],
    ['not-an-ip', true],
  ])('%s → private=%s', (ip, expected) => {
    expect(isPrivateAddress(ip as string)).toBe(expected);
  });
});

describe('fetchExternalImage — the only fetch of an arbitrary host', () => {
  it('downloads a public https image', async () => {
    publicIp();
    const body = await png();
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200,
      headers: { get: (k: string) => (k === 'content-type' ? 'image/png' : null) },
      body: null, arrayBuffer: async () => asArrayBuffer(body),
    })) as any;
    const out = await fetchExternalImage('https://cdn.example.com/p.png');
    expect(out.equals(body)).toBe(true);
  });

  it.each([
    ['http://cdn.example.com/p.png', 'plain http'],
    ['https://localhost/p.png', 'localhost'],
    ['https://service.internal/p.png', 'internal hostname'],
    ['ftp://cdn.example.com/p.png', 'non-http scheme'],
    ['not a url', 'garbage'],
  ])('refuses %s (%s)', async (url) => {
    publicIp();
    global.fetch = jest.fn() as any;
    await expect(fetchExternalImage(url)).rejects.toBeInstanceOf(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled(); // blocked BEFORE any connection
  });

  it('refuses a public hostname that resolves to a private address (DNS rebinding)', async () => {
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]); // cloud metadata
    global.fetch = jest.fn() as any;
    await expect(fetchExternalImage('https://evil.example.com/p.png')).rejects.toBeInstanceOf(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('re-validates every redirect hop, so a redirect to an internal address is refused', async () => {
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])  // first hop public
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);          // redirect target internal
    global.fetch = jest.fn(async () => ({
      ok: false, status: 302, headers: { get: (k: string) => (k === 'location' ? 'https://internal.example.com/p.png' : null) },
    })) as any;
    await expect(fetchExternalImage('https://cdn.example.com/p.png')).rejects.toBeInstanceOf(BadRequestException);
    expect(global.fetch).toHaveBeenCalledTimes(1); // second hop never connected
  });

  it('refuses a declared oversize response before reading it', async () => {
    publicIp();
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200,
      headers: { get: (k: string) => (k === 'content-type' ? 'image/png' : k === 'content-length' ? String(MAX_REFERENCE_BYTES + 1) : null) },
    })) as any;
    await expect(fetchExternalImage('https://cdn.example.com/big.png')).rejects.toThrow(/too large/);
  });

  it('aborts a streamed body that exceeds the cap even when Content-Length lied', async () => {
    publicIp();
    const chunk = new Uint8Array(1024 * 1024); // 1MB per read, forever
    const cancel = jest.fn(async () => undefined);
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200,
      headers: { get: (k: string) => (k === 'content-type' ? 'image/png' : null) },
      body: { getReader: () => ({ read: async () => ({ done: false, value: chunk }), cancel }) },
    })) as any;
    await expect(fetchExternalImage('https://cdn.example.com/lying.png')).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalled(); // stream stopped, not buffered to the end
  });

  it('refuses a non-image content type', async () => {
    publicIp();
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200, headers: { get: (k: string) => (k === 'content-type' ? 'text/html' : null) },
    })) as any;
    await expect(fetchExternalImage('https://cdn.example.com/page.html')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('surfaces a failed download as a retryable error', async () => {
    publicIp();
    global.fetch = jest.fn(async () => { throw new Error('ECONNRESET'); }) as any;
    await expect(fetchExternalImage('https://cdn.example.com/p.png')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
