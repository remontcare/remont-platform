import { BadRequestException } from '@nestjs/common';
import { ReverseLogisticsRateEngine } from './reverse-logistics-rate-engine';

/**
 * Phase 6 — must never default to fastest/express: orders by cost first, priority only as a
 * tiebreaker, and never picks an inactive or COD-incapable provider when COD is required.
 */
function makeEngine() {
  const prisma: any = {
    logisticsProvider: { count: jest.fn().mockResolvedValue(1), createMany: jest.fn(), findFirst: jest.fn() },
  };
  const engine = new ReverseLogisticsRateEngine(prisma);
  return { engine, prisma };
}

describe('ReverseLogisticsRateEngine.pickCheapest', () => {
  it('queries active providers ordered by cost ascending, priority as tiebreaker', async () => {
    const { engine, prisma } = makeEngine();
    prisma.logisticsProvider.findFirst.mockResolvedValue({ id: 'p-economy', baseCost: 55 });
    const picked = await engine.pickCheapest();
    expect(prisma.logisticsProvider.findFirst).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ baseCost: 'asc' }, { priority: 'asc' }],
    });
    expect(picked.id).toBe('p-economy');
  });

  it('filters to COD-capable providers when requiresCod is set', async () => {
    const { engine, prisma } = makeEngine();
    prisma.logisticsProvider.findFirst.mockResolvedValue({ id: 'p-cod', baseCost: 70 });
    await engine.pickCheapest({ requiresCod: true });
    expect(prisma.logisticsProvider.findFirst).toHaveBeenCalledWith({
      where: { isActive: true, supportsCod: true },
      orderBy: [{ baseCost: 'asc' }, { priority: 'asc' }],
    });
  });

  it('throws when no active eligible provider exists', async () => {
    const { engine, prisma } = makeEngine();
    prisma.logisticsProvider.findFirst.mockResolvedValue(null);
    await expect(engine.pickCheapest()).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ReverseLogisticsRateEngine.onModuleInit', () => {
  it('seeds default providers only when none exist yet (idempotent)', async () => {
    const prisma: any = { logisticsProvider: { count: jest.fn().mockResolvedValue(0), createMany: jest.fn(), findFirst: jest.fn() } };
    const engine = new ReverseLogisticsRateEngine(prisma);
    await engine.onModuleInit();
    expect(prisma.logisticsProvider.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([expect.objectContaining({ name: 'Mock Economy', baseCost: 55 })]),
    });
  });

  it('does not reseed when providers already exist', async () => {
    const { engine, prisma } = makeEngine(); // count() resolves to 1
    await engine.onModuleInit();
    expect(prisma.logisticsProvider.createMany).not.toHaveBeenCalled();
  });
});
