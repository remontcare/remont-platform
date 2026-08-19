import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.module';

/**
 * Coverage for the Admin → Service Pricing CRUD (backs the pricing tiers that feed
 * real checkout pricing via CitiesService.getServicePrice — see
 * cities.getServicePrice.spec.ts for that side). All money/duration validation must
 * happen here, server-side — the admin form's own client-side checks are not a
 * substitute since this endpoint is reachable by anything holding a valid admin JWT.
 */
function makeService() {
  const prisma: any = {
    service: { findUnique: jest.fn().mockResolvedValue({ id: 'svc-1', name: 'AC Service' }) },
    city: { findUnique: jest.fn().mockResolvedValue({ id: 'city-1', name: 'Bhopal' }) },
    servicePricing: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn((args: any) => Promise.resolve({ id: 'sp-1', ...args.data })),
      update: jest.fn((args: any) => Promise.resolve({ id: args.where.id, ...args.data })),
      delete: jest.fn((args: any) => Promise.resolve({ id: args.where.id })),
    },
  };
  const config: any = { get: jest.fn((_key: string, def: any) => def) };
  const svc = new AdminService(prisma, config, {} as any, {} as any, {} as any, { emit: jest.fn() } as any, {} as any, {} as any, {} as any);
  return { svc, prisma };
}

describe('AdminService — Service Pricing CRUD', () => {
  describe('createServicePricing', () => {
    it('creates a valid STANDARD-tier row', async () => {
      const { svc, prisma } = makeService();
      const result = await svc.createServicePricing({ serviceId: 'svc-1', cityId: 'city-1', basePrice: 599, discountedPrice: 499, duration: 60, tier: 'STANDARD' });
      expect(result.basePrice).toBe(599);
      expect(prisma.servicePricing.create).toHaveBeenCalled();
    });

    it('rejects a missing service', async () => {
      const { svc } = makeService();
      await expect(svc.createServicePricing({ basePrice: 100 })).rejects.toThrow(BadRequestException);
    });

    it('rejects a serviceId that does not exist', async () => {
      const { svc, prisma } = makeService();
      prisma.service.findUnique.mockResolvedValue(null);
      await expect(svc.createServicePricing({ serviceId: 'ghost', basePrice: 100 })).rejects.toThrow(NotFoundException);
    });

    it('rejects a cityId that does not exist', async () => {
      const { svc, prisma } = makeService();
      prisma.city.findUnique.mockResolvedValue(null);
      await expect(svc.createServicePricing({ serviceId: 'svc-1', cityId: 'ghost', basePrice: 100 })).rejects.toThrow(NotFoundException);
    });

    it.each([0, -50, NaN, Infinity])('rejects a non-positive/invalid basePrice (%p)', async (bad) => {
      const { svc } = makeService();
      await expect(svc.createServicePricing({ serviceId: 'svc-1', basePrice: bad })).rejects.toThrow(BadRequestException);
    });

    it('rejects a discountedPrice higher than basePrice', async () => {
      const { svc } = makeService();
      await expect(svc.createServicePricing({ serviceId: 'svc-1', basePrice: 100, discountedPrice: 150 })).rejects.toThrow(BadRequestException);
    });

    it('rejects a non-positive discountedPrice', async () => {
      const { svc } = makeService();
      await expect(svc.createServicePricing({ serviceId: 'svc-1', basePrice: 100, discountedPrice: -10 })).rejects.toThrow(BadRequestException);
    });

    it('rejects a non-integer or non-positive duration', async () => {
      const { svc } = makeService();
      await expect(svc.createServicePricing({ serviceId: 'svc-1', basePrice: 100, duration: 12.5 })).rejects.toThrow(BadRequestException);
      await expect(svc.createServicePricing({ serviceId: 'svc-1', basePrice: 100, duration: 0 })).rejects.toThrow(BadRequestException);
    });

    it('defaults tier to STANDARD and cityId to null ("All Cities") when omitted', async () => {
      const { svc, prisma } = makeService();
      await svc.createServicePricing({ serviceId: 'svc-1', basePrice: 100 });
      expect(prisma.servicePricing.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ tier: 'STANDARD', cityId: null }),
      }));
    });

    it('rejects a duplicate (service, city, tier) combination', async () => {
      const { svc, prisma } = makeService();
      prisma.servicePricing.findFirst.mockResolvedValue({ id: 'existing-row' });
      await expect(svc.createServicePricing({ serviceId: 'svc-1', cityId: 'city-1', basePrice: 100, tier: 'STANDARD' }))
        .rejects.toThrow(BadRequestException);
    });

    it('silently coerces an unrecognized tier value to STANDARD rather than trusting arbitrary client input', async () => {
      const { svc, prisma } = makeService();
      await svc.createServicePricing({ serviceId: 'svc-1', basePrice: 100, tier: 'DROP TABLE users' });
      expect(prisma.servicePricing.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ tier: 'STANDARD' }),
      }));
    });
  });

  describe('updateServicePricing', () => {
    it('404s on an unknown id', async () => {
      const { svc, prisma } = makeService();
      prisma.servicePricing.findUnique.mockResolvedValue(null);
      await expect(svc.updateServicePricing('missing', { basePrice: 100 })).rejects.toThrow(NotFoundException);
    });

    it('merges partial updates onto the existing row and re-validates the merged result', async () => {
      const { svc, prisma } = makeService();
      prisma.servicePricing.findUnique.mockResolvedValue({ id: 'sp-1', serviceId: 'svc-1', cityId: 'city-1', tier: 'STANDARD', basePrice: 500, discountedPrice: 400, duration: 60 });
      // Only lowering basePrice below the existing discountedPrice — must fail even though
      // discountedPrice itself wasn't touched in this request.
      await expect(svc.updateServicePricing('sp-1', { basePrice: 300 })).rejects.toThrow(BadRequestException);
    });

    it('allows clearing discountedPrice back to null', async () => {
      const { svc, prisma } = makeService();
      prisma.servicePricing.findUnique.mockResolvedValue({ id: 'sp-1', serviceId: 'svc-1', cityId: 'city-1', tier: 'STANDARD', basePrice: 500, discountedPrice: 400, duration: 60 });
      await svc.updateServicePricing('sp-1', { discountedPrice: null });
      expect(prisma.servicePricing.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ discountedPrice: null }),
      }));
    });

    it('rejects moving into a (service, city, tier) combo already taken by a different row', async () => {
      const { svc, prisma } = makeService();
      prisma.servicePricing.findUnique.mockResolvedValue({ id: 'sp-1', serviceId: 'svc-1', cityId: 'city-1', tier: 'STANDARD', basePrice: 500, discountedPrice: null, duration: null });
      prisma.servicePricing.findFirst.mockResolvedValue({ id: 'sp-2' }); // a different row already at the target combo
      await expect(svc.updateServicePricing('sp-1', { tier: 'PREMIUM' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteServicePricing', () => {
    it('404s on an unknown id', async () => {
      const { svc, prisma } = makeService();
      prisma.servicePricing.findUnique.mockResolvedValue(null);
      await expect(svc.deleteServicePricing('missing')).rejects.toThrow(NotFoundException);
    });

    it('deletes an existing row', async () => {
      const { svc, prisma } = makeService();
      prisma.servicePricing.findUnique.mockResolvedValue({ id: 'sp-1' });
      await svc.deleteServicePricing('sp-1');
      expect(prisma.servicePricing.delete).toHaveBeenCalledWith({ where: { id: 'sp-1' } });
    });
  });

  describe('listServicePricing', () => {
    it('filters by service name when q is supplied', async () => {
      const { svc, prisma } = makeService();
      await svc.listServicePricing('AC');
      expect(prisma.servicePricing.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { service: { name: { contains: 'AC', mode: 'insensitive' } } },
      }));
    });
  });
});
