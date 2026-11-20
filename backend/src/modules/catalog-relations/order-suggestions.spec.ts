import { CatalogRelationsService } from './catalog-relations.module';
import { scoreAuto, Candidate } from './order-suggestions';

// Names below are real live-catalog rows (2026-11-06), so the ranking is tested on what customers see.
const P = (id: string, name: string, categoryKey: string, price: number): Candidate => ({ kind: 'PRODUCT', id, name, categoryKey, price });
const S = (id: string, name: string, categoryKey: string): Candidate => ({ kind: 'SERVICE', id, name, categoryKey, price: 0 });
const catalog: Candidate[] = [
  P('mixer1', 'Jaquar Solo Single Lever Basin Mixer', 'PLUMBING', 2400),
  P('mixer2', 'Cera Fountain Single Lever Basin Mixer', 'PLUMBING', 1900),
  P('pipe', 'Astral CPVC Pro Pipe 3/4 inch (3m)', 'PLUMBING', 300),
  P('pipe2', 'Supreme CPVC Pipe 1" (3m)', 'PLUMBING', 350),
  P('tank', 'Sintex Triple-Layer HDPE Water Tank 1000L', 'PLUMBING', 7000),
  P('toilet', 'Kohler Span Wall-Mount Toilet', 'PLUMBING', 18000),
  P('ac2', 'LG 1.5T 3-Star Dual Inverter AC', 'AC-HVAC', 38000),
  P('stab', 'V-Guard 4kVA AC Voltage Stabilizer', 'AC-HVAC', 3200),
  P('cooler', 'Crompton Ozone 75L Desert Air Cooler', 'AC-HVAC', 9000),
  P('mcb', 'Havells 32A Single Pole MCB', 'ELECTRICAL', 250),
  P('fan', 'Orient Electric Rapid Air 1200mm Ceiling Fan', 'ELECTRICAL', 2000),
  S('inst15', 'Split AC Installation (1.5 Ton)', 'ac-service-repair'),
  S('inst1', 'Window AC Installation', 'ac-service-repair'),
  S('uninst', 'Split AC Uninstallation', 'ac-service-repair'),
  S('gas', 'AC Gas Filling / Top-Up (R32/R410, 1.5 Ton)', 'ac-service-repair'),
  S('stabInst', 'AC Stabilizer Installation', 'ac-service-repair'),
  S('wallMixer', 'Wall Mixer Installation', 'plumbing'),
];

describe('AUTO suggestions (no admin relations configured)', () => {
  it('Mixer service → the mixers first, then a few cheapest plumbing materials; nothing from other categories', () => {
    const r = scoreAuto([{ kind: 'SERVICE', id: 'x', name: 'Single Lever Basin Mixer Installation', categoryKey: 'plumbing' }], catalog);
    const ids = r.map((x) => x.id);
    expect(ids.slice(0, 2).sort()).toEqual(['mixer1', 'mixer2']);
    expect(ids.slice(2)).toEqual(['pipe', 'pipe2', 'tank']); // 3 cheapest supporting materials
    expect(ids).not.toContain('mcb');
    expect(r[0].forName).toBe('Single Lever Basin Mixer Installation');
  });

  it('a new split AC → its installation service first, plus stabilizer and MCB; never another AC, a cooler, repair or uninstall', () => {
    const r = scoreAuto([{ kind: 'PRODUCT', id: 'ac', name: 'Daikin 1.5 Ton 3 Star Inverter Split AC', categoryKey: 'AC-HVAC' }], catalog);
    const ids = r.map((x) => x.id);
    expect(ids[0]).toBe('inst15');
    expect(r[0].relationType).toBe('INSTALLATION_SERVICE');
    expect(ids).toEqual(expect.arrayContaining(['inst1', 'stabInst', 'stab', 'mcb']));
    for (const no of ['ac2', 'cooler', 'fan', 'uninst', 'gas', 'wallMixer']) expect(ids).not.toContain(no);
  });

  it('an unmapped category gets no AUTO suggestions (nothing is guessed)', () => {
    expect(scoreAuto([{ kind: 'SERVICE', id: 'x', name: 'Cockroach Control', categoryKey: 'pest-control' }], catalog)).toEqual([]);
  });
});

describe('suggestionsForMyOrders', () => {
  const mk = (over: any = {}) => {
    const prisma: any = {
      order: { findMany: jest.fn(async () => over.orders ?? [{
        id: 'o1', masterOrderId: 'm1', masterOrder: { masterOrderNumber: 'RM-1' }, address: { city: 'Delhi' },
        service: { id: 'svcMixer', name: 'Single Lever Basin Mixer Installation', category: { key: 'PLUMBING', slug: 'plumbing', isActive: true } },
        serviceItems: [], items: [],
      }]) },
      catalogRelation: { findMany: jest.fn(async () => over.edges ?? []) },
      productCategory: { findMany: jest.fn(async () => [{ id: 'pc1', key: 'PLUMBING' }]) },
      serviceCategory: { findMany: jest.fn(async () => []) },
      product: { findMany: jest.fn(async () => over.products ?? [
        { id: 'mixer1', name: 'Jaquar Solo Single Lever Basin Mixer', price: 2400, unit: 'piece', images: ['https://x/m.jpg'], vendorId: 'v1', coverageType: 'PAN_INDIA', category: { key: 'PLUMBING', name: 'Plumbing' }, vendor: { city: 'Pune' } },
        { id: 'pick', name: 'Cera Single Lever Basin Mixer', price: 1900, unit: 'piece', images: [], vendorId: 'v2', coverageType: 'STORE_PICKUP', category: { key: 'PLUMBING', name: 'Plumbing' }, vendor: { city: 'Pune' } },
      ]) },
      service: { findMany: jest.fn(async () => over.services ?? []) },
      city: { findMany: jest.fn(async () => [{ id: 'c1', name: 'Delhi' }]) },
      cityProduct: { findMany: jest.fn(async () => []) },
      cityService: { findMany: jest.fn(async () => []) },
    };
    return { prisma, svc: new CatalogRelationsService(prisma) };
  };

  it('only asks for the customer\'s own open, not-yet-invoiced orders', async () => {
    const { prisma, svc } = mk();
    await svc.suggestionsForMyOrders('cust1');
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.customerId).toBe('cust1');
    expect(where.invoice).toEqual({ is: null });
    expect(where.status.notIn).toEqual(expect.arrayContaining(['PENDING_PAYMENT', 'CANCELLED', 'REFUNDED', 'INVOICED', 'CLOSED']));
    // only sellable rows are ever loaded
    expect(prisma.product.findMany.mock.calls[0][0].where).toMatchObject({ isActive: true, stock: { gt: 0 }, category: { isActive: true } });
  });

  it('returns real rows with real prices, grouped per checkout, and drops a product not sold in the order\'s city', async () => {
    const { svc } = mk();
    const r = await svc.suggestionsForMyOrders('cust1');
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ key: 'm1', masterOrderNumber: 'RM-1', orderIds: ['o1'] });
    expect(r.groups[0].items.map((i: any) => i.id)).toEqual(['mixer1']); // Pune store-pickup item hidden for Delhi
    expect(r.groups[0].items[0]).toMatchObject({ kind: 'PRODUCT', price: 2400, vendorId: 'v1', source: 'AUTO', forName: 'Single Lever Basin Mixer Installation' });
  });

  it('admin-curated relations win and replace AUTO for that item; items already in the order are never suggested', async () => {
    const { svc } = mk({
      edges: [
        { fromType: 'SERVICE', fromId: 'svcMixer', toType: 'PRODUCT', toId: 'tap', relationType: 'REQUIRED', sortOrder: 0 },
        { fromType: 'PRODUCT', fromId: 'svcMixer', toType: 'SERVICE', toId: 'svcMixer', relationType: 'RELATED', sortOrder: 0 },
      ],
      products: [
        { id: 'tap', name: 'Angle Valve', price: 150, unit: 'piece', images: [], vendorId: null, coverageType: 'PAN_INDIA', category: { key: 'PLUMBING', name: 'Plumbing' }, vendor: null },
        { id: 'mixer1', name: 'Jaquar Solo Single Lever Basin Mixer', price: 2400, unit: 'piece', images: [], vendorId: 'v1', coverageType: 'PAN_INDIA', category: { key: 'PLUMBING', name: 'Plumbing' }, vendor: null },
      ],
    });
    const r = await svc.suggestionsForMyOrders('cust1');
    expect(r.groups[0].items.map((i: any) => [i.id, i.source, i.relationType])).toEqual([['tap', 'CURATED', 'REQUIRED']]);
  });

  it('the same product listed by two sellers is suggested once', async () => {
    const row = (id: string, vendorId: string) => ({ id, name: 'Jaquar Solo Single Lever Basin Mixer', price: 2400, unit: 'piece', images: [], vendorId, coverageType: 'PAN_INDIA', category: { key: 'PLUMBING', name: 'Plumbing' }, vendor: null });
    const { svc } = mk({ products: [row('a', 'v1'), row('b', 'v2')] });
    const r = await svc.suggestionsForMyOrders('cust1');
    expect(r.groups[0].items).toHaveLength(1);
  });

  it('no open orders → no groups, and nothing else is queried', async () => {
    const { prisma, svc } = mk({ orders: [] });
    expect(await svc.suggestionsForMyOrders('cust1')).toEqual({ groups: [] });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });
});
