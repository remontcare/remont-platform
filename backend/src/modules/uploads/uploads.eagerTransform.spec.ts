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
import { uploadBuffer, UploadsService } from './uploads.module';

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
