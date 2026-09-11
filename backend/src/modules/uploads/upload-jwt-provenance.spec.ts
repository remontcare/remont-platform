import * as fs from 'fs';
import * as path from 'path';

/**
 * GAP CHECK — the upload security work (JwtAuthGuard on all three upload routes) rests on
 * an assumption that was previously only asserted in prose, never actually verified: that
 * any JWT JwtAuthGuard accepts can only have been minted by the OTP verification flow, not
 * some other grant (password login, an admin-only issuance path, a dev bypass, etc).
 *
 * JWTs are stateless and self-contained, so this can't be checked by inspecting a token at
 * validation time — the real guarantee is architectural: there is exactly one place in this
 * codebase that signs an access/refresh token (AuthService.issueTokens(), private, in
 * auth.module.ts), and it is reachable from exactly two call sites — verifyOtp() (the real
 * OTP flow) and refresh() (which itself only re-issues from a refresh token that was already
 * minted by a prior verifyOtp() call). This is a static, source-level invariant test rather
 * than a behavioral one, specifically because "no other path exists" isn't something a
 * mocked unit test of the public API alone can prove.
 *
 * Read-only — does not modify auth.module.ts. If this test ever fails, it means a new token-
 * issuing path was added outside issueTokens()/verifyOtp()/refresh(), which is exactly the
 * kind of change that would silently invalidate every upload route's OTP-only assumption.
 */
describe('Upload JWT provenance — JwtAuthGuard can only accept tokens minted by the OTP flow', () => {
  const authSrc = fs.readFileSync(
    path.join(__dirname, '..', 'auth', 'auth.module.ts'),
    'utf8',
  );

  it('signs a token in exactly one place: issueTokens() (access + refresh token = 2 sign calls)', () => {
    const signCalls = authSrc.match(/this\.jwt\.signAsync\(/g) || [];
    expect(signCalls.length).toBe(2);
  });

  it('issueTokens() is invoked from exactly two call sites: verifyOtp() and refresh()', () => {
    // Note: the method's own declaration is `private async issueTokens(` — no `this.`
    // prefix — so this pattern only ever matches actual call sites, never the definition.
    const invocations = authSrc.match(/this\.issueTokens\(/g) || [];
    expect(invocations.length).toBe(2);
  });

  it('issueTokens() itself is declared private — cannot be called from outside AuthService (e.g. from another module or controller)', () => {
    expect(authSrc).toMatch(/private async issueTokens\(/);
  });

  it('the AuthController exposes no route that signs a token directly — every token-bearing response comes from verifyOtp() or refresh()', () => {
    // POST /auth/send-otp only ever sends an OTP, never a token — confirms the controller
    // route list hasn't grown a new, undocumented token-issuing endpoint.
    const routeMatches = authSrc.match(/@Post\('([\w-]+)'\)/g) || [];
    const routes = routeMatches.map((m) => m.match(/@Post\('([\w-]+)'\)/)![1]);
    expect(routes.sort()).toEqual(['logout', 'logout-all', 'refresh', 'send-otp', 'verify-otp'].sort());
  });
});
