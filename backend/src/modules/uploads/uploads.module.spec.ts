import { Reflector } from '@nestjs/core';
import { UploadsController } from './uploads.module';

// SECURITY — uploadLeadPhoto used to be @Public() (reachable with zero authentication);
// it must now require a valid OTP-issued JWT like the other two routes, with no @Roles()
// restriction (RolesGuard no-ops when no roles are declared — any authenticated user,
// not one specific role, may attach a lead-capture photo). This asserts the actual
// NestJS metadata resolution (handler-first, falling back to class) that both
// JwtAuthGuard and RolesGuard use, for all three routes.
describe('UploadsController route metadata — every route requires auth; none declare @Roles beyond image/video', () => {
  const reflector = new Reflector();

  function rolesFor(methodName: 'uploadImage' | 'uploadVideo' | 'uploadLeadPhoto') {
    const handler = UploadsController.prototype[methodName];
    return reflector.getAllAndOverride('roles', [handler, UploadsController]);
  }
  function isPublicFor(methodName: 'uploadImage' | 'uploadVideo' | 'uploadLeadPhoto') {
    const handler = UploadsController.prototype[methodName];
    return reflector.getAllAndOverride('isPublic', [handler, UploadsController]);
  }

  it('uploadImage requires ADMIN/SUPER_ADMIN, PRODUCT_VENDOR (seller product images), or CUSTOMER (Phase 6 support/return/warranty evidence)', () => {
    expect(rolesFor('uploadImage')).toEqual(['ADMIN', 'SUPER_ADMIN', 'PRODUCT_VENDOR', 'CUSTOMER']);
    expect(isPublicFor('uploadImage')).toBeFalsy();
  });

  it('uploadVideo still requires ADMIN/SUPER_ADMIN', () => {
    expect(rolesFor('uploadVideo')).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(isPublicFor('uploadVideo')).toBeFalsy();
  });

  it('uploadLeadPhoto requires a logged-in user (any role) — no longer public', () => {
    expect(rolesFor('uploadLeadPhoto')).toBeUndefined();
    expect(isPublicFor('uploadLeadPhoto')).toBeFalsy();
  });
});
