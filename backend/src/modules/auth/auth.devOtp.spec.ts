import { devOtpAllowedFor } from './auth.module';

describe('devOtpAllowedFor — the shared test login code is never a universal login on production', () => {
  const prod = (extra: Record<string, string> = {}) => ({ NODE_ENV: 'production', DEV_OTP_OVERRIDE: '424242', ...extra });

  it('is off when no override is configured', () => {
    expect(devOtpAllowedFor('+919000000001', { NODE_ENV: 'production' })).toBe(false);
    expect(devOtpAllowedFor('+919000000001', { NODE_ENV: 'development' })).toBe(false);
  });

  it('is off on production when the allowlist is empty (fail-closed)', () => {
    expect(devOtpAllowedFor('+919000000001', prod())).toBe(false);
    expect(devOtpAllowedFor('+919000000001', prod({ DEV_OTP_ALLOWED_PHONES: ' , ' }))).toBe(false);
  });

  it('works on production only for listed numbers, whatever the formatting', () => {
    const env = prod({ DEV_OTP_ALLOWED_PHONES: '+91 90391 42875, 919000000002' });
    expect(devOtpAllowedFor('+919039142875', env)).toBe(true);
    expect(devOtpAllowedFor('9039142875', env)).toBe(true);
    expect(devOtpAllowedFor('+919000000002', env)).toBe(true);
    expect(devOtpAllowedFor('+919000000003', env)).toBe(false);
    expect(devOtpAllowedFor('', env)).toBe(false);
  });

  it('keeps working for any number outside production (local development)', () => {
    expect(devOtpAllowedFor('+919000000009', { NODE_ENV: 'development', DEV_OTP_OVERRIDE: '424242' })).toBe(true);
  });
});
