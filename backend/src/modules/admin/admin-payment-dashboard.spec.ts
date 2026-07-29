import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.module';

function makeService() {
  const prisma: any = {
    paymentTransaction: {
      aggregate: jest.fn(async () => ({ _sum: { amount: 0 }, _count: 0 })),
      findMany: jest.fn(async () => []),
    },
    order: {
      aggregate: jest.fn(async () => ({ _sum: { totalAmount: 0, walletUsed: 0 }, _count: 0 })),
      groupBy: jest.fn(async () => []),
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(),
    },
    refundRequest: { aggregate: jest.fn(async () => ({ _sum: { approvedAmount: 0 }, _count: 0 })), findMany: jest.fn(async () => []) },
    partnerSettlement: { aggregate: jest.fn(async () => ({ _sum: { amount: 0 }, _count: 0 })), findMany: jest.fn(async () => []) },
    serviceVendor: { findUnique: jest.fn() },
  };
  const config: any = { get: jest.fn((_k: string, def: any) => def) };
  const payments: any = {};
  const settlements: any = {};
  const cities: any = {};
  const events: any = { emit: jest.fn() };
  const ledger: any = { postEntry: jest.fn(async () => {}), availableBalance: jest.fn(async () => 0) };
  return { svc: new AdminService(prisma, config, payments, settlements, cities, events, ledger), prisma };
}

describe('AdminService.paymentDashboard — Section 9 complete payment management', () => {
  it('reports outstanding amount as pending order totals minus wallet-covered amount', async () => {
    const { svc, prisma } = makeService();
    prisma.order.aggregate.mockResolvedValue({ _sum: { totalAmount: 5000, walletUsed: 800 }, _count: 3 });
    const dash = await svc.paymentDashboard({});
    expect(dash.outstandingAmount).toBe(4200);
    expect(dash.pendingCollection.count).toBe(3);
  });

  it('never reports a negative outstanding amount', async () => {
    const { svc, prisma } = makeService();
    prisma.order.aggregate.mockResolvedValue({ _sum: { totalAmount: 100, walletUsed: 500 }, _count: 1 });
    const dash = await svc.paymentDashboard({});
    expect(dash.outstandingAmount).toBe(0);
  });

  it('buckets the collection trend by day when no bucket is specified', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findMany.mockResolvedValue([
      { totalAmount: 100, createdAt: new Date('2026-01-05T10:00:00Z') },
      { totalAmount: 200, createdAt: new Date('2026-01-05T18:00:00Z') },
      { totalAmount: 50, createdAt: new Date('2026-01-06T09:00:00Z') },
    ]);
    const dash = await svc.paymentDashboard({});
    expect(dash.trend).toEqual([
      { period: '2026-01-05', amount: 300 },
      { period: '2026-01-06', amount: 50 },
    ]);
  });

  it('buckets by month when bucket=month', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findMany.mockResolvedValue([
      { totalAmount: 100, createdAt: new Date('2026-01-05T10:00:00Z') },
      { totalAmount: 200, createdAt: new Date('2026-01-25T10:00:00Z') },
      { totalAmount: 50, createdAt: new Date('2026-02-01T10:00:00Z') },
    ]);
    const dash = await svc.paymentDashboard({ bucket: 'month' });
    expect(dash.trend).toEqual([
      { period: '2026-01', amount: 300 },
      { period: '2026-02', amount: 50 },
    ]);
  });
});

describe('AdminService.getOrderLedger', () => {
  it('rejects an unknown order', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(null);
    await expect(svc.getOrderLedger('missing')).rejects.toThrow(NotFoundException);
  });

  it('computes paidAmount from PAID transactions only and balanceDue against the current total', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000, walletUsed: 100 });
    prisma.paymentTransaction.findMany.mockResolvedValue([
      { id: 'tx1', amount: 400, status: 'PAID' },
      { id: 'tx2', amount: 200, status: 'FAILED' },
    ]);
    const ledger = await svc.getOrderLedger('o1');
    expect(ledger.summary.paidAmount).toBe(400);
    expect(ledger.summary.balanceDue).toBe(500); // 1000 - 400 - 100
  });
});

describe('AdminService.getPartnerLedger', () => {
  it('rejects an unknown partner', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue(null);
    await expect(svc.getPartnerLedger('missing')).rejects.toThrow(NotFoundException);
  });

  it('returns the vendor summary alongside settlements and completed orders', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'v1', fullName: 'Ravi', totalEarnings: 5000, pendingPayout: 1000 });
    prisma.partnerSettlement.findMany.mockResolvedValue([{ id: 's1', amount: 500 }]);
    prisma.order.findMany.mockResolvedValue([{ id: 'o1', orderNumber: 'REM-1' }]);
    const ledger = await svc.getPartnerLedger('v1');
    expect(ledger.vendor.fullName).toBe('Ravi');
    expect(ledger.settlements).toHaveLength(1);
    expect(ledger.completedOrders).toHaveLength(1);
  });
});
