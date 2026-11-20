import { resolveServiceRule, resolveCommission, resolveCityIdForRules, decideArrivalVerification, recordPartnerArrival, resolveCancellationPenalty } from './index';

/**
 * Audit H1 — a rule scoped to one city is never applied to another city or to a booking whose
 * city is unknown; the booking's city comes from the client's city name, else the customer's OWN
 * address, else the inline address.  Audit M6 — device location metadata can only downgrade.
 */
const base = { scope: 'CATEGORY', categoryId: 'cat', serviceId: null, commissionType: 'FLAT', slabJson: null, priority: 0, stackable: false, isActive: true };
const MIN_ALL = { ...base, id: 'min-all', ruleType: 'MINIMUM_CHARGE', cityId: null, value: 99 };
const MIN_BHOPAL = { ...base, id: 'min-bhopal', ruleType: 'MINIMUM_CHARGE', cityId: 'city-bhopal', value: 199 };
const MIN_INDORE = { ...base, id: 'min-indore', ruleType: 'MINIMUM_CHARGE', cityId: 'city-indore', value: 500, priority: 50 };

/** A query double that applies the where clause exactly as Postgres would — or, with
 * `ignoreCity`, returns every city's rules (to prove the in-code defence holds on its own). */
function prismaWith(rules: any[], opts: { ignoreCity?: boolean } = {}) {
  const cityOk = (clause: any, r: any) => (clause.OR ? r.cityId === null || r.cityId === clause.OR[1].cityId : r.cityId === clause.cityId);
  return {
    commissionRule: {
      findMany: jest.fn(async ({ where }: any) => rules.filter((r) => r.ruleType === where.ruleType
        && (r.serviceId === where.OR[0].serviceId || (r.categoryId === where.OR[1].categoryId && !r.serviceId))
        && (opts.ignoreCity || cityOk(where.AND[0], r)))),
    },
    siteSetting: { findUnique: jest.fn(async () => null) },
  };
}
const min = (prisma: any, cityId: string | null) => resolveServiceRule(prisma, 'MINIMUM_CHARGE', { serviceId: 'svc', categoryId: 'cat', cityId, amount: 0 });

describe('H1 — city-scoped rules', () => {
  it('no known city → only the all-city rule, and the query itself asks for cityId IS NULL', async () => {
    const prisma = prismaWith([MIN_ALL, MIN_BHOPAL, MIN_INDORE]);
    expect((await min(prisma, null)).commissionAmount).toBe(99);
    expect(prisma.commissionRule.findMany.mock.calls[0][0].where.AND[0]).toEqual({ cityId: null });
  });

  it.each([
    ['city-bhopal', 199], ['city-indore', 500], ['city-pune', 99],
  ])('city %s gets its own rule or the all-city one — never another city\'s', async (cityId, expected) => {
    expect((await min(prismaWith([MIN_ALL, MIN_BHOPAL, MIN_INDORE]), cityId)).commissionAmount).toBe(expected);
  });

  it('defence in depth: even if the query returned every city\'s rules, another city\'s rule is never applied', async () => {
    const leaky = prismaWith([MIN_ALL, MIN_BHOPAL, MIN_INDORE], { ignoreCity: true });
    expect((await min(leaky, null)).commissionAmount).toBe(99);
    expect((await min(leaky, 'city-bhopal')).commissionAmount).toBe(199); // not Indore's higher-priority 500
  });

  it('no rule for the city and none for all cities → ₹0 (nothing invented)', async () => {
    expect((await min(prismaWith([MIN_INDORE]), 'city-bhopal')).commissionAmount).toBe(0);
    expect((await min(prismaWith([MIN_INDORE]), null)).commissionAmount).toBe(0);
  });

  it('commission follows the same rule — a Bhopal-only 20% applies to Bhopal, not to an unknown city', async () => {
    const COMM = { ...base, id: 'comm-bhopal', ruleType: 'COMMISSION', commissionType: 'PERCENTAGE', cityId: 'city-bhopal', value: 20 };
    expect((await resolveCommission(prismaWith([COMM]), { serviceId: 'svc', categoryId: 'cat', cityId: 'city-bhopal', amount: 1000 })).commissionAmount).toBe(200);
    expect((await resolveCommission(prismaWith([COMM]), { serviceId: 'svc', categoryId: 'cat', cityId: null, amount: 1000 })).commissionAmount).toBe(0);
  });
});

describe('H1 — resolveCityIdForRules (the booking\'s city)', () => {
  const CITIES = [{ id: 'city-bhopal', name: 'Bhopal' }, { id: 'city-indore', name: 'Indore' }];
  function prisma(address: any = null) {
    return {
      address: { findUnique: jest.fn(async () => address) },
      city: { findFirst: jest.fn(async ({ where }: any) => CITIES.find((c) => c.name.toLowerCase() === String(where.name.equals).toLowerCase()) || null) },
    };
  }
  it('uses the city name sent (case-insensitive)', async () => {
    expect(await resolveCityIdForRules(prisma(), { cityName: 'bhopal' })).toBe('city-bhopal');
  });
  it('no city name (the app) → the customer\'s own saved address', async () => {
    expect(await resolveCityIdForRules(prisma({ userId: 'cust-1', city: 'Indore' }), { addressId: 'a1', customerId: 'cust-1' })).toBe('city-indore');
  });
  it('another customer\'s address is ignored (falls through to the inline city)', async () => {
    expect(await resolveCityIdForRules(prisma({ userId: 'someone-else', city: 'Indore' }), { addressId: 'a1', customerId: 'cust-1', inlineCity: 'Bhopal' })).toBe('city-bhopal');
    expect(await resolveCityIdForRules(prisma({ userId: 'someone-else', city: 'Indore' }), { addressId: 'a1', customerId: 'cust-1' })).toBeNull();
  });
  it('an unrecognised name falls through to the address; nothing recognised → null', async () => {
    expect(await resolveCityIdForRules(prisma({ userId: 'cust-1', city: 'Bhopal' }), { cityName: 'Atlantis', addressId: 'a1', customerId: 'cust-1' })).toBe('city-bhopal');
    expect(await resolveCityIdForRules(prisma(), { cityName: 'Atlantis' })).toBeNull();
  });
});

describe('M6 — device location metadata only ever downgrades', () => {
  const at = { addressLatitude: 23.2599, addressLongitude: 77.4126, radiusM: 300, maxAccuracyM: 100, maxFixAgeS: 120 };
  const near = { latitude: 23.2600, longitude: 77.4127, accuracyM: 10 };
  it('a fresh, accurate, near fix with no metadata (older app / browser) is still VERIFIED', () => {
    expect(decideArrivalVerification({ ...at, ...near }).verification).toBe('VERIFIED');
  });
  it('device says mocked → NOT_VERIFIED_MOCK_LOCATION', () => {
    expect(decideArrivalVerification({ ...at, ...near, isMocked: true }).verification).toBe('NOT_VERIFIED_MOCK_LOCATION');
  });
  it('fix older than the limit → NOT_VERIFIED_STALE_LOCATION; a fresh fix passes', () => {
    expect(decideArrivalVerification({ ...at, ...near, fixAgeMs: 300_000 }).verification).toBe('NOT_VERIFIED_STALE_LOCATION');
    expect(decideArrivalVerification({ ...at, ...near, fixAgeMs: 5_000 }).verification).toBe('VERIFIED');
  });
  it('"not mocked" never upgrades a bad fix', () => {
    expect(decideArrivalVerification({ ...at, latitude: 23.30, longitude: 77.45, accuracyM: 10, isMocked: false, fixAgeMs: 0 }).verification).toBe('NOT_VERIFIED_TOO_FAR');
    expect(decideArrivalVerification({ ...at, latitude: null, longitude: null, isMocked: false }).verification).toBe('NOT_VERIFIED_NO_LOCATION');
  });
  it('recordPartnerArrival stores the reason and honours the admin fix-age setting', async () => {
    let saved: any;
    const prisma: any = {
      siteSetting: { findUnique: jest.fn(async ({ where }: any) => (where.key === 'arrival_max_fix_age_s' ? { value: '30' } : null)) },
      order: { updateMany: jest.fn(async ({ data }: any) => { saved = data; return { count: 1 }; }), findUnique: jest.fn(async () => saved) },
      orderTimeline: { create: jest.fn(async () => ({})) },
    };
    const order = { id: 'o1', status: 'VENDOR_EN_ROUTE', snapshotLatitude: 23.2599, snapshotLongitude: 77.4126 };
    await recordPartnerArrival(prisma, order, { ...near, fixAgeMs: 60_000 }, { vendorId: 'v1' });
    expect(saved.arrivalVerification).toBe('NOT_VERIFIED_STALE_LOCATION');
    expect(saved.arrivalNote).toBe('Location fix was 60 s old');
    expect(saved.arrivalLatitude).toBe(near.latitude); // what the device reported is kept as evidence
  });
});

describe('Cancellation penalty after arrival (approved rule A) — admin-configured, never hard-coded', () => {
  const pen = (r: any) => ({ ...base, id: 'pen', ruleType: 'CANCELLATION_CHARGE', cityId: null, minimumAmount: null, ...r });
  const calc = (rules: any[], serviceAmount: number, cap = 5000, cityId: string | null = null) =>
    resolveCancellationPenalty(prismaWith(rules), { serviceId: 'svc', categoryId: 'cat', cityId, serviceAmount, cap });

  it('no rule → no penalty', async () => { expect((await calc([], 1000)).penalty).toBe(0); });
  it('a ₹0 rule → no penalty (admin decided it does not apply)', async () => { expect((await calc([pen({ commissionType: 'FLAT', value: 0 })], 1000)).penalty).toBe(0); });
  it('flat ₹ amount', async () => { expect((await calc([pen({ commissionType: 'FLAT', value: 350 })], 1000)).penalty).toBe(350); });
  it('percentage of the service amount', async () => { expect((await calc([pen({ commissionType: 'PERCENTAGE', value: 10 })], 1000)).penalty).toBe(100); });
  it('percentage with a minimum — the minimum wins on a small job …', async () => {
    const r = await calc([pen({ commissionType: 'PERCENTAGE', value: 10, minimumAmount: 199 })], 1000);
    expect(r.penalty).toBe(199);
    expect(r.breakdown).toEqual(expect.objectContaining({ percent: 10, percentAmount: 100, minimum: 199 }));
  });
  it('… and the percentage wins on a big job', async () => {
    expect((await calc([pen({ commissionType: 'PERCENTAGE', value: 10, minimumAmount: 199 })], 5000, 6000)).penalty).toBe(500);
  });
  it('never more than the booking\'s total payable', async () => {
    const r = await calc([pen({ commissionType: 'FLAT', value: 1500 })], 300, 354);
    expect(r.penalty).toBe(354);
    expect(r.breakdown.capped).toBe(true);
  });
  it('different services, different rules: a service rule (e.g. interior visit ₹1,500) beats the category rule', async () => {
    const rules = [pen({ id: 'cat', commissionType: 'FLAT', value: 199 }), pen({ id: 'svc', scope: 'SERVICE', serviceId: 'svc', categoryId: null, commissionType: 'FLAT', value: 1500 })];
    expect((await calc(rules, 3000)).penalty).toBe(1500);
  });
  it('city-scoped like every rule: another city\'s penalty never applies', async () => {
    const rules = [pen({ id: 'bhopal', commissionType: 'FLAT', value: 250, cityId: 'city-bhopal' })];
    expect((await calc(rules, 1000, 5000, 'city-indore')).penalty).toBe(0);
    expect((await calc(rules, 1000, 5000, 'city-bhopal')).penalty).toBe(250);
  });
});
