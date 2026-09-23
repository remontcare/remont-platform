import {
  BadRequestException, ConflictException, GatewayTimeoutException, ServiceUnavailableException,
} from '@nestjs/common';

// Cloudinary is mocked only for its CONFIG (credentials); the generation calls themselves go
// through global.fetch, which is stubbed per test. sharp runs for real.
jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(() => ({ cloud_name: 'test-cloud', api_key: 'test-key', api_secret: 'test-secret' })),
    uploader: { upload_stream: jest.fn(), destroy: jest.fn() },
  },
}));
// The reference-photo downloader resolves DNS before connecting (private-address guard);
// the guard itself is covered in product-search.spec.ts, so here a public address is stubbed.
jest.mock('dns/promises', () => ({ lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }));

import { Reflector } from '@nestjs/core';
import sharp from 'sharp';
import { MediaEntityType, MediaSource, UserRole } from '@prisma/client';
import { AiImageService } from './ai-image.service';
import { AI_IMAGE_PRESETS, HOUSE_STYLE, NEGATIVE_GUARDS, BRAND_GUARD, REFERENCE_GUARD, MAX_FINAL_PROMPT_CHARS, suggestPrompt } from './image-presets';
import { ADDON_NOT_ENABLED, isCloudinaryUrl } from './cloudinary-images';
import { AdminController } from '../admin/admin.module';

sharp.concurrency(1);

const ADMIN = { id: 'admin-1', role: UserRole.ADMIN };
const GEN_URL = 'https://api.cloudinary.com/v2/generate/test-cloud/';
const TEMP_URL = 'https://res.cloudinary.com/test-cloud/image/upload/v1/generated-temp.png';
const config = (vals: Record<string, string> = {}) => ({ get: (k: string, d?: any) => (k in vals ? vals[k] : d) }) as any;

/** Stub of the central media pipeline — the point is that AI images go THROUGH it. */
function mediaStub() {
  let n = 0;
  return {
    ingestImage: jest.fn(async (input: any) => {
      const meta = await sharp(input.buffer).metadata();
      const id = `media-${++n}`;
      return {
        id, storageKey: `remont/x/${id}`, width: meta.width, height: meta.height,
        deliveryUrl: `https://res.cloudinary.com/test-cloud/image/upload/v1/remont/x/${id}.webp`,
        variants: { thumb: 't', card: 'c', full: `https://res.cloudinary.com/test-cloud/image/upload/w_1200/v1/remont/x/${id}.webp` },
        __input: input,
      } as any;
    }),
    remove: jest.fn(async () => undefined),
  };
}

/**
 * Stands in for both HTTP hops: the generate call (api.cloudinary.com) and the download of
 * the returned short-lived image (res.cloudinary.com).
 *
 * The success body is Cloudinary's REAL documented shape — the generated URL sits at
 * data.assets[].storage.secure_url, and one call returns exactly one image. An earlier
 * version of this mock invented a flatter shape, which let a response-parsing bug reach
 * production ("returned no image"), so this must mirror the documentation.
 */
function mockCloudinary(opts: { width?: number; height?: number; generateStatus?: number; generateBody?: string; asyncTask?: boolean } = {}) {
  const calls: any[] = [];
  const fn = jest.fn(async (url: string, init?: any) => {
    if (String(url).startsWith(GEN_URL)) {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      if (opts.generateStatus) {
        return { ok: false, status: opts.generateStatus, statusText: 'err', text: async () => opts.generateBody || 'error' };
      }
      if (opts.asyncTask) {
        return { ok: true, status: 202, json: async () => ({ data: { result: null, status: 'pending', task_id: 'abc123' }, request_id: 'r1' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            assets: [{
              bytes: 168374,
              format: 'png',
              width: opts.width ?? 1536,
              height: opts.height ?? 1152,
              model: { family: 'flux', id: 'flux-2', tier: 'premium' },
              storage: {
                asset_id: 'e282fa1731dd75ab18386bda6abf4457',
                public_id: 'susggqvm0h41ewohtdsr',
                resource_type: 'image',
                secure_url: TEMP_URL,
                storage_type: 'temporary',
                type: 'upload',
                version: 1784645746,
              },
            }],
          },
          limits: { addons_quota: [] },
          request_id: '15c8373fbfae88ee1c3ec34783b76ef6',
        }),
      };
    }
    // Download of the generated image.
    const png = await sharp({ create: { width: opts.width ?? 1536, height: opts.height ?? 1152, channels: 3, background: '#ccc' } }).png().toBuffer();
    return { ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) };
  }) as any;
  fn.calls = calls;
  global.fetch = fn;
  return fn;
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.clearAllMocks(); });

describe('presets — one shared Remont visual identity at the website 4:3 standard', () => {
  it('every entity has defaults, the 4:3 website ratio and a Cloudinary folder via the media policy', () => {
    const { available, presets, model } = new AiImageService(config(), mediaStub() as any).presets();
    expect(available).toBe(true);
    expect(model).toEqual({ family: 'flux', tier: 'premium' }); // decision: FLUX premium default
    expect(presets.map((p) => p.entity).sort()).toEqual(['CATALOG', 'CATEGORY', 'PRODUCT', 'SERVICE', 'SUBCATEGORY']);
    for (const p of presets) {
      expect(p.aspect).toBe('4:3');
      expect(p.size).toBe('1536x1152');
      expect(p.defaultStyles.length).toBeGreaterThan(0);
    }
    expect(AI_IMAGE_PRESETS.CATALOG.mediaEntityType).toBe(MediaEntityType.PRODUCT);
    expect(AI_IMAGE_PRESETS.SUBCATEGORY.mediaEntityType).toBe(MediaEntityType.SUBCATEGORY);
  });

  it('the model is configurable without touching the feature', () => {
    const svc = new AiImageService(config({ CLOUDINARY_AI_MODEL_FAMILY: 'ideogram', CLOUDINARY_AI_MODEL_TIER: 'standard' }), mediaStub() as any);
    expect(svc.presets().model).toEqual({ family: 'ideogram', tier: 'standard' });
  });

  it('a suggested prompt always carries the house style, brand guard and quality guards', () => {
    const p = suggestPrompt('SERVICE', { name: 'AC Repair', category: 'Home Maintenance', subCategory: 'AC Services' });
    expect(p).toContain('AC Repair');
    expect(p).toContain('Home Maintenance');   // full entity hierarchy reaches the prompt
    expect(p).toContain('AC Services');
    expect(p).toContain(HOUSE_STYLE);
    expect(p).toContain(BRAND_GUARD);
    expect(p).toContain(NEGATIVE_GUARDS);
  });

  it('the modal gets a SHORT editable subject, with the internal rules kept out of it', () => {
    const out = new AiImageService(config(), mediaStub() as any).suggest({ entity: 'SERVICE', name: 'AC Repair', category: 'Home Maintenance', subCategory: 'AC Services' });
    // What the admin sees and may edit: just the subject sentence.
    expect(out.subject).toContain('AC Repair');
    expect(out.subject).not.toContain(HOUSE_STYLE);
    expect(out.subject).not.toContain(NEGATIVE_GUARDS);
    expect(out.subject).not.toContain(BRAND_GUARD);
    // Comfortably inside the admin's own character limit (the old modal pre-filled the whole
    // assembled prompt here, which overflowed it).
    expect(out.subject.length).toBeLessThan(out.maxSubjectChars / 2);
    expect(out.maxSubjectChars).toBe(1200);
    // The rules still exist — they are just applied server-side.
    expect(out.prompt).toContain(NEGATIVE_GUARDS);
  });

  it('an edited subject still gets the Remont rules appended server-side', async () => {
    const fetchMock = mockCloudinary();
    await new AiImageService(config(), mediaStub() as any).generate(
      { entity: 'SERVICE', name: 'AC Repair', prompt: 'Technician servicing a wall-mounted AC in a Mumbai flat.' }, ADMIN,
    );
    const sent = fetchMock.calls[0].body.prompt;
    expect(sent).toContain('Technician servicing a wall-mounted AC in a Mumbai flat.');
    expect(sent).toContain(HOUSE_STYLE);
    expect(sent).toContain(BRAND_GUARD);
    expect(sent).toContain(NEGATIVE_GUARDS);
  }, 30000);

  it('an over-long subject is trimmed to fit the provider budget, never the quality rules', async () => {
    const fetchMock = mockCloudinary();
    const longSubject = 'A very detailed product scene. '.repeat(40).slice(0, 1200); // at the admin cap
    await new AiImageService(config(), mediaStub() as any).generate({ entity: 'PRODUCT', name: 'Fan', prompt: longSubject }, ADMIN);
    const sent = fetchMock.calls[0].body.prompt;
    expect(sent.length).toBeLessThanOrEqual(MAX_FINAL_PROMPT_CHARS);
    expect(sent).toContain(NEGATIVE_GUARDS); // rules survive
    expect(sent).toContain(HOUSE_STYLE);
  }, 30000);

  it('a subject beyond the admin cap is rejected with a clear message', () => {
    const svc = new AiImageService(config(), mediaStub() as any);
    expect(() => svc.suggest({ entity: 'PRODUCT', name: 'Fan', prompt: 'x'.repeat(1201) })).toThrow(/under 1200 characters/);
  });

  it('rejects unknown entities and styles instead of silently guessing', () => {
    const svc = new AiImageService(config(), mediaStub() as any);
    expect(() => svc.suggest({ entity: 'BILLBOARD', name: 'x' })).toThrow(BadRequestException);
    expect(() => svc.suggest({ entity: 'SERVICE', name: 'x', styles: ['NEON_CYBERPUNK'] })).toThrow(BadRequestException);
  });
});

describe('generation per entity — Cloudinary add-on → media pipeline', () => {
  it.each([
    ['category', 'CATEGORY', MediaEntityType.CATEGORY, { name: 'Home Maintenance' }],
    ['sub-category', 'SUBCATEGORY', MediaEntityType.SUBCATEGORY, { name: 'AC Services', category: 'Home Maintenance' }],
    ['service', 'SERVICE', MediaEntityType.SERVICE, { name: 'AC Repair', category: 'Home Maintenance', subCategory: 'AC Services' }],
    ['product', 'PRODUCT', MediaEntityType.PRODUCT, { name: 'Ceiling Fan', brand: 'Acme', category: 'Fans' }],
  ])('%s generation calls text_to_image and stores 4:3 AI media', async (_label, entity, mediaEntityType, ctx) => {
    const fetchMock = mockCloudinary();
    const media = mediaStub();
    const res = await new AiImageService(config(), media as any).generate({ entity, ...ctx }, ADMIN);

    const call = fetchMock.calls[0];
    expect(call.url).toBe(`${GEN_URL}text_to_image`);          // no reference images
    expect(call.body.model).toEqual({ family: 'flux', tier: 'premium' });
    expect(call.body.image_size).toEqual({ width: 1536, height: 1152 });
    expect(call.body.target).toEqual({ target_type: 'temporary' }); // pipeline stores the permanent copy
    expect(call.headers.Authorization).toMatch(/^Basic /);      // existing Cloudinary key/secret
    expect(JSON.stringify(call.body)).not.toContain('test-secret');

    const input = media.ingestImage.mock.calls[0][0] as any;
    expect(input.entityType).toBe(mediaEntityType);
    expect(input.source).toBe(MediaSource.AI_GENERATED);
    const meta = await sharp(input.buffer).metadata();
    expect(meta.width! / meta.height!).toBeCloseTo(4 / 3, 2);
    expect(res.aspect).toBe('4:3');
    expect(res.images[0].url).toContain('res.cloudinary.com');
  }, 30000);

  it("reads the URL from Cloudinary's real nesting (data.assets[].storage.secure_url)", async () => {
    mockCloudinary();
    const media = mediaStub();
    const res = await new AiImageService(config(), media as any).generate({ entity: 'SERVICE', name: 'AC Service' }, ADMIN);
    // The short-lived asset was downloaded and stored through the pipeline...
    expect((global.fetch as jest.Mock).mock.calls.some(([u]) => String(u) === TEMP_URL)).toBe(true);
    expect(media.ingestImage).toHaveBeenCalledTimes(1);
    expect(res.images).toHaveLength(1);
  }, 30000);

  it('asks for one image per call — the API has no number-of-images parameter', async () => {
    const fetchMock = mockCloudinary();
    const media = mediaStub();
    const res = await new AiImageService(config(), media as any).generate({ entity: 'SERVICE', name: 'AC Service', count: 2 }, ADMIN);
    expect(fetchMock.calls).toHaveLength(2);                       // two images => two calls
    for (const c of fetchMock.calls) expect(c.body.number_of_images).toBeUndefined();
    expect(res.images).toHaveLength(2);
    expect(media.ingestImage).toHaveBeenCalledTimes(2);
  }, 45000);

  it('an asynchronous task response is reported clearly instead of "no image"', async () => {
    mockCloudinary({ asyncTask: true });
    const err = await new AiImageService(config(), mediaStub() as any).generate({ entity: 'SERVICE', name: 'AC Service' }, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toMatch(/asynchronous generation task/);
  }, 30000);

  it('catalog mode generates several distinct views in one request', async () => {
    const fetchMock = mockCloudinary();
    const media = mediaStub();
    const res = await new AiImageService(config(), media as any).generate({ entity: 'CATALOG', name: 'Bathroom Faucet', count: 3 }, ADMIN);
    expect(res.images.map((i) => i.view)).toEqual(['MAIN_WHITE', 'FRONT', 'LIFESTYLE']);
    expect(fetchMock.calls).toHaveLength(3);
    expect(media.ingestImage).toHaveBeenCalledTimes(3);
  }, 45000);

  it('a non-4:3 provider response is centre-cropped back to the website ratio', async () => {
    mockCloudinary({ width: 1024, height: 1024 }); // provider ignored the requested size
    const media = mediaStub();
    await new AiImageService(config(), media as any).generate({ entity: 'PRODUCT', name: 'Fan' }, ADMIN);
    const meta = await sharp((media.ingestImage.mock.calls[0][0] as any).buffer).metadata();
    expect(meta.width! / meta.height!).toBeCloseTo(4 / 3, 2);
  }, 30000);
});

describe('product reference images (image_to_image)', () => {
  const REF = 'https://res.cloudinary.com/test-cloud/image/upload/v1/remont/products/original/abc.webp';

  it('uses image_to_image with the reference, and tells the model to preserve the product', async () => {
    const fetchMock = mockCloudinary();
    const media = mediaStub();
    const res = await new AiImageService(config(), media as any).generate(
      { entity: 'PRODUCT', name: 'Ceiling Fan', brand: 'Acme', referenceImages: [REF] }, ADMIN,
    );

    const call = fetchMock.calls[0];
    expect(call.url).toBe(`${GEN_URL}image_to_image`);
    expect(call.body.reference_images).toEqual([{ source_type: 'url', url: REF }]);
    expect(call.body.prompt).toContain(REFERENCE_GUARD);
    expect(res.referenceImages).toEqual([REF]);
  }, 30000);

  it('only accepts references already stored in Remont media (no arbitrary URL fetching)', async () => {
    mockCloudinary();
    const svc = new AiImageService(config(), mediaStub() as any);
    for (const bad of ['https://evil.example.com/x.png', 'http://res.cloudinary.com/x.png', 'file:///etc/passwd', 'not-a-url']) {
      await expect(svc.generate({ entity: 'PRODUCT', name: 'Fan', referenceImages: [bad] }, ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(svc.generate({ entity: 'PRODUCT', name: 'Fan', referenceImages: Array(5).fill(REF) }, ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    expect(isCloudinaryUrl(REF)).toBe(true);
  });
});

describe('failures — clear admin-facing messages, never a silent provider switch', () => {
  it.each([[402], [403], [404], [401]])('add-on not enabled (HTTP %i) → explicit setup instruction', async (status) => {
    mockCloudinary({ generateStatus: status, generateBody: 'add-on not enabled for this account' });
    const err = await new AiImageService(config(), mediaStub() as any).generate({ entity: 'SERVICE', name: 'AC Repair' }, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toBe(ADDON_NOT_ENABLED);
    expect(err.message).toMatch(/Image Generation add-on is not enabled/);
  });

  it('exhausted Cloudinary credits and rate limits get their own messages', async () => {
    mockCloudinary({ generateStatus: 400, generateBody: 'monthly credit quota exceeded' });
    await expect(new AiImageService(config(), mediaStub() as any).generate({ entity: 'SERVICE', name: 'x' }, ADMIN))
      .rejects.toThrow(/credits .* are exhausted/);
    mockCloudinary({ generateStatus: 429, generateBody: 'too many requests' });
    await expect(new AiImageService(config(), mediaStub() as any).generate({ entity: 'SERVICE', name: 'x' }, ADMIN))
      .rejects.toThrow(/rate limited/);
  });

  it('a generic Cloudinary failure never falls back to another provider', async () => {
    mockCloudinary({ generateStatus: 500, generateBody: 'internal error' });
    const media = mediaStub();
    await expect(new AiImageService(config(), media as any).generate({ entity: 'PRODUCT', name: 'Fan' }, ADMIN))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    // Nothing stored, and no call to any non-Cloudinary host.
    expect(media.ingestImage).not.toHaveBeenCalled();
    for (const [url] of (global.fetch as jest.Mock).mock.calls) expect(String(url)).toContain('cloudinary.com');
  });

  it('times out instead of hanging forever', async () => {
    global.fetch = jest.fn(async () => { const e: any = new Error('aborted'); e.name = 'AbortError'; throw e; }) as any;
    await expect(new AiImageService(config(), mediaStub() as any).generate({ entity: 'PRODUCT', name: 'Fan' }, ADMIN))
      .rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('a half-stored set is rolled back — no stray images in the Media Library', async () => {
    mockCloudinary();
    const media = mediaStub();
    media.ingestImage
      .mockImplementationOnce(async () => ({ id: 'media-ok', variants: {}, deliveryUrl: 'u', storageKey: 'k' }) as any)
      .mockImplementationOnce(async () => { throw new BadRequestException('File rejected by security validation.'); });
    await expect(new AiImageService(config(), media as any).generate({ entity: 'CATALOG', name: 'Faucet', count: 2 }, ADMIN))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(media.remove).toHaveBeenCalledWith('media-ok', ADMIN);
  }, 30000);

  it('enforces the per-request cap, a subject, and one generation at a time per admin', async () => {
    mockCloudinary();
    const svc = new AiImageService(config(), mediaStub() as any);
    await expect(svc.generate({ entity: 'SERVICE', name: 'x', count: 9 }, ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.generate({ entity: 'SERVICE' }, ADMIN)).rejects.toBeInstanceOf(BadRequestException);

    let release: (v?: unknown) => void;
    const gate = new Promise((r) => { release = r; });
    const png = await sharp({ create: { width: 1536, height: 1152, channels: 3, background: '#eee' } }).png().toBuffer();
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).startsWith(GEN_URL)) { await gate; return { ok: true, status: 200, json: async () => ({ assets: [{ secure_url: TEMP_URL }] }) }; }
      return { ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) };
    }) as any;
    const first = svc.generate({ entity: 'PRODUCT', name: 'Fan' }, ADMIN);
    await expect(svc.generate({ entity: 'PRODUCT', name: 'Fan' }, ADMIN)).rejects.toBeInstanceOf(ConflictException);
    release!();
    await first;
  }, 30000);
});

describe('admin product flow: find real product photo → import → generate from it', () => {
  const FOUND = 'https://cdn.example.com/acme-ceiling-fan.jpg';

  /** Tavily + the candidate download + Cloudinary, in one stub. */
  function mockFullFlow() {
    const gen = mockCloudinary();
    const realPng = sharp({ create: { width: 800, height: 600, channels: 3, background: '#abc' } }).png().toBuffer();
    const inner = global.fetch as jest.Mock;
    global.fetch = jest.fn(async (url: string, init?: any) => {
      if (String(url).startsWith('https://api.tavily.com/')) {
        (global.fetch as any).tavilyBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ images: [FOUND, 'https://cdn.example.com/other.jpg'] }) };
      }
      if (String(url) === FOUND) {
        const b = await realPng;
        return { ok: true, status: 200, headers: { get: (k: string) => (k === 'content-type' ? 'image/jpeg' : null) }, body: null, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
      }
      return inner(url, init);
    }) as any;
    (global.fetch as any).calls = gen.calls;
    return global.fetch as any;
  }

  it('searches with brand + model, imports the chosen photo through the media pipeline, then generates with it as the reference', async () => {
    const fetchMock = mockFullFlow();
    const media = mediaStub();
    const svc = new AiImageService(config({ TAVILY_API_KEY: 'tvly-test' }), media as any);

    // 1. Find the real product.
    const found = await svc.findProductPhotos({ entity: 'PRODUCT', name: 'Ceiling Fan', brand: 'Acme', model: 'AC-1200X', category: 'Fans' }, ADMIN);
    expect(found.images).toContain(FOUND);
    expect(fetchMock.tavilyBody.query).toContain('AC-1200X');
    expect(fetchMock.tavilyBody.include_images).toBe(true);

    // 2. Import the chosen candidate — it goes through MediaService, not straight to the model.
    const imported = await svc.importProductPhoto(FOUND, ADMIN);
    const importInput = media.ingestImage.mock.calls[0][0] as any;
    expect(importInput.entityType).toBe(MediaEntityType.PRODUCT);
    expect(importInput.source).toBe(MediaSource.UPLOAD);
    expect((await sharp(importInput.buffer).metadata()).format).toBe('png'); // real downloaded bytes
    expect(imported.variants!.full).toContain('res.cloudinary.com');

    // 3. Generate using the stored asset as the reference.
    const res = await svc.generate(
      { entity: 'PRODUCT', name: 'Ceiling Fan', brand: 'Acme', referenceImages: [imported.variants!.full] }, ADMIN,
    );
    const genCall = fetchMock.calls[0];
    expect(genCall.url).toBe(`${GEN_URL}image_to_image`);
    expect(genCall.body.reference_images).toEqual([{ source_type: 'url', url: imported.variants!.full }]);
    expect(genCall.body.prompt).toContain(REFERENCE_GUARD); // preserve the real product's identity
    expect(genCall.body.image_size).toEqual({ width: 1536, height: 1152 }); // 4:3 kept
    expect(res.images[0].url).toContain('res.cloudinary.com');
    expect(media.ingestImage).toHaveBeenCalledTimes(2); // imported reference + generated image
  }, 60000);

  it('prompt-only generation stays available when no real product is found', async () => {
    const fetchMock = mockCloudinary();
    const svc = new AiImageService(config({ TAVILY_API_KEY: 'tvly-test' }), mediaStub() as any);
    const res = await svc.generate({ entity: 'PRODUCT', name: 'Generic Bucket' }, ADMIN);
    expect(fetchMock.calls[0].url).toBe(`${GEN_URL}text_to_image`); // no reference => prompt-only
    expect(res.images).toHaveLength(1);
  }, 30000);

  it('reports a clear message when the search key is missing, and when nothing is found', async () => {
    const noKey = new AiImageService(config(), mediaStub() as any);
    expect(noKey.presets().search).toEqual({ available: false });
    await expect(noKey.findProductPhotos({ entity: 'PRODUCT', name: 'Fan' }, ADMIN)).rejects.toThrow(/TAVILY_API_KEY is missing/);

    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ images: [] }) })) as any;
    const svc = new AiImageService(config({ TAVILY_API_KEY: 'tvly-test' }), mediaStub() as any);
    expect(svc.presets().search).toEqual({ available: true });
    await expect(svc.findProductPhotos({ entity: 'PRODUCT', name: 'Fan' }, ADMIN)).rejects.toThrow(/No product photos found/);
  });

  it('importing is subject to the same download guards (no internal addresses)', async () => {
    const svc = new AiImageService(config({ TAVILY_API_KEY: 'tvly-test' }), mediaStub() as any);
    await expect(svc.importProductPhoto('http://cdn.example.com/x.png', ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.importProductPhoto('https://localhost/x.png', ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.importProductPhoto('', ADMIN)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('admin generation is free — no wallet, no charge', () => {
  it('has no wallet or database dependency, so it cannot debit a seller or customer', async () => {
    mockCloudinary();
    const media = mediaStub();
    // Constructed with only (config, media): no WalletService, no PrismaService — an admin
    // generation cannot produce a wallet debit or an AiFeatureUsage row. Only Cloudinary's
    // own AI credits (infrastructure) are consumed.
    const svc = new AiImageService(config(), media as any);
    expect(AiImageService.length).toBe(2);
    const res = await svc.generate({ entity: 'CATEGORY', name: 'Home Maintenance' }, ADMIN);
    expect(res.images).toHaveLength(1);
    expect(Object.keys(svc as any)).not.toEqual(expect.arrayContaining(['wallet', 'prisma']));
  }, 30000);
});

describe('admin routes', () => {
  const reflector = new Reflector();

  it('AI image routes are admin-only (controller roles) and rate limited', () => {
    expect(reflector.getAllAndOverride('roles', [AdminController.prototype.aiImageGenerate, AdminController])).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(reflector.getAllAndOverride('roles', [AdminController.prototype.aiImagePresets, AdminController])).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(reflector.getAllAndOverride('isPublic', [AdminController.prototype.aiImageGenerate, AdminController])).toBeFalsy();
    const keys = Reflect.getMetadataKeys(AdminController.prototype.aiImageGenerate);
    expect(keys.some((k: any) => String(k).startsWith('THROTTLER:LIMIT'))).toBe(true);
  });
});
