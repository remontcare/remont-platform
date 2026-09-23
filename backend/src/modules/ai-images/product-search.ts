import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCT PHOTO DISCOVERY (Tavily)
//
// The Tavily call is the one the seller product-enrichment flow has always used
// (ai-enrichment.module.ts) — moved here so the admin product generator can reuse it
// without a second implementation. Same endpoint, same parameters, same result shape, so
// seller behaviour is unchanged.
//
// It also holds the hardened downloader for the images Tavily points at. Those URLs come
// from the open web, so fetching one is the only place in this codebase that reaches an
// arbitrary host: HTTPS only, DNS resolved and checked against private/internal ranges
// before connecting, redirects re-validated per hop, hard size cap. The bytes then go
// through the normal MediaService pipeline (signature, ClamAV, sharp, Cloudinary) like any
// upload — nothing is trusted because it came from a search result.
// ═══════════════════════════════════════════════════════════════════════════

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

export interface TavilySearchOptions {
  apiKey: string;
  query: string;
  includeImages: boolean;
  maxResults?: number;
}

/** Unchanged from the seller implementation: advanced depth, 5 results. */
export async function tavilySearch(opts: TavilySearchOptions): Promise<any> {
  const res = await fetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: opts.apiKey,
      query: opts.query,
      search_depth: 'advanced',
      include_images: opts.includeImages,
      max_results: opts.maxResults ?? 5,
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json();
}

export interface ProductSearchContext {
  name: string;
  brand?: string;
  model?: string;
  category?: string;
  subCategory?: string;
}

/** Builds the search query from what the admin is editing. Same shape as the seller's
 *  image search (brand + name + category + "product photo"), plus the model/SKU, which is
 *  what actually pins down the right unit for a branded product. */
export function buildProductQuery(ctx: ProductSearchContext): string {
  return [ctx.brand, ctx.name, ctx.model, ctx.subCategory || ctx.category, 'official product photo']
    .map((p) => (p || '').trim())
    .filter(Boolean)
    .join(' ');
}

/** Candidate product photos from the open web. Returns URLs only — nothing is downloaded
 *  or stored until the admin picks one. */
export async function searchProductImages(apiKey: string, ctx: ProductSearchContext, limit = 8): Promise<string[]> {
  const search = await tavilySearch({ apiKey, query: buildProductQuery(ctx), includeImages: true });
  const images: string[] = (search?.images || [])
    .map((i: any) => (typeof i === 'string' ? i : i?.url))
    .filter((u: any) => typeof u === 'string' && /^https:\/\//i.test(u));
  return [...new Set(images)].slice(0, limit);
}

// ─── Hardened download of a web image ────────────────────────────────────────

export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

/** RFC1918 + loopback + link-local + CGNAT + unique-local, v4 and v6. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (!v) return true; // unresolvable / unexpected → treat as unsafe
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;        // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                       // multicast / reserved
    return false;
  }
  const ipv6 = ip.toLowerCase();
  if (ipv6 === '::1' || ipv6 === '::') return true;
  if (ipv6.startsWith('fc') || ipv6.startsWith('fd')) return true; // unique local
  if (ipv6.startsWith('fe80')) return true;                        // link-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ipv6);       // IPv4-mapped
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

/** HTTPS + public-address check for one hop. Throws on anything suspicious. */
async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('That image link is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new BadRequestException('Only HTTPS image links can be imported');
  if (!url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.internal')) {
    throw new BadRequestException('That image link points to an internal address');
  }
  const resolved = await lookup(url.hostname, { all: true }).catch(() => []);
  if (!resolved.length) throw new BadRequestException('That image link could not be resolved');
  for (const { address } of resolved) {
    if (isPrivateAddress(address)) throw new BadRequestException('That image link points to an internal address');
  }
  return url;
}

/**
 * Downloads a candidate product photo. Redirects are followed manually so every hop is
 * re-checked, the response must declare an image type, and the body is read with a hard
 * byte ceiling (a lying or missing Content-Length cannot get past it).
 */
export async function fetchExternalImage(raw: string, logger?: Logger): Promise<Buffer> {
  let target = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertSafeUrl(target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'image/*' } });
    } catch (e: any) {
      clearTimeout(timer);
      logger?.warn(`Reference image download failed for ${url.hostname}: ${e?.message}`);
      throw new ServiceUnavailableException('That image could not be downloaded. Please pick another one.');
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      clearTimeout(timer);
      const location = res.headers.get('location');
      if (!location) throw new ServiceUnavailableException('That image could not be downloaded. Please pick another one.');
      target = new URL(location, url).toString(); // re-validated on the next loop
      continue;
    }

    try {
      if (!res.ok) throw new ServiceUnavailableException('That image could not be downloaded. Please pick another one.');
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (type && !type.startsWith('image/')) throw new BadRequestException('That link is not an image');
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared && declared > MAX_REFERENCE_BYTES) throw new BadRequestException('That image is too large (max 10MB)');
      return await readCapped(res, MAX_REFERENCE_BYTES);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ServiceUnavailableException('That image link redirects too many times');
}

/** Reads the body, aborting as soon as the cap is exceeded — never buffers the whole of an
 *  oversized response. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = (res.body as any)?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new BadRequestException('That image is too large (max 10MB)');
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BadRequestException('That image is too large (max 10MB)');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
