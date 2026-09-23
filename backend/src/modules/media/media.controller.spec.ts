import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { MediaController } from './media.controller';
import { JwtAuthGuard, RolesGuard } from '../../common';

// The media API must never be reachable anonymously (no @Public anywhere), and the Media
// Library listing is admin-only. Upload permissions per role are enforced by the media
// policy inside MediaService (covered in media.service.spec.ts), not by route roles.
describe('MediaController route metadata', () => {
  const reflector = new Reflector();
  const handlers = ['uploadImage', 'list', 'get', 'update', 'remove'] as const;

  it('every route is behind JwtAuthGuard + RolesGuard and none is @Public', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, MediaController);
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
    for (const h of handlers) {
      expect(reflector.getAllAndOverride('isPublic', [MediaController.prototype[h], MediaController])).toBeFalsy();
    }
  });

  it('the Media Library listing is admin-only', () => {
    expect(reflector.getAllAndOverride('roles', [MediaController.prototype.list, MediaController])).toEqual(['ADMIN', 'SUPER_ADMIN']);
  });

  it('the upload route is rate-limited', () => {
    const keys = Reflect.getMetadataKeys(MediaController.prototype.uploadImage);
    expect(keys.some((k: any) => String(k).startsWith('THROTTLER:LIMIT'))).toBe(true);
  });
});
