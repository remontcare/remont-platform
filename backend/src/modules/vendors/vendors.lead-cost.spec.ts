import { ServiceVendorsService } from './vendors.module';

/**
 * Vendor Wallet: Lead Cost is debited the instant a vendor's accept-job claim actually wins
 * the atomic lock — never for a lost race, and always inside the same transaction as the
 * claim so the debit and the assignment can never diverge.
 */
function makeService(leadCostAmount: number) {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn(), update: jest.fn() },
    order: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    orderTimeline: { create: jest.fn().mockResolvedValue({ id: 'timeline-1' }) },
    $transaction: jest.fn(async (fn: any) => fn({
      order: prisma.order,
      serviceVendor: prisma.serviceVendor,
    })),
  };
  const whatsapp: any = { sendJobAssigned: jest.fn().mockResolvedValue(undefined) };
  const events: any = { emit: jest.fn() };
  const ledger: any = {
    getLeadCostAmount: jest.fn().mockResolvedValue(leadCostAmount),
    postLeadCost: jest.fn().mockResolvedValue({}),
  };
  const service = new ServiceVendorsService(prisma, whatsapp, events, ledger);
  return { service, prisma, ledger };
}

const vendor = {
  id: 'vendor-1', userId: 'vendor-user-1', status: 'ACTIVE', memberStatus: null,
  skills: ['PLUMBING'], baseCity: 'Bhopal', serviceRadius: 10, currentLatitude: null, currentLongitude: null,
};

const order = {
  id: 'order-1', vendorId: null, status: 'CONFIRMED',
  service: { category: { key: 'PLUMBING' } }, address: { city: 'Bhopal' },
};

describe('ServiceVendorsService.acceptJob — Lead Cost', () => {
  it('debits the configured Lead Cost and stamps order.leadCostAmount when the claim wins', async () => {
    const { service, prisma, ledger } = makeService(50);
    prisma.serviceVendor.findUnique.mockResolvedValue(vendor);
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUniqueOrThrow.mockResolvedValue({ ...order, vendorId: 'vendor-1', status: 'VENDOR_ASSIGNED', customer: {} });

    await service.acceptJob('vendor-user-1', 'order-1');

    expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: 'order-1' }, data: { leadCostAmount: 50 } });
    expect(ledger.postLeadCost).toHaveBeenCalledWith(expect.anything(), 'vendor-1', 'order-1', 50);
    expect(prisma.serviceVendor.update).toHaveBeenCalledWith({ where: { id: 'vendor-1' }, data: { pendingPayout: { decrement: 50 } } });
  });

  it('skips the Lead Cost debit entirely when the configured amount is 0', async () => {
    const { service, prisma, ledger } = makeService(0);
    prisma.serviceVendor.findUnique.mockResolvedValue(vendor);
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUniqueOrThrow.mockResolvedValue({ ...order, vendorId: 'vendor-1', status: 'VENDOR_ASSIGNED', customer: {} });

    await service.acceptJob('vendor-user-1', 'order-1');

    expect(ledger.postLeadCost).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('posts no Lead Cost when the claim loses the race', async () => {
    const { service, prisma, ledger } = makeService(50);
    prisma.serviceVendor.findUnique.mockResolvedValue(vendor);
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.acceptJob('vendor-user-1', 'order-1')).rejects.toThrow();

    expect(ledger.postLeadCost).not.toHaveBeenCalled();
    expect(prisma.serviceVendor.update).not.toHaveBeenCalled();
  });
});
