import { ProductsService } from './products.module';

// The homepage's "Related Products" strip under each service category.
function makeService() {
  const prodCats = [
    { id: 'pc-ac', key: 'AC-HVAC' }, { id: 'pc-pl', key: 'PLUMBING' }, { id: 'pc-paint', key: 'PAINT' },
    { id: 'pc-tools', key: 'TOOLS' }, { id: 'pc-clean', key: 'CLEANING_SUPPLIES' },
  ];
  const products = [
    { id: 'p-ac', name: 'Split AC 1.5 Ton', categoryId: 'pc-ac' },
    { id: 'p-stand', name: 'AC Outdoor Stand', categoryId: 'pc-ac' },
    { id: 'p-tap', name: 'Mixer Tap', categoryId: 'pc-pl' },
    { id: 'p-paint', name: 'Emulsion 20L', categoryId: 'pc-paint' },
    { id: 'p-saw', name: 'Hand Saw', categoryId: 'pc-tools' },
    { id: 'p-mop', name: 'Floor Mop', categoryId: 'pc-clean' },
  ];
  const prisma = {
    serviceCategory: { findMany: jest.fn(async () => [
      { key: 'AC_SERVICE', slug: 'ac-service-repair' }, { key: 'PLUMBING', slug: 'plumbing' },
      { key: 'PEST_CONTROL', slug: 'pest-control' }, { key: 'CARPENTRY', slug: 'carpentry-woodwork' },
    ]) },
    productCategory: { findMany: jest.fn(async () => prodCats) },
    product: { findMany: jest.fn(async ({ where }: any) => products.filter((p) => where.categoryId.in.includes(p.categoryId))) },
  };
  return { svc: new ProductsService(prisma as any, {} as any), prisma };
}

describe('ProductsService.listGroupedByCategories — only products linked to the service category', () => {
  it('AC → AC/HVAC products, Plumbing → plumbing products, Carpentry → tools; keys match case-insensitively', async () => {
    const { svc } = makeService();
    const g: any = await svc.listGroupedByCategories(['AC_SERVICE', 'PLUMBING', 'CARPENTRY'], 4);
    expect(g.AC_SERVICE.map((p: any) => p.id)).toEqual(['p-ac', 'p-stand']);
    expect(g.PLUMBING.map((p: any) => p.id)).toEqual(['p-tap']);
    expect(g.CARPENTRY.map((p: any) => p.id)).toEqual(['p-saw']);
  });

  it('a category with no linked products gets none — never random products', async () => {
    const { svc } = makeService();
    const g: any = await svc.listGroupedByCategories(['PEST_CONTROL'], 4);
    expect(g.PEST_CONTROL).toEqual([]);
  });

  it('respects the per-category limit', async () => {
    const { svc } = makeService();
    const g: any = await svc.listGroupedByCategories(['AC_SERVICE'], 1);
    expect(g.AC_SERVICE).toHaveLength(1);
  });
});
