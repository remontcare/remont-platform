import { applyBookingMinimum, decideArrivalVerification, resolveServiceRule, resolveBookingMinimumCharge } from './index';

/** Pure/DB-light pieces of the minimum charge, rule types and arrival verification. */
describe('applyBookingMinimum (GST-inclusive, per booking)', () => {
  it.each([
    [[5], 18, 199, 163.64],
    [[150], 18, 199, 18.64],
    [[0], 18, 199, 168.64],
    [[199], 18, 199, 0],
    [[500], 18, 199, 0],
    [[100, 5], 18, 199, 63.64],
    [[5], 0, 199, 194],
  ])('lines %p @%d%% with minimum ₹%d → top-up ₹%d', (lines, rate, min, adj) => {
    const r = applyBookingMinimum(lines as number[], rate as number, min as number);
    expect(r.adjustment).toBe(adj);
    const base = r.lineAmounts.reduce((s, a) => s + a, 0);
    if (adj > 0) expect(Math.round((base + Math.round(base * (rate as number)) / 100) * 100) / 100).toBeCloseTo(min as number, 1);
  });

  it('spreads the top-up proportionally and keeps the exact total', () => {
    const r = applyBookingMinimum([30, 10], 18, 199);
    expect(r.lineAmounts[0] + r.lineAmounts[1]).toBeCloseTo(168.64, 2);
    expect(r.lineAmounts[0]).toBeGreaterThan(r.lineAmounts[1]);
  });

  it('no minimum (0) or no lines is a no-op', () => {
    expect(applyBookingMinimum([5], 18, 0)).toEqual({ adjustment: 0, lineAmounts: [5] });
    expect(applyBookingMinimum([], 18, 199)).toEqual({ adjustment: 0, lineAmounts: [] });
  });
});

describe('resolveServiceRule — one resolver, three rule types', () => {
  const prisma = (rules: any[], defaultPct: string | null = null) => ({
    commissionRule: { findMany: jest.fn(async ({ where }: any) => rules.filter((r) => r.ruleType === where.ruleType)) },
    siteSetting: { findUnique: jest.fn(async () => (defaultPct ? { value: defaultPct } : null)) },
  });
  const base = { scope: 'CATEGORY', categoryId: 'c', serviceId: null, cityId: null, slabJson: null, priority: 0, stackable: false, isActive: true };

  it('COMMISSION keeps its default_commission_pct fallback (unchanged behaviour)', async () => {
    expect((await resolveServiceRule(prisma([], '10') as any, 'COMMISSION', { serviceId: 's', categoryId: 'c', amount: 500 })).commissionAmount).toBe(50);
  });

  it('MINIMUM_CHARGE / CANCELLATION_CHARGE never fall back — no rule means ₹0', async () => {
    for (const t of ['MINIMUM_CHARGE', 'CANCELLATION_CHARGE'] as const) {
      expect(await resolveServiceRule(prisma([], '10') as any, t, { serviceId: 's', categoryId: 'c', amount: 500 })).toEqual({ commissionAmount: 0, ruleId: null, ruleLabel: 'No rule — ₹0', rule: null });
    }
  });

  it('rule types never leak into each other', async () => {
    const p = prisma([{ ...base, id: 'm', ruleType: 'MINIMUM_CHARGE', commissionType: 'FLAT', value: 199 }]);
    expect((await resolveServiceRule(p as any, 'COMMISSION', { serviceId: 's', categoryId: 'c', amount: 100 })).commissionAmount).toBe(0);
    expect((await resolveServiceRule(p as any, 'MINIMUM_CHARGE', { serviceId: 's', categoryId: 'c', amount: 0 })).commissionAmount).toBe(199);
  });

  it('booking minimum = highest applicable rule across the booking lines', async () => {
    const p = { commissionRule: { findMany: jest.fn(async ({ where }: any) => (where.OR[0].serviceId === 's2' ? [{ ...base, id: 'x', ruleType: 'MINIMUM_CHARGE', scope: 'SERVICE', serviceId: 's2', commissionType: 'FLAT', value: 499 }] : [{ ...base, id: 'y', ruleType: 'MINIMUM_CHARGE', commissionType: 'FLAT', value: 199 }])) } };
    expect(await resolveBookingMinimumCharge(p as any, [{ serviceId: 's1', categoryId: 'c' }, { serviceId: 's2', categoryId: 'c' }])).toEqual({ minimum: 499, ruleId: 'x' });
  });
});

describe('decideArrivalVerification', () => {
  const addr = { addressLatitude: 23.2599, addressLongitude: 77.4126, radiusM: 300, maxAccuracyM: 100 };
  it('verified only with valid coordinates on both sides, within radius, with good accuracy', () => {
    expect(decideArrivalVerification({ latitude: 23.2601, longitude: 77.4127, accuracyM: 10, ...addr }).verification).toBe('VERIFIED');
    expect(decideArrivalVerification({ latitude: 23.2601, longitude: 77.4127, accuracyM: 10, ...addr, addressLatitude: null }).verification).toBe('NOT_VERIFIED_NO_ADDRESS_COORDINATES');
    expect(decideArrivalVerification({ latitude: 23.27, longitude: 77.43, accuracyM: 10, ...addr }).verification).toBe('NOT_VERIFIED_TOO_FAR');
    expect(decideArrivalVerification({ latitude: 23.2601, longitude: 77.4127, accuracyM: 101, ...addr }).verification).toBe('NOT_VERIFIED_LOW_ACCURACY');
    expect(decideArrivalVerification({ latitude: null, longitude: null, accuracyM: 5, ...addr })).toEqual({ verification: 'NOT_VERIFIED_NO_LOCATION', distanceM: null });
  });
});
