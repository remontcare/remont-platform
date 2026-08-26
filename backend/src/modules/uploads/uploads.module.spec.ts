import { Reflector } from '@nestjs/core';
import { UploadsController } from './uploads.module';

// Guards a subtle bug: @Public() only makes JwtAuthGuard skip auth — it does NOT
// clear a @Roles(...) requirement. If @Roles were still declared at the controller
// level, RolesGuard would still demand ADMIN/SUPER_ADMIN on the public lead-photo
// route and throw "User not authenticated" (no user was ever attached, since auth
// was skipped) — silently breaking the "public" route. This asserts the actual
// NestJS metadata resolution (handler-first, falling back to class) that RolesGuard
// uses, for all three routes.
describe('UploadsController route metadata — public route must have no @Roles at all', () => {
  const reflector = new Reflector();

  function rolesFor(methodName: 'uploadImage' | 'uploadVideo' | 'uploadLeadPhoto') {
    const handler = UploadsController.prototype[methodName];
    return reflector.getAllAndOverride('roles', [handler, UploadsController]);
  }
  function isPublicFor(methodName: 'uploadImage' | 'uploadVideo' | 'uploadLeadPhoto') {
    const handler = UploadsController.prototype[methodName];
    return reflector.getAllAndOverride('isPublic', [handler, UploadsController]);
  }

  it('uploadImage requires ADMIN/SUPER_ADMIN or PRODUCT_VENDOR (sellers uploading their own product images)', () => {
    expect(rolesFor('uploadImage')).toEqual(['ADMIN', 'SUPER_ADMIN', 'PRODUCT_VENDOR']);
    expect(isPublicFor('uploadImage')).toBeFalsy();
  });

  it('uploadVideo still requires ADMIN/SUPER_ADMIN', () => {
    expect(rolesFor('uploadVideo')).toEqual(['ADMIN', 'SUPER_ADMIN']);
    expect(isPublicFor('uploadVideo')).toBeFalsy();
  });

  it('uploadLeadPhoto has NO roles requirement and IS public — RolesGuard must no-op for it', () => {
    expect(rolesFor('uploadLeadPhoto')).toBeUndefined();
    expect(isPublicFor('uploadLeadPhoto')).toBe(true);
  });
});
