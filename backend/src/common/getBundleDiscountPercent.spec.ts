import { getBundleDiscountPercent } from './index';

describe('getBundleDiscountPercent', () => {
  function prismaWith(value: string | null) {
    return { siteSetting: { findUnique: jest.fn(async () => (value === null ? null : { key: 'bundle_discount_percent', value })) } };
  }

  it('defaults to 10 when the SiteSetting row does not exist yet', async () => {
    expect(await getBundleDiscountPercent(prismaWith(null))).toBe(10);
  });

  it('returns the admin-configured value when present', async () => {
    expect(await getBundleDiscountPercent(prismaWith('15'))).toBe(15);
  });

  it('defaults to 10 on an unparsable value, never throwing', async () => {
    expect(await getBundleDiscountPercent(prismaWith('not-a-number'))).toBe(10);
  });

  it('clamps a negative value up to the 10 default rather than an invalid negative discount', async () => {
    expect(await getBundleDiscountPercent(prismaWith('-5'))).toBe(10);
  });

  it('clamps an out-of-range value (e.g. 500) down to 100, never inverting the price', async () => {
    expect(await getBundleDiscountPercent(prismaWith('500'))).toBe(100);
  });

  it('allows exactly 0 (an admin explicitly disabling the offer)', async () => {
    expect(await getBundleDiscountPercent(prismaWith('0'))).toBe(0);
  });
});
