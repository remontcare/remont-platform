import { BadRequestException } from '@nestjs/common';

// jest.mock calls are hoisted above imports, so this applies before uploads.module.ts
// (which calls cloudinary.config() at module-load time) is ever loaded.
jest.mock('cloudinary', () => ({
  v2: {
    // Read (no-arg) and write (object-arg) both go through this one mock — always
    // reporting "configured", regardless of which env vars are actually set in this
    // process, so assertCloudinaryConfigured() never blocks these tests.
    config: jest.fn(() => ({ cloud_name: 'test-cloud', api_key: 'test-key', api_secret: 'test-secret' })),
    uploader: { upload_stream: jest.fn() },
  },
}));

import { v2 as cloudinaryMock } from 'cloudinary';
import { randomFillSync } from 'crypto';
import sharp from 'sharp';

sharp.concurrency(1);
import { uploadBuffer, UploadsService, optimizeImage, IMAGE_MAX_DIMENSION } from './uploads.module';

/**
 * Requirement 1 — automatic web-optimized delivery. Covers the rebuilt Cloudinary upload
 * pipeline: the stored master is capped via the main upload `transformation` (not a
 * delivery-time query-string resize), the three named variants are pre-generated via
 * `eager` at upload time (f_auto,q_auto), and the API response shape is unchanged
 * (thumb/card/full/url/publicId) — only how those URLs are produced changed.
 */
function mockUploadStream(fakeResult: any, err: any = null) {
  (cloudinaryMock.uploader.upload_stream as jest.Mock).mockImplementation((options: any, callback: any) => {
    (mockUploadStream as any).lastOptions = options;
    return { end: () => callback(err, err ? null : fakeResult) };
  });
}

/** A real (tiny) JPEG — processAndStore now actually decodes its input, so a placeholder
 *  string buffer would be rejected as undecodable rather than exercising the pipeline. */
async function tinyJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 90, g: 140, b: 200 } } })
    .jpeg()
    .toBuffer();
}

describe('uploadBuffer — Cloudinary options built per resource type', () => {
  beforeEach(() => jest.clearAllMocks());

  it('raw (not pre-optimized) images: still capped at 2000px on the way in, plus eager f_auto q_auto variants', async () => {
    mockUploadStream({ secure_url: 'https://res.cloudinary.com/x/image/upload/master.jpg', public_id: 'remont/abc', eager: [] });
    await uploadBuffer(Buffer.from('fake'), 'image');

    const options = (mockUploadStream as any).lastOptions;
    expect(options.transformation).toEqual([{ width: 2000, height: 2000, crop: 'limit' }]);
    expect(options.eager).toEqual([
      { width: 200, crop: 'limit', fetch_format: 'auto', quality: 'auto' },
      { width: 600, crop: 'limit', fetch_format: 'auto', quality: 'auto' },
      { width: 1200, crop: 'limit', fetch_format: 'auto', quality: 'auto' },
    ]);
    expect(options.eager_async).toBe(false);
  });

  it('pre-optimized images: NO incoming transformation, so Cloudinary never re-encodes what sharp already produced', async () => {
    mockUploadStream({ secure_url: 'https://res.cloudinary.com/x/image/upload/master.webp', public_id: 'remont/abc', eager: [] });
    await uploadBuffer(Buffer.from('fake'), 'image', true);

    const options = (mockUploadStream as any).lastOptions;
    expect(options.transformation).toBeUndefined();
    expect(options.eager).toHaveLength(3); // delivery variants still pre-generated
  });

  it('video: applies quality:auto as the main (stored) transformation, no eager array', async () => {
    mockUploadStream({ secure_url: 'https://res.cloudinary.com/x/video/upload/clip.mp4', public_id: 'remont/vid1' });
    await uploadBuffer(Buffer.from('fake'), 'video');

    const options = (mockUploadStream as any).lastOptions;
    expect(options.transformation).toEqual([{ quality: 'auto' }]);
    expect(options.eager).toBeUndefined();
  });
});

describe('UploadsService.processAndStore — response shape preserved, URLs now come from eager', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns thumb/card/full from the eager array and url as the capped master — same field names as before', async () => {
    mockUploadStream({
      secure_url: 'https://res.cloudinary.com/x/image/upload/v1/remont/master.jpg',
      public_id: 'remont/master',
      eager: [
        { secure_url: 'https://res.cloudinary.com/x/image/upload/w_200/remont/master.jpg' },
        { secure_url: 'https://res.cloudinary.com/x/image/upload/w_600/remont/master.jpg' },
        { secure_url: 'https://res.cloudinary.com/x/image/upload/w_1200/remont/master.jpg' },
      ],
    });
    const svc = new UploadsService();
    const result = await svc.processAndStore({ mimetype: 'image/jpeg', buffer: await tinyJpeg() } as any);

    expect(result).toEqual({
      thumb: 'https://res.cloudinary.com/x/image/upload/w_200/remont/master.jpg',
      card: 'https://res.cloudinary.com/x/image/upload/w_600/remont/master.jpg',
      full: 'https://res.cloudinary.com/x/image/upload/w_1200/remont/master.jpg',
      url: 'https://res.cloudinary.com/x/image/upload/v1/remont/master.jpg',
      publicId: 'remont/master',
    });
  });

  it('falls back to f_auto,q_auto delivery-time resizing (not the old f_webp,q_auto:good) if eager ever comes back short', async () => {
    mockUploadStream({
      secure_url: 'https://res.cloudinary.com/x/image/upload/v1/remont/master.jpg',
      public_id: 'remont/master',
      eager: [], // simulate Cloudinary not returning eager results
    });
    const svc = new UploadsService();
    const result = await svc.processAndStore({ mimetype: 'image/jpeg', buffer: await tinyJpeg() } as any);

    expect(result.thumb).toBe('https://res.cloudinary.com/x/image/upload/w_200,c_limit,f_auto,q_auto/v1/remont/master.jpg');
    expect(result.full).toBe('https://res.cloudinary.com/x/image/upload/w_1200,c_limit,f_auto,q_auto/v1/remont/master.jpg');
  });

  it('rejects a non-image mimetype before ever calling Cloudinary', async () => {
    const svc = new UploadsService();
    await expect(svc.processAndStore({ mimetype: 'video/mp4', buffer: Buffer.from('x') } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(cloudinaryMock.uploader.upload_stream).not.toHaveBeenCalled();
  });

  it('storeVideo still returns the unchanged {url, publicId} shape', async () => {
    mockUploadStream({ secure_url: 'https://res.cloudinary.com/x/video/upload/v1/remont/clip.mp4', public_id: 'remont/clip' });
    const svc = new UploadsService();
    const result = await svc.storeVideo({ mimetype: 'video/mp4', buffer: Buffer.from('x') } as any);
    expect(result).toEqual({ url: 'https://res.cloudinary.com/x/video/upload/v1/remont/clip.mp4', publicId: 'remont/clip' });
  });
});


/**
 * IMAGE OPTIMIZATION PIPELINE — the stored asset must be the optimized WebP, never the
 * original upload. These tests run the REAL sharp pipeline (only Cloudinary is mocked), so
 * the byte counts below are genuine measurements, not fixtures.
 */
describe('optimizeImage — server-side optimization before anything reaches Cloudinary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('a ~20MP multi-MB JPEG is downscaled to the 2000px cap and re-encoded far smaller as WebP', async () => {
    const width = 5000, height = 4000; // 20MP, under the 25MP policy cap
    const noise = Buffer.alloc(width * height * 3);
    randomFillSync(noise); // native fill — same incompressible noise, ~20x faster than a per-byte JS loop
    const original = await sharp(noise, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();

    const out = await optimizeImage(original);
    expect(out).not.toBeNull();
    expect(out!.format).toBe('webp');
    expect(Math.max(out!.width, out!.height)).toBe(IMAGE_MAX_DIMENSION); // downscaled to the cap
    expect(out!.width / out!.height).toBeCloseTo(width / height, 2);     // aspect ratio preserved
    expect(out!.optimizedBytes).toBeLessThan(out!.originalBytes);
    // eslint-disable-next-line no-console
    console.log(`    [20MP JPEG] ${(out!.originalBytes / 1048576).toFixed(2)}MB -> ${(out!.optimizedBytes / 1048576).toFixed(2)}MB WebP ${out!.width}x${out!.height}`);
  }, 120000); // ~2s on an idle machine; the headroom is for a fully parallel suite run

  it('a small image is re-encoded but never upscaled', async () => {
    const original = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 10, g: 90, b: 60 } } }).jpeg().toBuffer();
    const out = await optimizeImage(original);
    expect(out!.width).toBe(320);
    expect(out!.height).toBe(240);
    expect(out!.format).toBe('webp');
  }, 20000);

  it('PNG transparency survives the conversion to WebP', async () => {
    const original = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();

    const out = await optimizeImage(original);
    expect(out!.format).toBe('webp');
    const meta = await sharp(out!.buffer).metadata();
    expect(meta.hasAlpha).toBe(true); // not flattened onto a black/white matte
    // The fully-transparent corner pixel must still be transparent.
    const raw = await sharp(out!.buffer).ensureAlpha().raw().toBuffer();
    expect(raw[3]).toBe(0);
  }, 20000);

  it('strips EXIF metadata (e.g. GPS) from the stored asset', async () => {
    const withExif = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .withMetadata({ exif: { IFD0: { Copyright: 'test', Software: 'test' } } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined(); // fixture really has EXIF

    const out = await optimizeImage(withExif);
    expect((await sharp(out!.buffer).metadata()).exif).toBeUndefined();
  }, 20000);

  it('refuses to decode a declared-enormous image (decompression-bomb guard)', async () => {
    // 12000x12000 = 144MP, far above MAX_DECODE_PIXELS.
    const bomb = await sharp({ create: { width: 12000, height: 12000, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(optimizeImage(bomb)).rejects.toThrow(BadRequestException);
  }, 120000);

  it('REJECTS an animated GIF rather than flattening it to a single frame', async () => {
    // A genuinely animated GIF. sharp builds one from a single TALL raw image plus
    // `pageHeight` INSIDE the raw options — that is what tells libvips where one frame
    // ends and the next begins. (`pageHeight`/`animated` at the top level of the
    // constructor options is silently ignored and yields a 1-page GIF.)
    const W = 20, frameH = 20, frameCount = 3;
    const stacked = Buffer.alloc(W * frameH * frameCount * 3);
    for (let f = 0; f < frameCount; f++) {
      stacked.fill(0x30 + f * 0x60, f * W * frameH * 3, (f + 1) * W * frameH * 3); // visibly distinct frames
    }
    const animated = await sharp(stacked, {
      raw: { width: W, height: frameH * frameCount, channels: 3, pageHeight: frameH },
    }).gif({ loop: 0 }).toBuffer();

    const meta = await sharp(animated).metadata();
    expect(meta.pages).toBeGreaterThan(1); // fixture really is animated

    await expect(optimizeImage(animated)).rejects.toThrow(BadRequestException);
    await expect(optimizeImage(animated)).rejects.toThrow(/Animated GIFs are not supported/);
  }, 30000);

  it('a STATIC (single-frame) GIF is optimized to WebP like any other image — nothing is destroyed', async () => {
    const still = await sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 5, g: 120, b: 5 } } }).gif().toBuffer();
    expect((await sharp(still).metadata()).pages ?? 1).toBe(1);

    const out = await optimizeImage(still);
    expect(out.format).toBe('webp');
    expect(out.width).toBe(120);
    expect(out.height).toBe(90);
  }, 20000);

  it('rejects a non-image payload', async () => {
    await expect(optimizeImage(Buffer.from('this is definitely not an image'))).rejects.toThrow(BadRequestException);
  });
});

describe('processAndStore — what Cloudinary permanently stores is the optimized WebP', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uploads the optimized bytes, not the original, and skips Cloudinary re-transformation', async () => {
    const width = 3000, height = 2000;
    const noise = Buffer.alloc(width * height * 3);
    randomFillSync(noise); // native fill — same incompressible noise, ~20x faster than a per-byte JS loop
    const original = await sharp(noise, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();

    let uploadedBytes: Buffer | null = null;
    (cloudinaryMock.uploader.upload_stream as jest.Mock).mockImplementation((options: any, cb: any) => {
      (mockUploadStream as any).lastOptions = options;
      return { end: (b: Buffer) => { uploadedBytes = b; cb(null, { secure_url: 'https://res.cloudinary.com/x/image/upload/v1/remont/o.webp', public_id: 'remont/o', eager: [] }); } };
    });

    const svc = new UploadsService();
    const result = await svc.processAndStore({ mimetype: 'image/jpeg', buffer: original } as any);

    expect(uploadedBytes).not.toBeNull();
    // The uploaded payload is the optimized WebP — strictly smaller than, and not equal to,
    // the original upload.
    expect(uploadedBytes!.length).toBeLessThan(original.length);
    expect(uploadedBytes!.equals(original)).toBe(false);
    expect((await sharp(uploadedBytes!).metadata()).format).toBe('webp');
    // No incoming transformation: sharp already did the resizing.
    expect((mockUploadStream as any).lastOptions.transformation).toBeUndefined();
    expect(result.url).toContain('/upload/');
    // eslint-disable-next-line no-console
    console.log(`    [stored asset] original ${(original.length / 1048576).toFixed(2)}MB -> uploaded ${(uploadedBytes!.length / 1048576).toFixed(2)}MB WebP`);
  }, 120000); // ~2s on an idle machine; the headroom is for a fully parallel suite run
});
