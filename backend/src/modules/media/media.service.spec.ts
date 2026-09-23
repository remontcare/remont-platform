import {
  BadRequestException, ConflictException, ForbiddenException, InternalServerErrorException, PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';

// Hoisted above the imports. ClamAV and Cloudinary are the two network services in the
// pipeline, so both are mocked; sharp runs for real, so format detection, dimension limits
// and the WebP re-encode below are genuine.
jest.mock('clamscan', () => {
  const scanStream = jest.fn();
  const init = jest.fn().mockImplementation(async () => ({ scanStream }));
  const Ctor: any = jest.fn().mockImplementation(() => ({ init }));
  Ctor.__mocks = { init, scanStream };
  return Ctor;
});
// Real fs, with every write entry point recorded — asserted untouched in afterAll (no image
// may ever land on the local, ephemeral Railway filesystem). jest.spyOn can't be used here:
// Node's fs exports are non-configurable.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    writeFileSync: jest.fn(actual.writeFileSync),
    writeFile: jest.fn(actual.writeFile),
    createWriteStream: jest.fn(actual.createWriteStream),
    promises: { ...actual.promises, writeFile: jest.fn(actual.promises.writeFile) },
  };
});
jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(() => ({ cloud_name: 'test-cloud', api_key: 'test-key', api_secret: 'test-secret' })),
    uploader: { upload_stream: jest.fn(), destroy: jest.fn(async () => ({ result: 'ok' })) },
  },
}));

import * as fs from 'fs';
import { crc32 } from 'zlib';
import NodeClamMocked from 'clamscan';
import { v2 as cloudinaryMock } from 'cloudinary';
import sharp from 'sharp';
import { MediaEntityType, MediaSource, MediaStatus, UserRole } from '@prisma/client';
import { MediaService } from './media.service';
import { assertNoNewInlineImages, buildStorageKey, canUploadEntityType, parseEntityType, sanitizeOriginalName } from './media.policy';
import { __resetClamscanClientForTests } from '../uploads/upload-security.interceptor';
import { ProductsService } from '../products/products.module';
import { AiEnrichmentService } from '../ai-enrichment/ai-enrichment.module';
import { AdminService } from '../admin/admin.module';
import { ServiceVendorsService } from '../vendors/vendors.module';
import { OrdersService } from '../orders/orders.module';

sharp.concurrency(1);
const { scanStream: mockScanStream } = (NodeClamMocked as any).__mocks;
const uploadStream = cloudinaryMock.uploader.upload_stream as unknown as jest.Mock;
const destroy = cloudinaryMock.uploader.destroy as unknown as jest.Mock;

const SELLER = { id: 'seller-user-1', role: UserRole.PRODUCT_VENDOR };
const OTHER_SELLER = { id: 'seller-user-2', role: UserRole.PRODUCT_VENDOR };
const ADMIN = { id: 'admin-user-1', role: UserRole.ADMIN };
const CUSTOMER = { id: 'customer-1', role: UserRole.CUSTOMER };
const PARTNER = { id: 'partner-user-1', role: UserRole.SERVICE_VENDOR };
const MB = 1024 * 1024;
const CLOUDINARY_URL = /^https:\/\/res\.cloudinary\.com\/test-cloud\/image\/upload\//;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// ─── Fixtures (real image bytes, generated — no binary files checked in) ───────
const solid = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 90, b: 40 } } });
const jpeg = () => solid(64, 48).jpeg().toBuffer();
const png = () => solid(64, 48).png().toBuffer();
const webp = () => solid(64, 48).webp().toBuffer();
/** Windows PE header, padded — what an .exe renamed to photo.jpg actually contains. */
const fakeExe = () => Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'binary'), Buffer.alloc(512, 1)]);
/** ZIP local-file header — an .apk IS a zip (with AndroidManifest.xml inside). */
const fakeApk = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....AndroidManifest.xml classes.dex'), Buffer.alloc(256)]);
const fakeZip = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....readme.txt'), Buffer.alloc(256)]);
/** Starts with a JPEG signature but is not a decodable image. */
const jpegHeaderGarbage = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);
const dataUrl = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString('base64')}`;

/** A valid PNG carrying a C2PA-style chunk whose payload embeds an SVG icon — the shape
 *  ChatGPT/Gemini exports have, which used to be misread as an SVG and refused. */
async function pngWithC2paSvgIcon(): Promise<Buffer> {
  const base = await solid(64, 48).png().toBuffer();
  const payload = Buffer.from('Comment\0\0\0\0\0c2pa.icon\0image/svg+xml\0<svg width="716" height="716"></svg>', 'latin1');
  const type = Buffer.from('iTXt');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, payload])) >>> 0);
  const afterIhdr = 8 + 4 + 4 + 13 + 4; // signature + IHDR chunk
  return Buffer.concat([base.subarray(0, afterIhdr), length, type, payload, crc, base.subarray(afterIhdr)]);
}

// ─── In-memory stand-in for Prisma ─────────────────────────────────────────────
function makePrisma() {
  const media = new Map<string, any>();
  const audit: any[] = [];
  const matches = (m: any, where: any = {}): boolean => Object.entries(where).every(([k, cond]: [string, any]) => {
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('hasSome' in cond) return (m[k] || []).some((u: string) => cond.hasSome.includes(u));
      if ('notIn' in cond) return !cond.notIn.includes(m[k]);
      if ('not' in cond) return m[k] !== cond.not;
      if ('lt' in cond) return m[k] < cond.lt;
      return true;
    }
    return m[k] === cond;
  });
  const prisma: any = {
    media: {
      create: jest.fn(async ({ data }) => { const row = { isPrimary: false, sortOrder: 0, cloudinaryPublicId: null, deliveryUrl: null, variants: null, variantUrls: [], createdAt: new Date(), updatedAt: new Date(), deletedAt: null, ...data }; media.set(row.id, row); return { ...row }; }),
      update: jest.fn(async ({ where, data }) => { const row = media.get(where.id); if (!row) throw new Error('not found'); Object.assign(row, data); return { ...row }; }),
      updateMany: jest.fn(async ({ where, data }) => { let count = 0; for (const r of media.values()) if (matches(r, where)) { Object.assign(r, data); count++; } return { count }; }),
      findMany: jest.fn(async ({ where } = {}) => [...media.values()].filter((r) => matches(r, where)).map((r) => ({ ...r }))),
      findUnique: jest.fn(async ({ where }) => (media.has(where.id) ? { ...media.get(where.id) } : null)),
      delete: jest.fn(async ({ where }) => { const row = media.get(where.id); media.delete(where.id); return row; }),
      count: jest.fn(async ({ where } = {}) => [...media.values()].filter((r) => matches(r, where)).length),
    },
    auditLog: { create: jest.fn(async ({ data }) => { audit.push(data); return data; }) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, media, audit };
}

const config = (vals: Record<string, string> = {}) => ({ get: (k: string, d?: any) => (k in vals ? vals[k] : d) }) as any;

/** Cloudinary answers with a URL derived from the public_id it was given, like the real API. */
function cloudinaryOk() {
  uploadStream.mockImplementation((options: any, cb: any) => ({
    end: (body: Buffer) => {
      (cloudinaryOk as any).last = { options, body };
      const base = `https://res.cloudinary.com/test-cloud/image/upload`;
      cb(null, {
        public_id: options.public_id,
        secure_url: `${base}/v1/${options.public_id}.webp`,
        eager: [200, 600, 1200].map((w) => ({ secure_url: `${base}/w_${w},c_limit,f_auto,q_auto/v1/${options.public_id}.webp` })),
      });
    },
  }));
}

function setup() {
  const { prisma, media, audit } = makePrisma();
  const svc = new MediaService(prisma);
  return { svc, prisma, media, audit };
}

const ingest = (svc: MediaService, buffer: Buffer, extra: Partial<Parameters<MediaService['ingestImage']>[0]> = {}) =>
  svc.ingestImage({ buffer, declaredMimeType: 'image/jpeg', originalName: 'photo.jpg', entityType: MediaEntityType.PRODUCT, actor: SELLER, ...extra });

/** Every READY row must be a Cloudinary reference only — never image bytes or base64. */
function expectCloudinaryReference(row: any) {
  expect(row.status).toBe(MediaStatus.READY);
  expect(row.storageProvider).toBe('CLOUDINARY');
  expect(row.cloudinaryPublicId).toBe(row.storageKey);
  expect(row.deliveryUrl).toMatch(CLOUDINARY_URL);
  for (const u of row.variantUrls) expect(u).toMatch(CLOUDINARY_URL);
  expect(JSON.stringify(row)).not.toMatch(/data:image|base64/);
}

// No image byte may ever be written to the local (ephemeral Railway) filesystem. Counted
// across the whole file (jest.clearAllMocks in beforeEach would otherwise reset the calls).
let fsWriteCalls = 0;
const fsWriters = () => [fs.writeFileSync, fs.writeFile, fs.promises.writeFile, fs.createWriteStream] as unknown as jest.Mock[];
afterEach(() => { fsWriteCalls += fsWriters().reduce((n, f) => n + f.mock.calls.length, 0); });
afterAll(() => { expect(fsWriteCalls).toBe(0); });

beforeEach(() => {
  jest.clearAllMocks();
  __resetClamscanClientForTests();
  mockScanStream.mockResolvedValue({ isInfected: false, viruses: [] });
  cloudinaryOk();
});

// ═══ A–C: valid images are accepted ═════════════════════════════════════════
describe('valid images → accepted, stored in Cloudinary as a sanitized WebP', () => {
  it.each([
    ['A. JPEG', jpeg, 'image/jpeg', 'jpeg'],
    ['B. PNG', png, 'image/png', 'png'],
    ['C. WebP', webp, 'image/webp', 'webp'],
  ])('%s', async (_label, make, mime, format) => {
    const { svc, media } = setup();
    const result = await ingest(svc, await make(), { declaredMimeType: mime, originalName: `upload.${format}` });

    expect(result.mimeType).toBe('image/webp');
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
    const row = media.get(result.id);
    expectCloudinaryReference(row);
    expect(row.originalFormat).toBe(format);
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  // REGRESSION (production): admins could not upload ChatGPT/Gemini PNGs — their C2PA
  // "content credentials" metadata embeds an image/svg+xml icon, which the signature scan
  // mistook for an actual SVG, so a valid PNG was refused with "Only JPEG, PNG, WebP or GIF
  // images are allowed." The whole pipeline must accept it and store the usual WebP.
  it('accepts a PNG whose C2PA metadata embeds an SVG icon, and stores it as optimized WebP', async () => {
    const png = await pngWithC2paSvgIcon();
    expect(png.subarray(0, 512).toString('utf8')).toContain('<svg'); // the real-world shape
    const { svc } = setup();

    const result = await svc.ingestImage({
      buffer: png, declaredMimeType: 'image/png', originalName: 'ChatGPT Image.png',
      entityType: MediaEntityType.CATEGORY, actor: ADMIN,
    });

    expect(result.status).toBe(MediaStatus.READY);
    expect(result.mimeType).toBe('image/webp');
    const stored = (cloudinaryOk as any).last.body;
    expect((await sharp(stored).metadata()).format).toBe('webp');
    // The embedded SVG markup is gone from what actually gets stored and served.
    expect(stored.toString('latin1')).not.toContain('<svg');
  }, 30000);

  it('works with no R2 configuration at all — the service has no R2 dependency', async () => {
    const { svc } = setup();
    expect(MediaService.length).toBe(1); // constructor(prisma) — nothing else to configure
    await expect(ingest(svc, await jpeg())).resolves.toEqual(expect.objectContaining({ storageProvider: 'CLOUDINARY' }));
  });
});

// ═══ D–J: everything that must be rejected, and never stored ═════════════════
describe('rejections — nothing reaches Cloudinary or the Media table', () => {
  async function expectRejected(buffer: Buffer, extra: any, errorType: any) {
    const { svc, media, audit } = setup();
    await expect(ingest(svc, buffer, extra)).rejects.toBeInstanceOf(errorType);
    expect(uploadStream).not.toHaveBeenCalled();
    expect(media.size).toBe(0);
    return audit;
  }

  it('D. fake JPG containing a Windows executable → rejected from the bytes, not the name', async () => {
    const audit = await expectRejected(fakeExe(), { originalName: 'photo.jpg', declaredMimeType: 'image/jpeg' }, BadRequestException);
    expect(audit[0].action).toBe('MEDIA_REJECTED_INVALID_TYPE');
    expect(mockScanStream).not.toHaveBeenCalled();
  });

  it('E. APK renamed to .jpg → rejected', async () => {
    await expectRejected(fakeApk(), { originalName: 'holiday.jpg' }, BadRequestException);
  });

  it('F. ZIP renamed to .jpg → rejected', async () => {
    await expectRejected(fakeZip(), { originalName: 'scan.jpg' }, BadRequestException);
  });

  it('G. oversized file (> 20MB) → 413 before any decoding or scanning', async () => {
    const big = Buffer.concat([await jpeg(), Buffer.alloc(20 * MB)]);
    const audit = await expectRejected(big, {}, PayloadTooLargeException);
    expect(audit[0].action).toBe('MEDIA_REJECTED_OVERSIZED');
    expect(mockScanStream).not.toHaveBeenCalled();
  });

  it('H. malware detected by ClamAV (mocked signature — no live sample) → generic rejection, signature only in the audit log', async () => {
    mockScanStream.mockResolvedValue({ isInfected: true, viruses: ['Eicar-Test-Signature'] });
    const { svc, media, audit } = setup();
    const err = await ingest(svc, await jpeg()).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('File rejected by security validation.');
    expect(err.message).not.toContain('Eicar');
    expect(audit.find((a) => a.action === 'MEDIA_REJECTED_MALWARE')?.metadata.reason).toContain('Eicar');
    expect(uploadStream).not.toHaveBeenCalled();
    expect(media.size).toBe(0);
  });

  it('H2. scanner unreachable → fail-closed (503), nothing stored', async () => {
    mockScanStream.mockRejectedValue(new Error('ECONNREFUSED'));
    await expectRejected(await jpeg(), {}, ServiceUnavailableException);
  });

  it('I. declared MIME disagrees with the real signature (PNG bytes sent as image/jpeg) → rejected', async () => {
    const audit = await expectRejected(await png(), { declaredMimeType: 'image/jpeg' }, BadRequestException);
    expect(audit[0].action).toBe('MEDIA_REJECTED_MIME_MISMATCH');
  });

  it('I2. a JPEG signature over undecodable bytes → rejected', async () => {
    await expectRejected(jpegHeaderGarbage(), {}, BadRequestException);
  });

  it('I3. SVG (can carry script) → rejected', async () => {
    await expectRejected(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { declaredMimeType: 'image/svg+xml' }, BadRequestException);
  });

  it('J. extreme dimensions (13000px side) → rejected before scanning or processing', async () => {
    const wide = await solid(13_000, 10).png().toBuffer();
    const audit = await expectRejected(wide, { declaredMimeType: 'image/png' }, BadRequestException);
    expect(audit[0].action).toBe('MEDIA_REJECTED_DIMENSIONS');
    expect(mockScanStream).not.toHaveBeenCalled();
  }, 30000);

  it('J2. pixel count over the 25MP ceiling → rejected', async () => {
    const huge = await solid(6_000, 5_000).png({ compressionLevel: 9 }).toBuffer(); // 30MP of flat colour — tiny file, huge decode
    await expectRejected(huge, { declaredMimeType: 'image/png' }, BadRequestException);
  }, 60000);

  it('a role uploading media it does not own (customer → PRODUCT) → 403', async () => {
    await expectRejected(await jpeg(), { actor: CUSTOMER }, ForbiddenException);
  });

  it('a base64 data URL carrying an executable is rejected just the same', async () => {
    const { svc, media } = setup();
    await expect(svc.ingestDataUrl(dataUrl(fakeExe(), 'image/jpeg'), { entityType: MediaEntityType.PARTNER_PROFILE, actor: PARTNER })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.ingestDataUrl('not-a-data-url', { entityType: MediaEntityType.PARTNER_PROFILE, actor: PARTNER })).rejects.toBeInstanceOf(BadRequestException);
    expect(uploadStream).not.toHaveBeenCalled();
    expect(media.size).toBe(0);
  });
});

// ═══ K–L: Cloudinary storage ════════════════════════════════════════════════
describe('clean image → Cloudinary (single source of truth) → READY Media row', () => {
  it('uploads the optimized WebP (not the original) under a server-generated public_id in the right folder', async () => {
    const { svc, media, audit } = setup();
    const original = await jpeg();
    const result = await ingest(svc, original, { originalName: '../../etc/passwd.jpg' });

    const { options, body } = (cloudinaryOk as any).last;
    expect(uploadStream).toHaveBeenCalledTimes(1);
    expect(options.public_id).toMatch(new RegExp(`^remont/products/original/${UUID}$`));
    expect(options.overwrite).toBe(false);
    expect(options.transformation).toBeUndefined(); // already optimized by sharp — no second re-encode
    expect(options.eager).toHaveLength(3); // thumb / card / full are Cloudinary transformations, not extra uploads
    expect((await sharp(body).metadata()).format).toBe('webp');
    expect(body.equals(original)).toBe(false);

    const row = media.get(result.id);
    expectCloudinaryReference(row);
    expect(row.storageKey).toBe(options.public_id);
    expect(result.variants).toEqual({
      thumb: expect.stringContaining('/w_200,'), card: expect.stringContaining('/w_600,'), full: expect.stringContaining('/w_1200,'),
    });
    expect(row.variantUrls).toHaveLength(4);
    // The original filename is metadata only — path stripped, never part of the key.
    expect(row.originalName).toBe('passwd.jpg');
    expect(row.storageKey).not.toContain('passwd');
    expect(audit.map((a) => a.action)).toEqual(['MEDIA_UPLOAD_ACCEPTED']);
  });

  it.each([
    [MediaEntityType.SERVICE, 'remont/services/'],
    [MediaEntityType.BANNER, 'remont/banners/'],
    [MediaEntityType.MARKETING, 'remont/marketing/'],
    [MediaEntityType.PROJECT, 'remont/projects/'],
    [MediaEntityType.CATEGORY, 'remont/categories/'],
    [MediaEntityType.BLOG, 'remont/blogs/'],
    [MediaEntityType.GENERAL, 'remont/general/'],
  ])('%s images are filed under %s', async (entityType, prefix) => {
    const { svc } = setup();
    const r = await ingest(svc, await jpeg(), { actor: ADMIN, entityType });
    expect(r.storageKey.startsWith(prefix)).toBe(true);
  });

  it('an EXIF/GPS-tagged photo is stored without its metadata', async () => {
    const tagged = await solid(64, 48).jpeg().withExif({ IFD0: { Make: 'SecretCam', Model: 'X1' } }).toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();
    const { svc } = setup();
    await ingest(svc, tagged);
    expect((await sharp((cloudinaryOk as any).last.body).metadata()).exif).toBeUndefined();
  });

  it('Cloudinary upload failure → partial asset destroyed, no Media row, no fallback, generic 500', async () => {
    uploadStream.mockImplementation((options: any, cb: any) => ({ end: () => { (cloudinaryOk as any).last = { options }; cb(new Error('cloudinary timeout'), null); } }));
    const { svc, media, audit } = setup();
    await expect(ingest(svc, await jpeg())).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(destroy).toHaveBeenCalledWith((cloudinaryOk as any).last.options.public_id, expect.objectContaining({ invalidate: true }));
    expect(media.size).toBe(0);
    expect(audit.map((a) => a.action)).toContain('MEDIA_PROCESSING_FAILED');
  });

  it('DB failure after a successful Cloudinary upload → the uploaded asset is destroyed', async () => {
    const { svc, prisma, media } = setup();
    prisma.media.update.mockRejectedValueOnce(new Error('db down'));
    await expect(ingest(svc, await jpeg())).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(destroy).toHaveBeenCalledWith((cloudinaryOk as any).last.options.public_id, expect.anything());
    expect(media.size).toBe(0);
  });

  it('stale PROCESSING rows (crash mid-upload) are swept together with their Cloudinary asset', async () => {
    const { svc, media } = setup();
    media.set('00000000-0000-4000-8000-000000000001', {
      id: '00000000-0000-4000-8000-000000000001', status: MediaStatus.PROCESSING, storageProvider: 'CLOUDINARY',
      storageKey: 'remont/products/original/00000000-0000-4000-8000-000000000001', cloudinaryPublicId: null,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    expect(await svc.sweepStaleUploads()).toBe(1);
    expect(destroy).toHaveBeenCalledWith('remont/products/original/00000000-0000-4000-8000-000000000001', expect.anything());
    expect(media.size).toBe(0);
  });
});

// ═══ Flow 1: seller product upload ══════════════════════════════════════════
function productsPrisma(mediaPrisma: any, existing?: any) {
  return Object.assign(mediaPrisma, {
    productVendor: { findUnique: jest.fn(async () => ({ id: 'vendor-1', status: 'ACTIVE' })) },
    product: {
      create: jest.fn(async ({ data }) => ({ id: 'product-1', ...data })),
      findUnique: jest.fn(async () => existing),
      update: jest.fn(async ({ data }) => ({ ...existing, ...data })),
    },
  });
}

describe('1. seller product image → MediaService → Cloudinary → Media record → product', () => {
  it('the uploaded image is linked to the new product and the product stores the Cloudinary URL', async () => {
    const { svc, prisma, media } = setup();
    const up = await ingest(svc, await jpeg());
    const products = new ProductsService(productsPrisma(prisma), svc);
    (products as any).runAiEnhancement = jest.fn(async () => undefined);

    const product = await products.create(SELLER.id, { name: 'Fan', price: 100, images: [up.variants!.full] });

    expect(product.images[0]).toMatch(CLOUDINARY_URL);
    const row = media.get(up.id);
    expectCloudinaryReference(row);
    expect(row).toEqual(expect.objectContaining({ entityType: MediaEntityType.PRODUCT, entityId: 'product-1', isPrimary: true, sortOrder: 0 }));
  });

  it('a seller cannot attach another seller\'s media by pasting its URL', async () => {
    const { svc, prisma, media } = setup();
    const theirs = await ingest(svc, await jpeg(), { actor: OTHER_SELLER });
    const products = new ProductsService(productsPrisma(prisma), svc);
    (products as any).runAiEnhancement = jest.fn(async () => undefined);

    await products.create(SELLER.id, { name: 'Fan', price: 100, images: [theirs.deliveryUrl] });
    expect(media.get(theirs.id).entityId).toBeNull();
  });

  it('a NEW base64 image is refused; a legacy base64 image already on the product still works', async () => {
    const { svc, prisma } = setup();
    const legacy = 'data:image/jpeg;base64,AAAA';
    const products = new ProductsService(productsPrisma(prisma, { id: 'product-1', vendorId: 'vendor-1', images: [legacy] }), svc);
    (products as any).runAiEnhancement = jest.fn(async () => undefined);

    await expect(products.create(SELLER.id, { name: 'Fan', price: 1, images: ['data:image/png;base64,BBBB'] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(products.update(SELLER.id, 'product-1', { images: [legacy, 'https://res.cloudinary.com/x.webp'] })).resolves.toBeDefined();
    await expect(products.update(SELLER.id, 'product-1', { images: [legacy, 'data:image/png;base64,CCCC'] })).rejects.toBeInstanceOf(BadRequestException);
    // Untouched legacy products: an update that doesn't send images never trips the guard.
    await expect(products.update(SELLER.id, 'product-1', { price: 5 })).resolves.toBeDefined();
  });

  it('removing an image from the product detaches (does not delete) its Media row', async () => {
    const { svc, prisma, media } = setup();
    const a = await ingest(svc, await jpeg());
    const b = await ingest(svc, await jpeg());
    const existing = { id: 'product-1', vendorId: 'vendor-1', images: [a.deliveryUrl, b.deliveryUrl] };
    const products = new ProductsService(productsPrisma(prisma, existing), svc);
    await products.update(SELLER.id, 'product-1', { images: [a.deliveryUrl, b.deliveryUrl] });
    expect(media.get(b.id).entityId).toBe('product-1');

    await products.update(SELLER.id, 'product-1', { images: [a.deliveryUrl] });
    expect(media.get(a.id).entityId).toBe('product-1');
    expect(media.get(b.id).entityId).toBeNull();
    expect(media.get(b.id).status).toBe(MediaStatus.READY);
  });
});

// ═══ Flows 2, 4–8: admin uploads ════════════════════════════════════════════
function admin(prisma: any, media: MediaService) {
  // AdminService's 13 existing collaborators are not touched by these methods.
  const none = undefined as any;
  return new AdminService(prisma, config(), none, none, none, none, none, none, none, none, none, none, none, media);
}

describe('admin uploads → MediaService → Cloudinary → Media record → record', () => {
  it('2. admin product image', async () => {
    const { svc, prisma, media } = setup();
    const up = await ingest(svc, await jpeg(), { actor: ADMIN, entityType: MediaEntityType.PRODUCT });
    prisma.product = { create: jest.fn(async ({ data }) => ({ id: 'product-7', ...data })) };
    const product = await admin(prisma, svc).adminCreateProduct({ name: 'Heater', price: 10, images: [up.variants!.full] });
    expect(product.images[0]).toMatch(CLOUDINARY_URL);
    expect(media.get(up.id)).toEqual(expect.objectContaining({ entityType: 'PRODUCT', entityId: 'product-7', isPrimary: true }));
    expect(up.storageKey).toMatch(/^remont\/products\/original\//);
  });

  it('4. service image + gallery (e.g. AC service)', async () => {
    const { svc, prisma, media } = setup();
    const cover = await ingest(svc, await jpeg(), { actor: ADMIN, entityType: MediaEntityType.SERVICE });
    const gallery = await ingest(svc, await png(), { actor: ADMIN, entityType: MediaEntityType.SERVICE, declaredMimeType: 'image/png' });
    prisma.service = {
      findUnique: jest.fn(async () => ({ id: 'svc-ac', imageUrl: null, images: [] })),
      update: jest.fn(async ({ data }) => ({ id: 'svc-ac', imageUrl: data.imageUrl, images: data.images })),
    };
    const saved = await admin(prisma, svc).updateService('svc-ac', { imageUrl: cover.variants!.full, images: [gallery.variants!.full] });
    expect(saved.imageUrl).toMatch(CLOUDINARY_URL);
    expect(media.get(cover.id)).toEqual(expect.objectContaining({ entityType: 'SERVICE', entityId: 'svc-ac', isPrimary: true }));
    expect(media.get(gallery.id)).toEqual(expect.objectContaining({ entityType: 'SERVICE', entityId: 'svc-ac', sortOrder: 1 }));
  });

  it('4b. service category + subcategory images', async () => {
    const { svc, prisma, media } = setup();
    const logo = await ingest(svc, await jpeg(), { actor: ADMIN, entityType: MediaEntityType.CATEGORY });
    const sub = await ingest(svc, await jpeg(), { actor: ADMIN, entityType: MediaEntityType.SUBCATEGORY });
    prisma.serviceCategory = { create: jest.fn(async ({ data }) => ({ id: 'cat-1', ...data })) };
    prisma.subCategory = { create: jest.fn(async ({ data }) => ({ id: 'sub-1', ...data })) };
    const a = admin(prisma, svc);
    await a.createCategory({ key: 'ac', name: 'AC', icon: '❄', logoUrl: logo.variants!.full });
    await a.createSubCategory({ name: 'AC Repair', categoryId: 'cat-1', imageUrl: sub.variants!.full });
    expect(media.get(logo.id)).toEqual(expect.objectContaining({ entityType: 'CATEGORY', entityId: 'cat-1' }));
    expect(media.get(sub.id)).toEqual(expect.objectContaining({ entityType: 'SUBCATEGORY', entityId: 'sub-1' }));
  });

  it('5. marketing creative (seasonal ad)', async () => {
    const { svc, prisma, media } = setup();
    const creative = await ingest(svc, await jpeg(), { actor: ADMIN, entityType: MediaEntityType.MARKETING });
    prisma.seasonalAd = { create: jest.fn(async ({ data }) => ({ id: 'ad-1', ...data })) };
    const ad = await admin(prisma, svc).createAd({ title: 'Summer', imageUrl: creative.variants!.full });
    expect(ad.imageUrl).toMatch(CLOUDINARY_URL);
    expect(media.get(creative.id)).toEqual(expect.objectContaining({ entityType: 'MARKETING', entityId: 'ad-1' }));
  });

  it('6. website banner', async () => {
    const { svc, prisma, media } = setup();
    const banner = await ingest(svc, await jpeg(), { actor: ADMIN, entityType: MediaEntityType.BANNER });
    prisma.homeBanner = { create: jest.fn(async ({ data }) => ({ id: 'banner-1', ...data })) };
    const saved = await admin(prisma, svc).createBanner({ title: 'Hero', imageUrl: banner.variants!.full });
    expect(saved.imageUrl).toMatch(CLOUDINARY_URL);
    expect(media.get(banner.id)).toEqual(expect.objectContaining({ entityType: 'BANNER', entityId: 'banner-1' }));
  });

  it('7. blog image', async () => {
    const { svc, prisma, media } = setup();
    const img = await ingest(svc, await jpeg(), { actor: ADMIN, entityType: MediaEntityType.BLOG });
    prisma.blogPost = { create: jest.fn(async ({ data }) => ({ id: 'blog-1', ...data })) };
    const post = await admin(prisma, svc).createBlog({ title: 'Tips', content: 'x', imageUrl: img.variants!.full });
    expect(post.imageUrl).toMatch(CLOUDINARY_URL);
    expect(media.get(img.id)).toEqual(expect.objectContaining({ entityType: 'BLOG', entityId: 'blog-1' }));
  });

  it('admin GENERAL uploads (legacy callers that named no type) are re-filed to the record type on link', async () => {
    const { svc, prisma, media } = setup();
    const up = await ingest(svc, await jpeg(), { actor: ADMIN, entityType: MediaEntityType.GENERAL });
    prisma.blogPost = { create: jest.fn(async ({ data }) => ({ id: 'blog-1', ...data })) };
    await admin(prisma, svc).createBlog({ title: 'Tips', content: 'x', imageUrl: up.variants!.full });
    expect(media.get(up.id)).toEqual(expect.objectContaining({ entityType: 'BLOG', entityId: 'blog-1' }));
  });

  it('a new base64 banner is refused', async () => {
    const { svc, prisma } = setup();
    prisma.homeBanner = { create: jest.fn() };
    await expect(admin(prisma, svc).createBanner({ title: 'x', imageUrl: 'data:image/png;base64,AAAA' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.homeBanner.create).not.toHaveBeenCalled();
  });
});

// ═══ Flow 3: AI-generated images ════════════════════════════════════════════
describe('3. AI-generated product image → same pipeline → Cloudinary (products/generated) → Media record', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('runs OpenAI output through ingestImage and returns Cloudinary URLs + media ids', async () => {
    const b64 = (await png()).toString('base64');
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: [{ b64_json: b64 }, { b64_json: b64 }] }) })) as any;
    const { svc: media, media: rows } = setup();
    const ai = new AiEnrichmentService({} as any, config({ OPENAI_API_KEY: 'sk-test' }), {} as any, media);

    const out = await (ai as any).runImageGeneration(SELLER.id, 'Ceiling Fan', 'Fans', 'Acme');

    expect(out.images).toHaveLength(2);
    expect(uploadStream).toHaveBeenCalledTimes(2);
    for (const [i, id] of out.mediaIds.entries()) {
      const row = rows.get(id);
      expectCloudinaryReference(row);
      expect(row.storageKey).toMatch(new RegExp(`^remont/products/generated/${UUID}$`));
      expect(row.source).toBe(MediaSource.AI_GENERATED);
      expect(row.entityType).toBe(MediaEntityType.PRODUCT);
      expect(row.uploadedBy).toBe(SELLER.id);
      expect(row.entityId).toBeNull(); // linked on product save, never from a client productId
      expect(out.images[i]).toBe(row.variants.full); // 1200px — same size as a seller upload
    }
  });

  it('the seller then saves the product with an AI image → linked to that product', async () => {
    const b64 = (await png()).toString('base64');
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: [{ b64_json: b64 }] }) })) as any;
    const { svc, prisma, media } = setup();
    const out = await (new AiEnrichmentService({} as any, config({ OPENAI_API_KEY: 'sk-test' }), {} as any, svc) as any).runImageGeneration(SELLER.id, 'Fan');
    const products = new ProductsService(productsPrisma(prisma), svc);
    (products as any).runAiEnhancement = jest.fn(async () => undefined);

    await products.create(SELLER.id, { name: 'Fan', price: 100, images: out.images });
    expect(media.get(out.mediaIds[0])).toEqual(expect.objectContaining({ entityId: 'product-1', isPrimary: true }));
  });

  it('if one generated image fails the pipeline, the already-stored one is removed (the feature is refunded)', async () => {
    const b64ok = (await png()).toString('base64');
    const b64bad = fakeExe().toString('base64');
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: [{ b64_json: b64ok }, { b64_json: b64bad }] }) })) as any;
    const { svc: media, media: rows } = setup();
    const ai = new AiEnrichmentService({} as any, config({ OPENAI_API_KEY: 'sk-test' }), {} as any, media);

    await expect((ai as any).runImageGeneration(SELLER.id, 'Fan')).rejects.toBeInstanceOf(BadRequestException);
    expect([...rows.values()].every((r) => r.status === MediaStatus.DELETED)).toBe(true);
    expect(destroy).toHaveBeenCalled();
  });
});

// ═══ Flow 8: partner project / before-after photos + profile photo ══════════
describe('8. partner uploads (existing base64 API contract) → MediaService → Cloudinary; only the URL is stored', () => {
  it('job completion photos become Cloudinary URLs under remont/projects/, never base64 on the order', async () => {
    const { svc, media } = setup();
    const orders = new (OrdersService as any)(...Array(11).fill(undefined), svc) as OrdersService;
    const inline = dataUrl(await jpeg(), 'image/jpeg');
    const existingUrl = 'https://res.cloudinary.com/test-cloud/image/upload/v1/remont/projects/old.webp';

    const out = await (orders as any).storeCompletionPhotos([inline, existingUrl], PARTNER);

    expect(out.urls).toHaveLength(2);
    expect(out.urls[0]).toMatch(CLOUDINARY_URL);
    expect(out.urls[1]).toBe(existingUrl); // already-hosted URLs pass through unchanged
    expect(out.urls.join()).not.toContain('base64');
    const row = media.get(out.ingested[0].id);
    expectCloudinaryReference(row);
    expect(row.storageKey).toMatch(/^remont\/projects\//);
    expect(row.entityType).toBe(MediaEntityType.PROJECT);
  });

  it('an infected completion photo fails the completion and leaves nothing stored', async () => {
    const { svc, media } = setup();
    const orders = new (OrdersService as any)(...Array(11).fill(undefined), svc) as OrdersService;
    const good = dataUrl(await jpeg(), 'image/jpeg');
    mockScanStream
      .mockResolvedValueOnce({ isInfected: false, viruses: [] })
      .mockResolvedValueOnce({ isInfected: true, viruses: ['Eicar-Test-Signature'] });

    await expect((orders as any).storeCompletionPhotos([good, good], PARTNER)).rejects.toBeInstanceOf(BadRequestException);
    expect([...media.values()].every((r) => r.status === MediaStatus.DELETED)).toBe(true);
  });

  it('partner profile photo is stored as a Cloudinary URL (not the base64 that was sent)', async () => {
    const { svc, prisma, media } = setup();
    prisma.serviceVendor = {
      findUnique: jest.fn(async () => ({ id: 'vendor-9', userId: PARTNER.id })),
      update: jest.fn(async ({ data }) => ({ id: 'vendor-9', ...data })),
    };
    const vendors = new ServiceVendorsService(prisma, undefined as any, undefined as any, undefined as any, svc);

    const updated = await vendors.updatePhoto(PARTNER.id, dataUrl(await jpeg(), 'image/jpeg'));

    expect(updated.photoUrl).toMatch(CLOUDINARY_URL);
    expect(updated.photoUrl).not.toContain('base64');
    const row = [...media.values()][0];
    expectCloudinaryReference(row);
    expect(row).toEqual(expect.objectContaining({ entityType: 'PARTNER_PROFILE', entityId: 'vendor-9', isPrimary: true }));
  });
});

// ═══ Media Library operations ═══════════════════════════════════════════════
describe('Media Library — access control, delete, primary', () => {
  it('owners and admins can read media; other users get 404', async () => {
    const { svc } = setup();
    const up = await ingest(svc, await jpeg());
    await expect(svc.get(up.id, SELLER)).resolves.toBeDefined();
    await expect(svc.get(up.id, ADMIN)).resolves.toBeDefined();
    await expect(svc.get(up.id, OTHER_SELLER)).rejects.toThrow('Media not found');
  });

  it('delete is refused while attached; once detached it soft-deletes and destroys the Cloudinary asset', async () => {
    const { svc, media, audit } = setup();
    const up = await ingest(svc, await jpeg());
    media.get(up.id).entityId = 'product-1';
    await expect(svc.remove(up.id, SELLER)).rejects.toBeInstanceOf(ConflictException);

    media.get(up.id).entityId = null;
    const deleted = await svc.remove(up.id, SELLER);
    expect(deleted.status).toBe(MediaStatus.DELETED);
    expect(destroy).toHaveBeenCalledWith(up.cloudinaryPublicId, expect.anything());
    expect(audit.map((a) => a.action)).toContain('MEDIA_DELETED');
  });

  it('only admins may move media between records', async () => {
    const { svc } = setup();
    const up = await ingest(svc, await jpeg());
    await expect(svc.update(up.id, SELLER, { entityId: 'someone-elses-product' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.update(up.id, ADMIN, { entityId: 'product-9', isPrimary: true })).resolves.toEqual(expect.objectContaining({ entityId: 'product-9', isPrimary: true }));
  });
});

// ═══ Policy (pure) ══════════════════════════════════════════════════════════
describe('media policy', () => {
  it('Cloudinary public_ids are server-generated and cannot be steered by input', () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    expect(buildStorageKey(MediaEntityType.BANNER, id)).toBe(`remont/banners/${id}`);
    expect(buildStorageKey(MediaEntityType.PRODUCT, id)).toBe(`remont/products/original/${id}`);
    expect(buildStorageKey(MediaEntityType.PRODUCT, id, MediaSource.AI_GENERATED)).toBe(`remont/products/generated/${id}`);
    expect(() => buildStorageKey(MediaEntityType.BANNER, '../../etc/passwd')).toThrow();
  });

  it('entity types are an allowlist; unknown values are a 400, never coerced', () => {
    expect(parseEntityType('product')).toBe('PRODUCT');
    expect(parseEntityType(undefined)).toBeUndefined();
    expect(() => parseEntityType('../products')).toThrow(BadRequestException);
  });

  it('role allowlist', () => {
    expect(canUploadEntityType(UserRole.PRODUCT_VENDOR, MediaEntityType.PRODUCT)).toBe(true);
    expect(canUploadEntityType(UserRole.PRODUCT_VENDOR, MediaEntityType.BANNER)).toBe(false);
    expect(canUploadEntityType(UserRole.SERVICE_VENDOR, MediaEntityType.PROJECT)).toBe(true);
    expect(canUploadEntityType(UserRole.CUSTOMER, MediaEntityType.CUSTOMER_UPLOAD)).toBe(true);
    expect(canUploadEntityType(UserRole.ADMIN, MediaEntityType.MARKETING)).toBe(true);
  });

  it('original names are sanitized metadata', () => {
    expect(sanitizeOriginalName('C:\\Users\\me\\..\\evil<script>.jpg')).toBe('evilscript.jpg');
    expect(sanitizeOriginalName(undefined)).toBeNull();
  });

  it('inline-image guard', () => {
    expect(() => assertNoNewInlineImages(['https://x/y.webp'])).not.toThrow();
    expect(() => assertNoNewInlineImages('data:image/png;base64,AA')).toThrow(BadRequestException);
    expect(() => assertNoNewInlineImages(['data:image/png;base64,AA'], ['data:image/png;base64,AA'])).not.toThrow();
  });
});
