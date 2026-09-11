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
import sharp from 'sharp';
import { uploadBuffer, UploadsService } from './uploads.module';
import { assertWithinMegapixelCap } from './upload-security.interceptor';

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

describe('uploadBuffer — Cloudinary options built per resource type', () => {
  beforeEach(() => jest.clearAllMocks());

  it('images: caps the stored master at 2000px (longest side) and requests thumb/card/full as eager, f_auto q_auto', async () => {
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
    const result = await svc.processAndStore({ mimetype: 'image/jpeg', buffer: Buffer.from('x') } as any);

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
    const result = await svc.processAndStore({ mimetype: 'image/jpeg', buffer: Buffer.from('x') } as any);

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
 * GAP CHECK — every test above (and in upload-security.interceptor.spec.ts) exercised the
 * pipeline with a trivial 10x10 or literal string fixture, never anything resembling a real
 * "20MB+ DSLR photo." This closes that gap: a genuinely large, high-entropy, legitimately
 * decodable JPEG (high resolution + random-noise pixel data, so it can't trivially
 * compress away to nothing) is built for real via sharp, then run through the actual
 * megapixel-cap function and the actual processAndStore() request-building logic.
 *
 * What this DOES prove: a real large photo survives the 25-megapixel ceiling, and the exact
 * same correct Cloudinary parameters (2000px master cap, 200/600/1200 eager variants,
 * f_auto, q_auto) are requested for it as for the tiny fixtures used elsewhere.
 *
 * What this CANNOT prove without a live Cloudinary account: the literal "<300KB per
 * variant" output size. That number is Cloudinary's own encoding result, produced by their
 * `q_auto` algorithm — a mocked `upload_stream()` only returns whatever this test tells it
 * to return, so no unit test can honestly assert a real output byte count. Cloudinary's own
 * documentation describes q_auto as targeting the smallest file size at an acceptable
 * perceptual quality for the given format/width, which is why this pipeline requests it
 * instead of a fixed quality percentage — but confirming the actual resulting file sizes
 * requires either a live-account integration test or a manual check once this is deployed
 * with real credentials.
 */
describe('GAP CHECK — a realistic large (20MB-class) image survives validation and requests correct Cloudinary sizing', () => {
  beforeEach(() => jest.clearAllMocks());

  it('a real ~12-megapixel, multi-MB, high-entropy JPEG passes the megapixel cap and triggers the same 2000px/eager/f_auto,q_auto request as the trivial fixtures', async () => {
    // 4000x3000 = 12 megapixels — comfortably under the 25MP ceiling, but large enough
    // (with random noise, not a flat color, so it can't trivially compress) to be a
    // realistic multi-megabyte stand-in for a "20MB+ DSLR photo."
    const width = 4000;
    const height = 3000;
    const noise = Buffer.alloc(width * height * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256);
    const largeBuf = await sharp(noise, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    // Sanity-check the fixture itself is genuinely large before trusting the rest of the
    // test — this is standing in for a "20MB+" upload; a multi-MB high-entropy JPEG at this
    // resolution/quality is a realistic proxy without needing an actual 20MB file on disk.
    expect(largeBuf.length).toBeGreaterThan(2 * 1024 * 1024); // > 2MB

    // 1. Survives the real megapixel-cap function (not mocked).
    await expect(assertWithinMegapixelCap(largeBuf)).resolves.toBeUndefined();

    // 2. processAndStore() requests the correct capped-master + eager variants for this
    //    specific large buffer, exactly as it does for the trivial fixtures above.
    mockUploadStream({
      secure_url: 'https://res.cloudinary.com/x/image/upload/v1/remont/large.jpg',
      public_id: 'remont/large',
      eager: [
        { secure_url: 'https://res.cloudinary.com/x/image/upload/w_200/remont/large.jpg' },
        { secure_url: 'https://res.cloudinary.com/x/image/upload/w_600/remont/large.jpg' },
        { secure_url: 'https://res.cloudinary.com/x/image/upload/w_1200/remont/large.jpg' },
      ],
    });
    const svc = new UploadsService();
    const result = await svc.processAndStore({ mimetype: 'image/jpeg', buffer: largeBuf } as any);

    const options = (mockUploadStream as any).lastOptions;
    expect(options.transformation).toEqual([{ width: 2000, height: 2000, crop: 'limit' }]);
    expect(options.eager).toEqual([
      { width: 200, crop: 'limit', fetch_format: 'auto', quality: 'auto' },
      { width: 600, crop: 'limit', fetch_format: 'auto', quality: 'auto' },
      { width: 1200, crop: 'limit', fetch_format: 'auto', quality: 'auto' },
    ]);
    expect(result.thumb).toContain('w_200');
    expect(result.card).toContain('w_600');
    expect(result.full).toContain('w_1200');
  }, 20000); // real image generation/encoding — longer than the default 5s test timeout
});
