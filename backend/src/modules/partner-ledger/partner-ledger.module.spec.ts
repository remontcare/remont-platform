import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PartnerLedgerService } from './partner-ledger.module';

/**
 * Vendor Wallet: Base Hold withdrawal floor, Warranty/Admin holds, and Lead Cost —
 * the "single ledger architecture" additions. Every hold/lead-cost method takes an explicit
 * tx client (never opens its own), same convention as the pre-existing postEntry().
 */
function makeTx(overrides: Record<string, any> = {}) {
  return {
    // Tagged-template mock for the SELECT ... FOR UPDATE row lock postEntry() takes before
    // reading the last balance — see the race-condition fix comment on postEntry() itself.
    $queryRaw: jest.fn(),
    partnerLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(async (args: any) => args.data) },
    partnerHold: {
      create: jest.fn(async (args: any) => ({ id: 'hold-1', ...args.data })),
      findUnique: jest.fn(),
      update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    serviceVendor: { update: jest.fn() },
    ...overrides,
  };
}

function makeService() {
  const prisma: any = {
    siteSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    serviceVendor: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    partnerLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null) },
    withdrawalRequest: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }) },
  };
  const service = new PartnerLedgerService(prisma);
  return { service, prisma };
}

describe('PartnerLedgerService config resolvers', () => {
  it('falls back to hardcoded defaults when a SiteSetting row is missing', async () => {
    const { service } = makeService();
    await expect(service.getBaseHoldDefault()).resolves.toBe(1000);
    await expect(service.getLeadCostAmount()).resolves.toBe(50);
    await expect(service.getWarrantyDefaults(null)).resolves.toEqual({ days: 7, percent: 15 });
  });

  it('reads the configured SiteSetting value when present', async () => {
    const { service, prisma } = makeService();
    prisma.siteSetting.findUnique.mockResolvedValue({ value: '2000' });
    await expect(service.getBaseHoldDefault()).resolves.toBe(2000);
  });

  it('prefers a category-level warranty override over the global default', async () => {
    const { service, prisma } = makeService();
    prisma.siteSetting.findUnique.mockResolvedValue({ value: '7' });
    await expect(service.getWarrantyDefaults({ warrantyDays: 30, warrantyHoldPercent: 20 }))
      .resolves.toEqual({ days: 30, percent: 20 });
  });
});

describe('PartnerLedgerService holds', () => {
  it('postHold creates a HELD PartnerHold and posts a HOLD debit', async () => {
    const { service } = makeService();
    const tx = makeTx();
    await service.postHold(tx, 'vendor-1', 'WARRANTY_HOLD' as any, 150, { orderId: 'order-1' });
    expect(tx.partnerHold.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ vendorId: 'vendor-1', amount: 150, remaining: 150, orderId: 'order-1' }),
    }));
    expect(tx.partnerLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'HOLD', amount: -150 }),
    }));
  });

  it('releaseHold credits HOLD_RELEASE for the remaining amount and closes the hold', async () => {
    const { service } = makeService();
    const tx = makeTx();
    tx.partnerHold.findUnique.mockResolvedValue({ id: 'hold-1', vendorId: 'vendor-1', remaining: 150, status: 'HELD', orderId: 'order-1' });
    await service.releaseHold(tx, 'hold-1', 'admin-1');
    expect(tx.partnerLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'HOLD_RELEASE', amount: 150 }),
    }));
    expect(tx.serviceVendor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { pendingPayout: { increment: 150 } },
    }));
    expect(tx.partnerHold.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'hold-1', status: 'HELD' }),
      data: expect.objectContaining({ status: 'RELEASED', remaining: 0 }),
    }));
  });

  it('releaseHold rejects a hold that is not currently HELD', async () => {
    const { service } = makeService();
    const tx = makeTx();
    tx.partnerHold.findUnique.mockResolvedValue({ id: 'hold-1', status: 'RELEASED', remaining: 0 });
    // Simulates the real DB: an updateMany conditioned on status:HELD matches zero rows
    // once the hold is no longer HELD (also covers the concurrent-release race).
    tx.partnerHold.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.releaseHold(tx, 'hold-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.partnerLedgerEntry.create).not.toHaveBeenCalled();
  });

  it('releaseHold is safe when two callers race the same matured hold — only one wins', async () => {
    const { service } = makeService();
    const tx = makeTx();
    tx.partnerHold.findUnique.mockResolvedValue({ id: 'hold-1', vendorId: 'vendor-1', remaining: 150, status: 'HELD', orderId: 'order-1' });
    tx.partnerHold.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await service.releaseHold(tx, 'hold-1', 'admin-1');
    await expect(service.releaseHold(tx, 'hold-1', 'cron-sweep')).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.partnerLedgerEntry.create).toHaveBeenCalledTimes(1); // only the winner posted a HOLD_RELEASE credit
  });

  it('releaseHold on an unknown hold throws NotFoundException', async () => {
    const { service } = makeService();
    const tx = makeTx();
    tx.partnerHold.findUnique.mockResolvedValue(null);
    await expect(service.releaseHold(tx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('forfeitHold closes the hold with no ledger credit', async () => {
    const { service } = makeService();
    const tx = makeTx();
    tx.partnerHold.findUnique.mockResolvedValue({ id: 'hold-1', status: 'HELD', remaining: 150 });
    await service.forfeitHold(tx, 'hold-1', 'proven fraud');
    expect(tx.partnerLedgerEntry.create).not.toHaveBeenCalled();
    expect(tx.partnerHold.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'hold-1', status: 'HELD' }),
      data: expect.objectContaining({ status: 'FORFEITED', remaining: 0 }),
    }));
  });

  it('deductFromHold caps the deduction at what remains held', async () => {
    const { service } = makeService();
    const tx = makeTx();
    tx.partnerHold.findUnique.mockResolvedValue({ id: 'hold-1', status: 'HELD', remaining: 100 });
    await service.deductFromHold(tx, 'hold-1', 250); // refund bigger than the hold
    expect(tx.partnerHold.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'hold-1', status: 'HELD', remaining: 100 }),
      data: expect.objectContaining({ remaining: 0, status: 'FORFEITED' }),
    }));
  });

  it('deductFromHold partially reduces remaining without closing the hold', async () => {
    const { service } = makeService();
    const tx = makeTx();
    tx.partnerHold.findUnique.mockResolvedValue({ id: 'hold-1', status: 'HELD', remaining: 100 });
    await service.deductFromHold(tx, 'hold-1', 40);
    expect(tx.partnerHold.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { remaining: 60 },
    }));
  });

  it('deductFromHold rejects when the hold was concurrently modified (optimistic lock)', async () => {
    const { service } = makeService();
    const tx = makeTx();
    tx.partnerHold.findUnique.mockResolvedValue({ id: 'hold-1', status: 'HELD', remaining: 100 });
    tx.partnerHold.updateMany.mockResolvedValue({ count: 0 }); // another caller already changed it
    await expect(service.deductFromHold(tx, 'hold-1', 40)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PartnerLedgerService Lead Cost', () => {
  it('postLeadCost posts a negative LEAD_COST entry', async () => {
    const { service } = makeService();
    const tx = makeTx();
    await service.postLeadCost(tx, 'vendor-1', 'order-1', 50);
    expect(tx.partnerLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'LEAD_COST', amount: -50, orderId: 'order-1' }),
    }));
  });

  it('refundLeadCost posts a positive LEAD_COST entry', async () => {
    const { service } = makeService();
    const tx = makeTx();
    await service.refundLeadCost(tx, 'vendor-1', 'order-1', 50);
    expect(tx.partnerLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'LEAD_COST', amount: 50 }),
    }));
  });

  it('trueUpCommission posts nothing when the remaining commission is zero', async () => {
    const { service } = makeService();
    const tx = makeTx();
    const result = await service.trueUpCommission(tx, 'vendor-1', 'order-1', 0);
    expect(result).toBeNull();
    expect(tx.partnerLedgerEntry.create).not.toHaveBeenCalled();
  });

  it('trueUpCommission posts a negative COMMISSION entry for the remainder', async () => {
    const { service } = makeService();
    const tx = makeTx();
    await service.trueUpCommission(tx, 'vendor-1', 'order-1', 50);
    expect(tx.partnerLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'COMMISSION', amount: -50 }),
    }));
  });
});

describe('PartnerLedgerService.availableBalance — Base Hold floor', () => {
  it('subtracts the vendor\'s baseHoldAmount before reporting what is withdrawable', async () => {
    const { service, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ isAgencyOwner: false, baseHoldAmount: 1000 });
    prisma.partnerLedgerEntry.findFirst.mockResolvedValue({ balanceAfter: 1150 });
    await expect(service.availableBalance('vendor-1')).resolves.toBe(150);
  });

  it('floors available balance at zero when the ledger balance is below the Base Hold', async () => {
    const { service, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ isAgencyOwner: false, baseHoldAmount: 1000 });
    prisma.partnerLedgerEntry.findFirst.mockResolvedValue({ balanceAfter: 950 }); // a Lead Cost dip below the floor
    await expect(service.availableBalance('vendor-1')).resolves.toBe(0);
  });

  it('applies each agency member\'s own Base Hold floor before pooling into the owner\'s available balance', async () => {
    const { service, prisma } = makeService();
    // Owner: balance 2000, baseHold 1000 -> available 1000. Member: balance 900, baseHold 1000 -> available 0
    // (not -100 — pooling must never let the owner borrow against a member's unmet floor).
    prisma.serviceVendor.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === 'owner-1') return Promise.resolve({ isAgencyOwner: true, baseHoldAmount: 1000 });
      return Promise.resolve({ baseHoldAmount: 1000 });
    });
    prisma.serviceVendor.findMany.mockResolvedValue([{ id: 'member-1' }]);
    prisma.partnerLedgerEntry.findFirst.mockImplementation(({ where }: any) => {
      if (where.vendorId === 'owner-1') return Promise.resolve({ balanceAfter: 2000 });
      return Promise.resolve({ balanceAfter: 900 });
    });
    await expect(service.availableBalance('owner-1')).resolves.toBe(1000);
  });
});
