import { FcmService } from './fcm.service';

/**
 * FcmService is the whole reason a real "Uber-style" job-offer push notification can reach
 * a partner even when the app is backgrounded or the phone is locked — WebSocket
 * (notification.gateway.ts) only ever covers the foreground/open-tab case. This locks in
 * the "no-op with a clear signal, not a silent crash" contract for when Firebase env vars
 * aren't set yet, and the isConfigured() gate every other Firebase env var must all be
 * present for.
 */
describe('FcmService.isConfigured', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('is false when none of the three admin-SDK env vars are set', () => {
    expect(new FcmService().isConfigured()).toBe(false);
  });

  it.each([
    ['FIREBASE_PROJECT_ID'],
    ['FIREBASE_CLIENT_EMAIL'],
    ['FIREBASE_PRIVATE_KEY'],
  ])('is false when only the other two of three are set (missing %s)', (missing) => {
    process.env.FIREBASE_PROJECT_ID = 'proj';
    process.env.FIREBASE_CLIENT_EMAIL = 'svc@proj.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n';
    delete process.env[missing];
    expect(new FcmService().isConfigured()).toBe(false);
  });

  it('is true once all three admin-SDK env vars are set', () => {
    process.env.FIREBASE_PROJECT_ID = 'proj';
    process.env.FIREBASE_CLIENT_EMAIL = 'svc@proj.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n';
    expect(new FcmService().isConfigured()).toBe(true);
  });
});

describe('FcmService.sendToTokens — unconfigured (no Firebase env vars)', () => {
  beforeEach(() => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
  });

  it('no-ops (never touches firebase-admin) and reports every token as failed, not dead', async () => {
    const result = await new FcmService().sendToTokens(['token-1', 'token-2'], { title: 'New Job Available', body: 'Electrical • Bhopal' });
    // failureCount > 0 so callers/observability can tell "not configured" apart from
    // "silently succeeded" — but deadTokens stays empty so a real, previously-working
    // token is never pruned just because credentials are temporarily missing.
    expect(result).toEqual({ successCount: 0, failureCount: 2, deadTokens: [] });
  });

  it('returns a zero result without calling out to Firebase for an empty token list', async () => {
    const result = await new FcmService().sendToTokens([], { title: 'x', body: 'y' });
    expect(result).toEqual({ successCount: 0, failureCount: 0, deadTokens: [] });
  });
});
