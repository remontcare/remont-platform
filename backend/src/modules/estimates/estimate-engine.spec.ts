import {
  computePrice,
  determineEligibility,
  generateEstimate,
  EstimateEngineError,
  CITY_NOT_SERVICEABLE_MESSAGE,
} from './estimate-engine';

// ══════════════════════════════════════════════════════════════════════════
// PURE MATH — computePrice(). No mocking needed at all.
// ══════════════════════════════════════════════════════════════════════════
describe('computePrice — pure math', () => {
  it('FIXED pricing, no extras, no GST: cost is exactly the base price', () => {
    const r = computePrice({
      pricingType: 'FIXED', resolvedBasePrice: 25000, materialCost: 0, labourCost: 0,
      perSqftRate: 0, modifierMultipliers: [], consultationFee: 0, siteVisitFee: 0,
      gstPercent: 0, startingFromSpreadPercent: 25,
    });
    expect(r.workCostLow).toBe(25000);
    expect(r.workCostHigh).toBe(25000);
    expect(r.gstAmount).toBe(0);
    expect(r.finalPayableAmount).toBe(25000);
    expect(r.requiresQuotation).toBe(false);
  });

  it('FIXED pricing adds material + labour, then applies GST on top of everything', () => {
    const r = computePrice({
      pricingType: 'FIXED', resolvedBasePrice: 25000, materialCost: 10000, labourCost: 5000,
      perSqftRate: 0, modifierMultipliers: [], consultationFee: 999, siteVisitFee: 500,
      gstPercent: 18, startingFromSpreadPercent: 25,
    });
    // work = 25000 + 10000 + 5000 = 40000; gstBase = 40000 + 999 + 500 = 41499
    expect(r.workCostLow).toBe(40000);
    expect(r.gstAmount).toBe(7469.82); // 41499 * 0.18
    expect(r.finalPayableAmount).toBe(48968.82);
  });

  it('STARTING_FROM: high end is low * (1 + spread%), final payable anchors to the LOW figure', () => {
    const r = computePrice({
      pricingType: 'STARTING_FROM', resolvedBasePrice: 120000, materialCost: 0, labourCost: 0,
      perSqftRate: 0, modifierMultipliers: [], consultationFee: 0, siteVisitFee: 0,
      gstPercent: 18, startingFromSpreadPercent: 25,
    });
    expect(r.workCostLow).toBe(120000);
    expect(r.workCostHigh).toBe(150000); // 120000 * 1.25
    expect(r.gstAmount).toBe(21600); // GST on the LOW figure only
    expect(r.finalPayableAmount).toBe(141600);
  });

  it('modifiers compound multiplicatively across groups (size AND finish both apply)', () => {
    const r = computePrice({
      pricingType: 'FIXED', resolvedBasePrice: 100000, materialCost: 0, labourCost: 0,
      perSqftRate: 0, modifierMultipliers: [1.4, 1.6], consultationFee: 0, siteVisitFee: 0,
      gstPercent: 0, startingFromSpreadPercent: 25,
    });
    expect(r.modifierMultiplierApplied).toBeCloseTo(2.24, 5); // 1.4 * 1.6
    expect(r.workCostLow).toBeCloseTo(224000, 2);
  });

  it('PER_SQFT: cost is rate * sqft, ignoring resolvedBasePrice entirely', () => {
    const r = computePrice({
      pricingType: 'PER_SQFT', resolvedBasePrice: 999999, materialCost: 0, labourCost: 0,
      perSqftRate: 150, sqft: 1200, modifierMultipliers: [], consultationFee: 0, siteVisitFee: 0,
      gstPercent: 18, startingFromSpreadPercent: 25,
    });
    expect(r.workCostLow).toBe(180000); // 150 * 1200
    expect(r.gstAmount).toBe(32400);
  });

  it('QUOTATION: no work cost at all — only consultation/site-visit fees + GST on those', () => {
    const r = computePrice({
      pricingType: 'QUOTATION', resolvedBasePrice: 500000, materialCost: 50000, labourCost: 20000,
      perSqftRate: 0, modifierMultipliers: [], consultationFee: 999, siteVisitFee: 500,
      gstPercent: 18, startingFromSpreadPercent: 25,
    });
    expect(r.workCostLow).toBeNull();
    expect(r.workCostHigh).toBeNull();
    expect(r.requiresQuotation).toBe(true);
    expect(r.gstAmount).toBe(269.82); // 18% of (999+500)
    expect(r.finalPayableAmount).toBe(1768.82);
  });

  it('rounds to 2 decimal places even with messy multipliers', () => {
    const r = computePrice({
      pricingType: 'FIXED', resolvedBasePrice: 33333, materialCost: 0, labourCost: 0,
      perSqftRate: 0, modifierMultipliers: [1.111], consultationFee: 0, siteVisitFee: 0,
      gstPercent: 18, startingFromSpreadPercent: 25,
    });
    expect(Number.isInteger(r.workCostLow! * 100)).toBe(true);
    expect(Number.isInteger(r.gstAmount * 100)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PURE ELIGIBILITY — determineEligibility(). No mocking needed at all.
// ══════════════════════════════════════════════════════════════════════════
describe('determineEligibility — pure, requirement #8 (never blocks the customer)', () => {
  it('DIGITAL service is always eligible, even with no city and zero vendors', () => {
    const r = determineEligibility({
      serviceType: 'DIGITAL', cityProvided: false, cityFound: false, cityIsActive: false,
      cityServiceOverrideActive: null, activeVendorCount: 0,
    });
    expect(r).toEqual({ eligible: true, reason: 'DIGITAL_NO_RESTRICTION', message: null });
  });

  it('ONSITE with no city selected asks for a city, does not claim availability', () => {
    const r = determineEligibility({
      serviceType: 'ONSITE', cityProvided: false, cityFound: false, cityIsActive: false,
      cityServiceOverrideActive: null, activeVendorCount: 0,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('CITY_REQUIRED');
  });

  it('ONSITE, city active, vendors present, no per-service override row => eligible by default', () => {
    const r = determineEligibility({
      serviceType: 'ONSITE', cityProvided: true, cityFound: true, cityIsActive: true,
      cityServiceOverrideActive: null, activeVendorCount: 3,
    });
    expect(r).toEqual({ eligible: true, reason: 'OK', message: null });
  });

  it('ONSITE, city explicitly disabled for this service => not serviceable, exact required message, never blocked', () => {
    const r = determineEligibility({
      serviceType: 'ONSITE', cityProvided: true, cityFound: true, cityIsActive: true,
      cityServiceOverrideActive: false, activeVendorCount: 5,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('CITY_NOT_SERVICEABLE');
    expect(r.message).toBe(CITY_NOT_SERVICEABLE_MESSAGE);
    expect(r.message).toBe('Estimate Available, Execution Not Available Yet.');
  });

  it('ONSITE, city active with zero real vendors => not serviceable (nobody to execute)', () => {
    const r = determineEligibility({
      serviceType: 'ONSITE', cityProvided: true, cityFound: true, cityIsActive: true,
      cityServiceOverrideActive: true, activeVendorCount: 0,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('CITY_NOT_SERVICEABLE');
  });

  it('ONSITE, city name not recognized at all => not serviceable, never silently allowed', () => {
    const r = determineEligibility({
      serviceType: 'ONSITE', cityProvided: true, cityFound: false, cityIsActive: false,
      cityServiceOverrideActive: null, activeVendorCount: 0,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('CITY_NOT_SERVICEABLE');
  });

  it('HYBRID is gated the same as ONSITE (site-visit component still needs a serviceable city)', () => {
    const r = determineEligibility({
      serviceType: 'HYBRID', cityProvided: false, cityFound: false, cityIsActive: false,
      cityServiceOverrideActive: null, activeVendorCount: 0,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('CITY_REQUIRED');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ORCHESTRATION — generateEstimate(prisma, citiesService, params).
// Mocked prisma + mocked CitiesService — same technique as commission.spec.ts.
// No live database connection anywhere in this file.
// ══════════════════════════════════════════════════════════════════════════
function makePrisma(overrides: Partial<Record<string, any>> = {}) {
  return {
    service: {
      findUnique: jest.fn(async () => ({
        id: 'svc-1', categoryId: 'cat-1', name: 'Modular Kitchen',
        serviceType: 'ONSITE', pricingType: 'FIXED',
        basePrice: 120000, offerPrice: null,
        consultationFee: 0, siteVisitFee: 0, materialCost: 0, labourCost: 0,
        perSqftRate: 0, gstOverridePercent: null,
        timelineMinDays: 35, timelineMaxDays: 49,
        category: { id: 'cat-1', key: 'interior' },
      })),
    },
    cityService: { findUnique: jest.fn(async () => null) },
    servicePriceModifier: { findMany: jest.fn(async () => []) },
    taxConfig: { findMany: jest.fn(async () => [{ rate: 18, createdAt: new Date() }]) },
    siteSetting: { findUnique: jest.fn(async () => null) },
    estimate: { create: jest.fn(async ({ data }: any) => ({ id: 'est-1', ...data })) },
    ...overrides,
  };
}
function makeCitiesService(overrides: Partial<Record<string, any>> = {}) {
  return {
    getServicePrice: jest.fn(async () => null),
    getByName: jest.fn(async () => ({ id: 'city-1', isActive: true, priceMultiplier: 1 })),
    list: jest.fn(async () => [{ name: 'Bhopal', activeVendors: 4 }]),
    ...overrides,
  };
}

describe('generateEstimate — orchestration (mocked prisma + citiesService, no live DB)', () => {
  it('happy path: FIXED service, serviceable city => eligible estimate with correct totals', async () => {
    const prisma = makePrisma();
    const cities = makeCitiesService();
    const result = await generateEstimate(prisma, cities, { serviceId: 'svc-1', city: 'Bhopal' });

    expect(result.estimatedCost).toEqual({ low: 120000, high: 120000, currency: 'INR' });
    expect(result.breakdown.gstPercent).toBe(18);
    expect(result.finalPayableAmount).toBe(141600); // 120000 * 1.18
    expect(result.bookingEligibility.eligible).toBe(true);
    expect(result.timeline.label).toBe('5–7 weeks');
    expect(prisma.estimate.create).toHaveBeenCalledTimes(1);
  });

  it('city not serviceable (per-service override disabled) => estimate still returned, exact message, not blocked', async () => {
    const prisma = makePrisma({ cityService: { findUnique: jest.fn(async () => ({ isActive: false })) } });
    const cities = makeCitiesService();
    const result = await generateEstimate(prisma, cities, { serviceId: 'svc-1', city: 'Bhopal' });

    expect(result.estimatedCost).not.toBeNull(); // NEVER blocked
    expect(result.bookingEligibility.eligible).toBe(false);
    expect(result.bookingEligibility.message).toBe('Estimate Available, Execution Not Available Yet.');
  });

  it('DIGITAL service never looks up city data, even when a city is passed', async () => {
    const prisma = makePrisma({
      service: { findUnique: jest.fn(async () => ({
        id: 'svc-2', categoryId: 'cat-1', name: 'Online Consultation',
        serviceType: 'DIGITAL', pricingType: 'FIXED', basePrice: 499, offerPrice: null,
        consultationFee: 0, siteVisitFee: 0, materialCost: 0, labourCost: 0, perSqftRate: 0,
        gstOverridePercent: null, timelineMinDays: null, timelineMaxDays: null,
        category: { id: 'cat-1', key: 'interior' },
      })) },
    });
    const cities = makeCitiesService();
    const result = await generateEstimate(prisma, cities, { serviceId: 'svc-2', city: 'SomeUnknownTown' });

    expect(result.bookingEligibility).toEqual({ eligible: true, reason: 'DIGITAL_NO_RESTRICTION', message: null });
    // Digital services must not even trigger a city lookup — no restriction means no check.
    expect(cities.getByName).not.toHaveBeenCalled();
  });

  it('PER_SQFT service without sqft input throws a clear, typed error', async () => {
    const prisma = makePrisma({
      service: { findUnique: jest.fn(async () => ({
        id: 'svc-3', categoryId: 'cat-1', name: 'Flooring', serviceType: 'ONSITE', pricingType: 'PER_SQFT',
        basePrice: 0, offerPrice: null, consultationFee: 0, siteVisitFee: 0, materialCost: 0, labourCost: 0,
        perSqftRate: 150, gstOverridePercent: null, timelineMinDays: null, timelineMaxDays: null,
        category: { id: 'cat-1', key: 'interior' },
      })) },
    });
    const cities = makeCitiesService();
    await expect(generateEstimate(prisma, cities, { serviceId: 'svc-3', city: 'Bhopal' }))
      .rejects.toBeInstanceOf(EstimateEngineError);
    await expect(generateEstimate(prisma, cities, { serviceId: 'svc-3', city: 'Bhopal' }))
      .rejects.toMatchObject({ code: 'SQFT_REQUIRED' });
  });

  it('unknown serviceId throws EstimateEngineError(SERVICE_NOT_FOUND)', async () => {
    const prisma = makePrisma({ service: { findUnique: jest.fn(async () => null) } });
    const cities = makeCitiesService();
    await expect(generateEstimate(prisma, cities, { serviceId: 'does-not-exist' }))
      .rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
  });

  it('service-level gstOverridePercent skips the TaxConfig lookup entirely', async () => {
    const prisma = makePrisma({
      service: { findUnique: jest.fn(async () => ({
        id: 'svc-1', categoryId: 'cat-1', name: 'X', serviceType: 'ONSITE', pricingType: 'FIXED',
        basePrice: 1000, offerPrice: null, consultationFee: 0, siteVisitFee: 0, materialCost: 0, labourCost: 0,
        perSqftRate: 0, gstOverridePercent: 5, timelineMinDays: null, timelineMaxDays: null,
        category: { id: 'cat-1', key: 'interior' },
      })) },
    });
    const cities = makeCitiesService();
    const result = await generateEstimate(prisma, cities, { serviceId: 'svc-1', city: 'Bhopal' });
    expect(result.breakdown.gstPercent).toBe(5);
    expect(prisma.taxConfig.findMany).not.toHaveBeenCalled();
  });

  it('CityService.customPrice (via citiesService.getServicePrice) overrides the base price', async () => {
    const prisma = makePrisma();
    const cities = makeCitiesService({ getServicePrice: jest.fn(async () => 99999) });
    const result = await generateEstimate(prisma, cities, { serviceId: 'svc-1', city: 'Bhopal' });
    expect(result.estimatedCost!.low).toBe(99999);
  });

  it('an admin-configured modifier (size=Large) multiplies the work cost', async () => {
    const prisma = makePrisma({
      servicePriceModifier: { findMany: jest.fn(async () => [
        { serviceId: null, categoryId: 'cat-1', group: 'size', label: 'Large', multiplier: 1.4, isActive: true },
      ]) },
    });
    const cities = makeCitiesService();
    const result = await generateEstimate(prisma, cities, {
      serviceId: 'svc-1', city: 'Bhopal', modifiers: [{ group: 'size', label: 'Large' }],
    });
    expect(result.estimatedCost!.low).toBe(168000); // 120000 * 1.4
    expect(result.breakdown.modifiersApplied).toEqual([{ group: 'size', label: 'Large', multiplier: 1.4 }]);
  });
});
