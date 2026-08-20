import { DispatchService, RoutingService } from './orders.module';

/**
 * Production incident: a live, verified Vadodara Plumbing partner existed for a Vadodara
 * Plumbing job, but automatic assignment never found them. Root cause: ServiceCategory.key
 * is stored however an admin typed it when the category was created (the seed data uses
 * lowercase, e.g. 'plumbing'), while every vendor's own `skills` array is normalized to
 * normalizeSkillKey() form (e.g. 'PLUMBING') at registration. `skills: { has: skill } }` is
 * a case-sensitive Postgres array containment check — 'plumbing' never matches 'PLUMBING',
 * so this silently broke category matching for EVERY category, in EVERY city, not just
 * Vadodara Plumbing. Fixed by normalizing the category key at every comparison site.
 */
describe('DispatchService.dispatch — category key casing', () => {
  function makeService() {
    const prisma: any = {
      order: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      serviceVendor: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const events: any = { emit: jest.fn() };
    return { service: new DispatchService(prisma, events), prisma };
  }

  it('normalizes a lowercase ServiceCategory.key before querying vendor skills', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', orderNumber: 'ORD-VADODARA-PLUMBING',
      address: { latitude: 22.3072, longitude: 73.1812, city: 'Vadodara' },
      service: { category: { key: 'plumbing' } }, // stored lowercase, exactly as seeded/typed by admin
    });

    await service.dispatch('order-1');

    expect(prisma.serviceVendor.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ skills: { has: 'PLUMBING' } }),
    }));
  });

  it('a live Vadodara plumber with matching normalized skills is actually offered the job', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', orderNumber: 'ORD-VADODARA-PLUMBING',
      address: { latitude: 22.3072, longitude: 73.1812, city: 'Vadodara' },
      service: { category: { key: 'plumbing' } },
    });
    prisma.serviceVendor.findMany.mockResolvedValue([
      {
        id: 'vendor-vadodara-plumber', userId: 'user-1', rating: 4.5, isVipPro: false, serviceRadius: 15,
        currentLatitude: 22.31, currentLongitude: 73.18, skills: ['PLUMBING'],
      },
    ]);

    const offered = await service.dispatch('order-1');

    expect(offered.map((c: any) => c.vendorId)).toEqual(['vendor-vadodara-plumber']);
    expect(prisma.serviceVendor.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ skills: { has: 'PLUMBING' } }),
    }));
  });
});

describe('RoutingService.route — category key casing in requiredSkills', () => {
  function makeService() {
    const prisma: any = {
      order: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      serviceVendor: { findMany: jest.fn().mockResolvedValue([]) },
      orderTimeline: { create: jest.fn() },
    };
    const events: any = { emit: jest.fn() };
    const dispatch: any = { dispatch: jest.fn().mockResolvedValue([]) };
    return { service: new RoutingService(prisma, events, dispatch), prisma };
  }

  it('normalizes lowercase Service.requiredSkills before the in-house hasSome query', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', orderNumber: 'ORD-1',
      service: { fulfillmentType: 'DIRECT_PARTNER', requiredSkills: ['plumbing'] },
      address: { city: 'Vadodara' },
    });

    await service.route('order-1');

    expect(prisma.serviceVendor.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ skills: { hasSome: ['PLUMBING'] } }),
    }));
  });
});
