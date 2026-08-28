import { AdminService } from './admin.module';

function makeService() {
  const prisma: any = {
    serviceVendor: { findMany: jest.fn(async () => []) },
    order: { groupBy: jest.fn(async () => []) },
    paymentTransaction: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    order2: {},
  };
  const config: any = { get: jest.fn((_key: string, def: any) => def) };
  const payments: any = {};
  const settlements: any = { record: jest.fn(async (vendorId: string, amount: number, mode: any, adminId: string, ref?: string, notes?: string) => ({ id: 'settlement-1', vendorId, amount, mode })) };
  const cities: any = {};
  const events: any = { emit: jest.fn() };
  const ledger: any = { postEntry: jest.fn(async () => {}), availableBalance: jest.fn(async () => 0) };
  const svc = new AdminService(prisma, config, payments, settlements, cities, events, ledger, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma, settlements };
}

describe('AdminService.vendorEarningsSummary — closing the "/admin/vendor-earnings 404" gap', () => {
  it('merges pendingPayout, totalPaid, and grouped commission per vendor', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findMany.mockResolvedValue([
      { id: 'v1', fullName: 'Ravi', baseCity: 'Bhopal', totalEarnings: 5000, pendingPayout: 1200, completedJobs: 10, rating: 4.5 },
    ]);
    prisma.order.groupBy.mockResolvedValue([{ vendorId: 'v1', _sum: { remontCommission: 750 } }]);
    const result = await svc.vendorEarningsSummary();
    expect(result).toEqual([{
      vendorId: 'v1', vendorName: 'Ravi', city: 'Bhopal',
      totalEarnings: 5000, pendingPayout: 1200, totalPaid: 3800,
      commission: 750, jobsCompleted: 10, rating: 4.5,
    }]);
  });

  it('filters to vendors with a pending payout when payoutStatus=PENDING', async () => {
    const { svc, prisma } = makeService();
    await svc.vendorEarningsSummary(undefined, 'PENDING');
    expect(prisma.serviceVendor.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ pendingPayout: { gt: 0 } }),
    }));
  });
});

describe('AdminService.vendorPayout — delegates to SettlementsService, the single source of truth', () => {
  it('records the payout via SettlementsService.record with the admin as paidBy', async () => {
    const { svc, settlements } = makeService();
    await svc.vendorPayout('admin-1', 'v1', 500, 'UPI' as any, 'UTR-1', 'note');
    expect(settlements.record).toHaveBeenCalledWith('v1', 500, 'UPI', 'admin-1', 'UTR-1', 'note');
  });
});
