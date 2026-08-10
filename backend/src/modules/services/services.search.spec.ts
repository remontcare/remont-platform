import { ServicesService } from './services.module';

function makePrisma(literalResults: any[] = [], categoryResults: any[] = []) {
  let call = 0;
  return {
    service: {
      findMany: jest.fn(async (args: any) => {
        call++;
        // First call is always the literal substring search; second (if reached)
        // is the category fallback — matches the two-step order in search().
        return call === 1 ? literalResults : categoryResults;
      }),
    },
  };
}

describe('ServicesService.search() — category fallback for natural-language queries', () => {
  it('a literal substring match short-circuits the fallback entirely (zero behavior change for exact matches)', async () => {
    const prisma = makePrisma([{ id: 'svc-1', name: 'AC Repair & Diagnosis' }]);
    const svc = new ServicesService(prisma as any, {} as any);
    const result = await svc.search('AC Repair');
    expect(result).toEqual([{ id: 'svc-1', name: 'AC Repair & Diagnosis' }]);
    expect(prisma.service.findMany).toHaveBeenCalledTimes(1);
  });

  it('"AC cooling nahi kar raha" falls back to the AC_SERVICE category', async () => {
    const prisma = makePrisma([], [{ id: 'svc-1', name: '🛠️ AC Repair & Diagnosis', category: { key: 'AC_SERVICE' } }]);
    const svc = new ServicesService(prisma as any, {} as any);
    const result = await svc.search('AC cooling nahi kar raha');
    expect(result).toHaveLength(1);
    const whereArg = prisma.service.findMany.mock.calls[1][0].where;
    expect(whereArg.category.key.in).toEqual(['AC_SERVICE']);
  });

  it('"AC servicing karwani hai" also falls back to AC_SERVICE', async () => {
    const prisma = makePrisma([], [{ id: 'svc-1' }]);
    const svc = new ServicesService(prisma as any, {} as any);
    await svc.search('AC servicing karwani hai');
    expect(prisma.service.findMany.mock.calls[1][0].where.category.key.in).toEqual(['AC_SERVICE']);
  });

  it('"bathroom pipe leak hai" falls back to PLUMBING', async () => {
    const prisma = makePrisma([], [{ id: 'svc-1' }]);
    const svc = new ServicesService(prisma as any, {} as any);
    await svc.search('bathroom pipe leak hai');
    expect(prisma.service.findMany.mock.calls[1][0].where.category.key.in).toEqual(['PLUMBING']);
  });

  it('"ghar ki wiring problem hai" falls back to ELECTRICAL', async () => {
    const prisma = makePrisma([], [{ id: 'svc-1' }]);
    const svc = new ServicesService(prisma as any, {} as any);
    await svc.search('ghar ki wiring problem hai');
    expect(prisma.service.findMany.mock.calls[1][0].where.category.key.in).toEqual(['ELECTRICAL']);
  });

  it('"2BHK interior karwana hai" falls back to INTERIOR (both key casings)', async () => {
    const prisma = makePrisma([], [{ id: 'svc-1' }]);
    const svc = new ServicesService(prisma as any, {} as any);
    await svc.search('2BHK interior karwana hai');
    expect(prisma.service.findMany.mock.calls[1][0].where.category.key.in).toEqual(['INTERIOR', 'interior']);
  });

  it('"ghar renovate karna hai" falls back to RENOVATION', async () => {
    const prisma = makePrisma([], [{ id: 'svc-1' }]);
    const svc = new ServicesService(prisma as any, {} as any);
    await svc.search('ghar renovate karna hai');
    expect(prisma.service.findMany.mock.calls[1][0].where.category.key.in).toEqual(['RENOVATION', 'renovation']);
  });

  it('"naya ghar banana hai" falls back to CONSTRUCTION, not RENOVATION (the fixed tie-break)', async () => {
    const prisma = makePrisma([], [{ id: 'svc-1' }]);
    const svc = new ServicesService(prisma as any, {} as any);
    await svc.search('naya ghar banana hai');
    expect(prisma.service.findMany.mock.calls[1][0].where.category.key.in).toEqual(['CONSTRUCTION', 'construction']);
  });

  it('an unmapped/unknown intent returns empty rather than guessing', async () => {
    const prisma = makePrisma([], []);
    const svc = new ServicesService(prisma as any, {} as any);
    const result = await svc.search('asdkjaslkdj random gibberish');
    expect(result).toEqual([]);
    expect(prisma.service.findMany).toHaveBeenCalledTimes(1); // never even tried the category query
  });
});
