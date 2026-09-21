/**
 * Route-level input policy for the three upload endpoints.
 *
 * Why a dedicated spec with a mocked FileInterceptor: the Multer limits are passed to
 * FileInterceptor('file', { limits: { fileSize } }) inside the @UseInterceptors decorator,
 * and the real FileInterceptor captures those options in a CLOSURE — it puts them on
 * neither the returned mixin class nor Nest's '__interceptors__' metadata, so there is no
 * way to read them back off the controller afterwards. Standing in for FileInterceptor and
 * recording what the decorators hand it at class-definition time is the only way to assert
 * the actual configured ceilings rather than a restated copy of them.
 *
 * Guards the policy that /uploads/image and /uploads/lead-photo share ONE image limit
 * (lead-photo used to be 5MB while image was 20MB) and that video keeps its own.
 */

// Hoisted above the imports. The recorder lives inside the factory and is re-exported on
// the mock itself, because a module-scoped array would still be in its TDZ when this runs.
jest.mock('@nestjs/platform-express', () => {
  const calls: Array<{ field: string; options: any }> = [];
  const FileInterceptor = (field: string, options: any) => {
    calls.push({ field, options });
    return class StandInFileInterceptor {}; // never executed; only the decorator needs a class
  };
  (FileInterceptor as any).__calls = calls;
  return { FileInterceptor };
});

import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_IMAGE_UPLOAD_BYTES } from './uploads.module'; // importing defines the controller, firing the decorators

const MB = 1024 * 1024;

/** Recorded in controller declaration order: image, video, lead-photo. */
function recorded() {
  return (FileInterceptor as any).__calls as Array<{ field: string; options: any }>;
}

describe('upload route input limits', () => {
  it('every upload route configures exactly one file field and an explicit size ceiling', () => {
    const calls = recorded();
    expect(calls).toHaveLength(3); // image, video, lead-photo — a new route must be added here deliberately
    for (const c of calls) {
      expect(c.field).toBe('file');
      expect(typeof c.options?.limits?.fileSize).toBe('number');
      expect(c.options.limits.fileSize).toBeGreaterThan(0);
    }
  });

  it('/uploads/image and /uploads/lead-photo share one 20MB image policy', () => {
    const [image, , leadPhoto] = recorded();
    expect(MAX_IMAGE_UPLOAD_BYTES).toBe(20 * MB);
    expect(image.options.limits.fileSize).toBe(MAX_IMAGE_UPLOAD_BYTES);
    expect(leadPhoto.options.limits.fileSize).toBe(MAX_IMAGE_UPLOAD_BYTES);
    // The point of the change: lead-photo is no longer the odd one out at 5MB.
    expect(leadPhoto.options.limits.fileSize).toBe(image.options.limits.fileSize);
    expect(leadPhoto.options.limits.fileSize).not.toBe(5 * MB);
  });

  it('/uploads/video keeps its own, separate 50MB ceiling', () => {
    const [, video] = recorded();
    expect(video.options.limits.fileSize).toBe(50 * MB);
    expect(video.options.limits.fileSize).not.toBe(MAX_IMAGE_UPLOAD_BYTES);
  });

  it('all three routes buffer in memory — nothing an attacker uploads is written to disk', () => {
    for (const c of recorded()) {
      expect(c.options.storage).toBeDefined();
      expect(c.options.dest).toBeUndefined(); // dest would make Multer spool to the filesystem
    }
  });
});
