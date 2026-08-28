import { OrdersService } from './orders.module';

/**
 * End-to-end accounting reconciliation for the exact scenarios in the "WALLET + ACCOUNTING
 * LEDGER" production-fix request: an ONLINE job must credit only the vendor's rightful
 * payout (Remont already has the customer's money), while a COD job must net the vendor's
 * payout against the cash they physically collected — leaving Remont's commission correctly
 * recoverable instead of the vendor being credited their payout AND keeping the full cash in
 * hand (a real double-count this session's audit found and fixed).
 *
 * Uses one shared, mutating `pendingPayout` across both complete() and collectBalance() calls
 * so the assertions reflect the TRUE net balance a partner would see on their wallet screen,
 * not just each call's own isolated delta.
 */
function makeService() {
  let pendingPayout = 0;
  const ledgerEntries: Array<{ type: string; amount: number }> = [];

  const prisma: any = {
    serviceVendor: {
      findUnique: jest.fn(async () => ({ id: 'vendor-1', userId: 'vendor-user-1' })),
      update: jest.fn(async (args: any) => {
        if (args.data.pendingPayout?.increment != null) pendingPayout += args.data.pendingPayout.increment;
        if (args.data.pendingPayout?.decrement != null) pendingPayout -= args.data.pendingPayout.decrement;
        if (args.data.completedJobs || args.data.totalEarnings) { /* not tracked here, irrelevant to this reconciliation */ }
        return { id: 'vendor-1', pendingPayout };
      }),
    },
    order: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(async () => ({ id: 'order-1', status: 'COMPLETED' })),
      update: jest.fn(async (args: any) => ({ id: 'order-1', ...args.data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    paymentTransaction: { create: jest.fn(async () => ({})), aggregate: jest.fn(async () => ({ _sum: { amount: 0 } })) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  prisma.orderTimeline = { create: jest.fn() };
  prisma.orderOtpLog = { create: jest.fn() };

  const ledger: any = {
    postEntry: jest.fn(async (_tx: any, _vendorId: string, type: string, amount: number) => {
      ledgerEntries.push({ type, amount });
      return {};
    }),
    trueUpCommission: jest.fn(async (tx: any, vendorId: string, orderId: string, remainingCommission: number) => {
      if (remainingCommission <= 0) return null;
      return ledger.postEntry(tx, vendorId, 'COMMISSION', -remainingCommission);
    }),
    getWarrantyDefaults: jest.fn(async () => ({ days: 7, percent: 0 })), // no warranty hold in this scenario
  };
  const paymentNotify: any = { workCompleted: jest.fn(async () => {}) };
  const payments: any = { createPaymentLink: jest.fn(async () => null) };
  const svc = new OrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, payments, paymentNotify, ledger, {} as any, {} as any);
  (svc as any).autoGenerateInvoice = jest.fn().mockResolvedValue(undefined);
  return { svc, prisma, ledgerEntries, getPendingPayout: () => pendingPayout };
}

describe('End-to-end reconciliation — ONLINE job', () => {
  it('credits exactly vendorPayout, no COD liability, since Remont already received the customer payment', async () => {
    const { svc, prisma, getPendingPayout } = makeService();
    // ₹1000 job, ₹150 Remont commission, ₹850 vendor payout — paid ONLINE, no cash ever
    // physically reaches the vendor.
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', vendorId: 'vendor-1', customerId: 'cust-1', guestPhone: null, orderNumber: 'ORD-ONLINE-1',
      status: 'STARTED', endOtp: null, endOtpVerified: false, paymentMethod: 'ONLINE',
      remontCommission: 150, vendorPayout: 850, leadCostAmount: 0, service: { category: null },
    });

    await svc.complete('vendor-user-1', 'order-1', '', []);

    expect(getPendingPayout()).toBe(850);
  });
});

describe('End-to-end reconciliation — COD job (full cash collection)', () => {
  it('nets to Remont-owed (negative pendingPayout), never double-credits the vendor for cash already in hand', async () => {
    const { svc, prisma, getPendingPayout } = makeService();
    // Same ₹1000 job/₹150 commission/₹850 payout, but paid COD — the vendor physically
    // collects the full ₹1000 from the customer.
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', vendorId: 'vendor-1', customerId: 'cust-1', guestPhone: null, orderNumber: 'ORD-COD-1',
      status: 'STARTED', endOtp: null, endOtpVerified: false, paymentMethod: 'COD',
      remontCommission: 150, vendorPayout: 850, leadCostAmount: 0, totalAmount: 1000, walletUsed: 0,
      service: { category: null }, vendor: { userId: 'vendor-user-1' },
    });

    // Step 1: job completion — same JOB_EARNING/COMMISSION true-up as the online case,
    // regardless of payment method (this part was already correct).
    await svc.complete('vendor-user-1', 'order-1', '', []);
    expect(getPendingPayout()).toBe(850); // same as ONLINE so far — the bug was what happens next

    // Step 2: the vendor collects the full ₹1000 cash from the customer.
    await svc.collectBalance('vendor-user-1', 'SERVICE_VENDOR' as any, 'order-1', 'CASH' as any);

    // Net: 850 (rightful payout) - 1000 (cash physically collected) = -150, i.e. the vendor
    // now owes Remont exactly the commission amount — not "+850 AND holding ₹1000 cash",
    // which is what the pre-fix code produced (a real ₹850 double-count in the vendor's favor).
    expect(getPendingPayout()).toBe(-150);
  });
});
