import { CitiesService } from './cities.module';

/**
 * getServicePrice() is the single shared price-resolution function used by real order
 * creation (orders.module.ts, master-orders.module.ts), the public service listing
 * (services.module.ts), and the estimate engine — so its precedence chain directly
 * decides what a customer actually pays. This covers the new ServicePricing (Admin →
 * Service Pricing) layer added alongside the pre-existing CityService.customPrice
 * override, and asserts nothing changes for a (service, city) pair with no
 * ServicePricing rows configured — i.e. the new feature is additive, not disruptive.
 */
function makeService(overrides: any = {}) {
  const prisma: any = {
    city: { findUnique: jest.fn().mockResolvedValue({ id: 'city-1', name: 'Bhopal', priceMultiplier: 1 }) },
    service: { findUnique: jest.fn().mockResolvedValue({ id: 'svc-1', basePrice: 500 }) },
    cityService: { findUnique: jest.fn().mockResolvedValue(null) },
    servicePricing: { findFirst: jest.fn().mockResolvedValue(null) },
    ...overrides,
  };
  return { svc: new CitiesService(prisma), prisma };
}

describe('CitiesService.getServicePrice — pricing precedence', () => {
  it('falls back to basePrice × priceMultiplier when nothing is configured (unchanged default)', async () => {
    const { svc } = makeService();
    await expect(svc.getServicePrice('Bhopal', 'svc-1')).resolves.toBe(500);
  });

  it('city priceMultiplier still applies with no overrides present', async () => {
    const { svc } = makeService({
      city: { findUnique: jest.fn().mockResolvedValue({ id: 'city-1', name: 'Bhopal', priceMultiplier: 1.2 }) },
    });
    await expect(svc.getServicePrice('Bhopal', 'svc-1')).resolves.toBe(600);
  });

  it('pre-existing CityService.customPrice still wins over the multiplier when no ServicePricing row exists', async () => {
    const { svc } = makeService({
      cityService: { findUnique: jest.fn().mockResolvedValue({ isActive: true, customPrice: 450 }) },
    });
    await expect(svc.getServicePrice('Bhopal', 'svc-1')).resolves.toBe(450);
  });

  it('a service explicitly disabled for this city (CityService.isActive=false) returns null even if a ServicePricing row exists', async () => {
    const { svc } = makeService({
      cityService: { findUnique: jest.fn().mockResolvedValue({ isActive: false, customPrice: null }) },
      servicePricing: { findFirst: jest.fn().mockResolvedValue({ basePrice: 300, discountedPrice: null }) },
    });
    await expect(svc.getServicePrice('Bhopal', 'svc-1')).resolves.toBeNull();
  });

  it('a STANDARD-tier ServicePricing row for this exact city wins over CityService.customPrice', async () => {
    const findFirst = jest.fn()
      .mockResolvedValueOnce({ basePrice: 399, discountedPrice: null }) // city-specific row
      .mockResolvedValueOnce(null); // global row (not reached, but mock is called regardless via Promise.all)
    const { svc } = makeService({
      cityService: { findUnique: jest.fn().mockResolvedValue({ isActive: true, customPrice: 450 }) },
      servicePricing: { findFirst },
    });
    await expect(svc.getServicePrice('Bhopal', 'svc-1')).resolves.toBe(399);
  });

  it('a city-tier row\'s discountedPrice is charged over its own basePrice when set', async () => {
    const findFirst = jest.fn()
      .mockResolvedValueOnce({ basePrice: 399, discountedPrice: 299 })
      .mockResolvedValueOnce(null);
    const { svc } = makeService({ servicePricing: { findFirst } });
    await expect(svc.getServicePrice('Bhopal', 'svc-1')).resolves.toBe(299);
  });

  it('a global ("All Cities") STANDARD tier row applies when no city-specific row or CityService override exists', async () => {
    const findFirst = jest.fn()
      .mockResolvedValueOnce(null) // no city-specific row
      .mockResolvedValueOnce({ basePrice: 349, discountedPrice: null }); // global row
    const { svc } = makeService({ servicePricing: { findFirst } });
    await expect(svc.getServicePrice('Bhopal', 'svc-1')).resolves.toBe(349);
  });

  it('CityService.customPrice still wins over a global tier default (per-city override beats city-agnostic default)', async () => {
    const findFirst = jest.fn()
      .mockResolvedValueOnce(null) // no city-specific tier row
      .mockResolvedValueOnce({ basePrice: 349, discountedPrice: null }); // global tier row exists too
    const { svc } = makeService({
      cityService: { findUnique: jest.fn().mockResolvedValue({ isActive: true, customPrice: 450 }) },
      servicePricing: { findFirst },
    });
    await expect(svc.getServicePrice('Bhopal', 'svc-1')).resolves.toBe(450);
  });

  it('returns null for an unknown city', async () => {
    const { svc } = makeService({ city: { findUnique: jest.fn().mockResolvedValue(null) } });
    await expect(svc.getServicePrice('Nowhere', 'svc-1')).resolves.toBeNull();
  });

  it('returns null for an unknown service', async () => {
    const { svc } = makeService({ service: { findUnique: jest.fn().mockResolvedValue(null) } });
    await expect(svc.getServicePrice('Bhopal', 'missing')).resolves.toBeNull();
  });
});
