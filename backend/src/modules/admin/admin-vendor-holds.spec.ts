import { AdminService } from './admin.module';

function makeService() {
  const prisma: any = {
    order: {
      findUnique: jest.fn(),
      update: jest.fn(async (args: any) => ({ id: 'order-1', ...args.data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    serviceVendor: { findUnique: jest.fn(), update: jest.fn() },
    partnerHold: { update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })), findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (fn: any) => fn({
      order: prisma.order, serviceVendor: prisma.serviceVendor,
      partnerLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
      partnerHold: prisma.partnerHold,
    })),
  };
  prisma.orderTimeline = { create: jest.fn() };
  const config: any = { get: jest.fn((_key: string, def: any) => def) };
  const payments: any = {};
  const settlements: any = {};
  const cities: any = {};
  const events: any = { emit: jest.fn() };
  const ledger: any = {
    refundLeadCost: jest.fn().mockResolvedValue({}),
    postHold: jest.fn().mockResolvedValue({ id: 'hold-1' }),
    releaseHold: jest.fn().mockResolvedValue({}),
    forfeitHold: jest.fn().mockResolvedValue({}),
  };
  const svc = new AdminService(prisma, config, payments, settlements, cities, events, ledger, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma, ledger };
}

describe('AdminService.adminCancelOrder — Lead Cost refund', () => {
  it('refunds an already-charged Lead Cost when admin cancels an order', async () => {
    const { svc, prisma, ledger } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', vendorId: 'vendor-1', leadCostAmount: 50, leadCostRefunded: false });

    await svc.adminCancelOrder('order-1', 'Customer requested via support');

    expect(ledger.refundLeadCost).toHaveBeenCalledWith(expect.anything(), 'vendor-1', 'order-1', 50);
  });

  it('does not double-refund if the customer cancel path already refunded it', async () => {
    const { svc, prisma, ledger } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', vendorId: 'vendor-1', leadCostAmount: 50, leadCostRefunded: true });
    prisma.order.updateMany.mockResolvedValue({ count: 0 }); // real DB: WHERE leadCostRefunded:false matches nothing

    await svc.adminCancelOrder('order-1', 'Duplicate cancel attempt');

    expect(ledger.refundLeadCost).not.toHaveBeenCalled();
  });
});

describe('AdminService Base Hold + hold management', () => {
  it('setVendorBaseHold rejects a negative amount', async () => {
    const { svc } = makeService();
    await expect(svc.setVendorBaseHold('vendor-1', -1)).rejects.toThrow();
  });

  it('setVendorBaseHold updates the stored floor', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.update.mockResolvedValue({ id: 'vendor-1', baseHoldAmount: 2000 });
    await svc.setVendorBaseHold('vendor-1', 2000);
    expect(prisma.serviceVendor.update).toHaveBeenCalledWith({ where: { id: 'vendor-1' }, data: { baseHoldAmount: 2000 } });
  });

  it('createAdminHold rejects a vendor that does not exist', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue(null);
    await expect(svc.createAdminHold('missing-vendor', 500, 'admin-1')).rejects.toThrow();
  });

  it('createAdminHold posts an ADMIN_MANUAL hold via the ledger', async () => {
    const { svc, prisma, ledger } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1' });
    await svc.createAdminHold('vendor-1', 500, 'admin-1', 'Fraud investigation');
    expect(ledger.postHold).toHaveBeenCalledWith(expect.anything(), 'vendor-1', 'ADMIN_MANUAL', 500, { createdBy: 'admin-1', notes: 'Fraud investigation' });
  });

  it('releaseHold and forfeitHold delegate to the ledger service', async () => {
    const { svc, ledger } = makeService();
    await svc.releaseHold('hold-1', 'admin-1');
    expect(ledger.releaseHold).toHaveBeenCalledWith(expect.anything(), 'hold-1', 'admin-1');
    await svc.forfeitHold('hold-1', 'reason');
    expect(ledger.forfeitHold).toHaveBeenCalledWith(expect.anything(), 'hold-1', 'reason');
  });

  it('extendHold rejects an invalid date', async () => {
    const { svc } = makeService();
    await expect(svc.extendHold('hold-1', 'not-a-date')).rejects.toThrow();
  });
});
