import { OrdersService } from './orders.module';

/**
 * Vendor Wallet: job completion true-up (Lead Cost prepaid against commission) and Warranty
 * Hold creation, plus the Lead Cost refund-on-cancellation hook. The leadCostAmount=0 case is
 * the concrete backward-compatibility regression guard — every order that predates this
 * feature (or has the feature disabled) must produce byte-identical ledger/balance effects
 * to what OrdersService.complete() did before this change.
 */
function makeService() {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn(), update: jest.fn() },
    order: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(async () => ({ id: 'order-1', status: 'COMPLETED' })),
      update: jest.fn(async (args: any) => ({ id: 'order-1', ...args.data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (fn: any) => fn({
      order: prisma.order,
      serviceVendor: prisma.serviceVendor,
      partnerLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
      partnerHold: { create: jest.fn().mockResolvedValue({}) },
    })),
  };
  prisma.orderTimeline = { create: jest.fn() };
  prisma.orderOtpLog = { create: jest.fn() };
  const ledger: any = {
    postEntry: jest.fn().mockResolvedValue({}),
    trueUpCommission: jest.fn().mockResolvedValue({}),
    postHold: jest.fn().mockResolvedValue({}),
    refundLeadCost: jest.fn().mockResolvedValue({}),
    getWarrantyDefaults: jest.fn().mockResolvedValue({ days: 7, percent: 0 }), // no warranty cut unless a test opts in
  };
  const paymentNotify: any = { workCompleted: jest.fn().mockResolvedValue({}) };
  const svc = new OrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, paymentNotify, ledger, {} as any, {} as any);
  // autoGenerateInvoice fires-and-forgets against modules not wired up in this unit test —
  // stub it out so it can't throw an unhandled rejection during the test run.
  (svc as any).autoGenerateInvoice = jest.fn().mockResolvedValue(undefined);
  return { svc, prisma, ledger };
}

function baseOrder(overrides: Record<string, any> = {}) {
  return {
    id: 'order-1', vendorId: 'vendor-1', customerId: 'cust-1', guestPhone: null, orderNumber: 'ORD-1',
    status: 'STARTED', endOtp: null, endOtpVerified: false,
    remontCommission: 100, vendorPayout: 900, leadCostAmount: 0,
    service: { category: null },
    ...overrides,
  };
}

describe('OrdersService.complete — Vendor Wallet true-up', () => {
  it('leadCostAmount=0 regresses to the pre-existing behavior: full vendorPayout credited, no COMMISSION debit needed beyond the netted JOB_EARNING', async () => {
    const { svc, prisma, ledger } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'vendor-user-1' });
    prisma.order.findUnique.mockResolvedValue(baseOrder());

    await svc.complete('vendor-user-1', 'order-1', '', []);

    // grossAmount = vendorPayout(900) + fullCommission(100) = 1000; remainingCommission = 100 - 0 = 100
    expect(ledger.postEntry).toHaveBeenCalledWith(expect.anything(), 'vendor-1', 'JOB_EARNING', 1000, { orderId: 'order-1' });
    expect(ledger.trueUpCommission).toHaveBeenCalledWith(expect.anything(), 'vendor-1', 'order-1', 100);
    // Net effect (1000 - 100 = 900) matches today's vendorPayout exactly.
    expect(prisma.serviceVendor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ totalEarnings: { increment: 900 }, pendingPayout: { increment: 900 } }),
    }));
    expect(ledger.postHold).not.toHaveBeenCalled();
  });

  it('trues up the remaining commission when a Lead Cost was already prepaid at accept time', async () => {
    const { svc, prisma, ledger } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'vendor-user-1' });
    // Commission 100, Lead Cost 50 already deducted -> only 50 more should be debited here.
    prisma.order.findUnique.mockResolvedValue(baseOrder({ leadCostAmount: 50 }));

    await svc.complete('vendor-user-1', 'order-1', '', []);

    expect(ledger.postEntry).toHaveBeenCalledWith(expect.anything(), 'vendor-1', 'JOB_EARNING', 1000, { orderId: 'order-1' });
    expect(ledger.trueUpCommission).toHaveBeenCalledWith(expect.anything(), 'vendor-1', 'order-1', 50);
    // completionCredit = 1000 - 50 = 950 (== vendorPayout 900 + leadCostPaid 50)
    expect(prisma.serviceVendor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ totalEarnings: { increment: 900 }, pendingPayout: { increment: 950 } }),
    }));
  });

  it('creates a Warranty Hold for the configured percentage and defers that portion of pendingPayout', async () => {
    const { svc, prisma, ledger } = makeService();
    ledger.getWarrantyDefaults.mockResolvedValue({ days: 7, percent: 15 });
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'vendor-user-1' });
    prisma.order.findUnique.mockResolvedValue(baseOrder());

    await svc.complete('vendor-user-1', 'order-1', '', []);

    // completionCredit = 900; 15% hold = 135; released now = 765
    expect(ledger.postHold).toHaveBeenCalledWith(
      expect.anything(), 'vendor-1', 'WARRANTY_HOLD',
      135, expect.objectContaining({ orderId: 'order-1', releaseDueAt: expect.any(Date) }),
    );
    expect(prisma.serviceVendor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pendingPayout: { increment: 765 } }),
    }));
  });

  it('rejects a second concurrent completion attempt instead of double-crediting the vendor', async () => {
    const { svc, prisma, ledger } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'vendor-user-1' });
    prisma.order.findUnique.mockResolvedValue(baseOrder());
    // Simulates a second request racing in after the first already flipped the status —
    // the conditional updateMany's WHERE no longer matches, so count is 0.
    prisma.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(svc.complete('vendor-user-1', 'order-1', '', [])).rejects.toThrow();

    expect(ledger.postEntry).not.toHaveBeenCalled();
    expect(ledger.trueUpCommission).not.toHaveBeenCalled();
    expect(prisma.serviceVendor.update).not.toHaveBeenCalled();
  });
});

describe('OrdersService.cancel — Lead Cost refund', () => {
  function makeCancelService() {
    const prisma: any = {
      order: {
        findUnique: jest.fn(),
        update: jest.fn(async (args: any) => ({ id: 'order-1', ...args.data })),
        // Defaults to "not yet refunded" matching (count:1) — tests simulating a lost race
        // or an already-refunded order override this to {count:0}, mirroring how Postgres
        // would report zero rows matched once another transaction already flipped the flag.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      serviceVendor: { update: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn({ order: prisma.order, serviceVendor: prisma.serviceVendor })),
    };
    prisma.orderTimeline = { create: jest.fn() };
    const ledger: any = { refundLeadCost: jest.fn().mockResolvedValue({}) };
    const svc = new OrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, ledger, {} as any, {} as any);
    return { svc, prisma, ledger };
  }

  it('refunds an already-charged Lead Cost on customer cancellation', async () => {
    const { svc, prisma, ledger } = makeCancelService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', customerId: 'cust-1', status: 'CONFIRMED', vendorId: 'vendor-1', leadCostAmount: 50, leadCostRefunded: false,
    });

    await svc.cancel('cust-1', 'order-1', 'Changed my mind');

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', leadCostRefunded: false },
      data: { leadCostRefunded: true },
    });
    expect(ledger.refundLeadCost).toHaveBeenCalledWith(expect.anything(), 'vendor-1', 'order-1', 50);
    expect(prisma.serviceVendor.update).toHaveBeenCalledWith({ where: { id: 'vendor-1' }, data: { pendingPayout: { increment: 50 } } });
  });

  it('does not refund twice when leadCostRefunded is already true', async () => {
    const { svc, prisma, ledger } = makeCancelService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', customerId: 'cust-1', status: 'CONFIRMED', vendorId: 'vendor-1', leadCostAmount: 50, leadCostRefunded: true,
    });
    prisma.order.updateMany.mockResolvedValue({ count: 0 }); // real DB: WHERE leadCostRefunded:false matches nothing

    await svc.cancel('cust-1', 'order-1', 'Changed my mind');

    expect(ledger.refundLeadCost).not.toHaveBeenCalled();
  });

  it('does not refund when no vendor was ever assigned (nothing was charged)', async () => {
    const { svc, prisma, ledger } = makeCancelService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', customerId: 'cust-1', status: 'PENDING_PAYMENT', vendorId: null, leadCostAmount: 0, leadCostRefunded: false,
    });

    await svc.cancel('cust-1', 'order-1', 'Changed my mind');

    expect(ledger.refundLeadCost).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('refunds only once when two cancel attempts race — the loser is a silent no-op', async () => {
    const { svc, prisma, ledger } = makeCancelService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', customerId: 'cust-1', status: 'CONFIRMED', vendorId: 'vendor-1', leadCostAmount: 50, leadCostRefunded: false,
    });
    prisma.order.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await svc.cancel('cust-1', 'order-1', 'first attempt');
    await svc.cancel('cust-1', 'order-1', 'racing duplicate attempt');

    expect(ledger.refundLeadCost).toHaveBeenCalledTimes(1);
  });
});
