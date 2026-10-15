import { OrdersService } from './orders.module';

/**
 * End-to-end accounting reconciliation (service level): an ONLINE job credits only the partner's
 * rightful payout (Remont holds the customer's money); a COD job nets the payout against the cash
 * the partner physically collected — leaving Remont's commission recoverable, never "payout AND
 * the cash". Earnings are posted only once the customer's payment is VERIFIED; partner-reported
 * cash counts only when confirmed (the customer's completion OTP, the customer, or an admin).
 *
 * One shared, mutating order/payment state and pendingPayout, so the assertions are the TRUE net
 * balance a partner would see, across complete() → collection → confirmation.
 */
function makeService(initialOrder: Record<string, any>, initialPayments: any[] = []) {
  let pendingPayout = 0;
  const order: Record<string, any> = { ...initialOrder };
  const payments: any[] = initialPayments.map((p, i) => ({ id: `pt-${i}`, gateway: 'RAZORPAY', orderId: 'order-1', ...p }));
  const ledgerEntries: Array<{ type: string; amount: number }> = [];

  const prisma: any = {
    serviceVendor: {
      findUnique: jest.fn(async () => ({ id: 'vendor-1', userId: 'vendor-user-1', staffType: 'PARTNER' })),
      update: jest.fn(async (args: any) => {
        if (args.data.pendingPayout?.increment != null) pendingPayout += args.data.pendingPayout.increment;
        if (args.data.pendingPayout?.decrement != null) pendingPayout -= args.data.pendingPayout.decrement;
        return { id: 'vendor-1', pendingPayout };
      }),
    },
    order: {
      findUnique: jest.fn(async () => ({ ...order, vendor: { id: 'vendor-1', userId: 'vendor-user-1', staffType: 'PARTNER' } })),
      findUniqueOrThrow: jest.fn(async () => ({ ...order })),
      update: jest.fn(async (args: any) => { Object.assign(order, args.data); return { ...order }; }),
      updateMany: jest.fn(async (args: any) => {
        const w = args.where || {};
        if (w.earningsStatus !== undefined && order.earningsStatus !== w.earningsStatus) return { count: 0 };
        for (const [k, v] of Object.entries(args.data)) if (!(v && typeof v === 'object' && 'increment' in (v as any))) order[k] = v;
        return { count: 1 };
      }),
    },
    paymentTransaction: {
      create: jest.fn(async ({ data }: any) => { const row = { id: `pt-${payments.length}`, ...data }; payments.push(row); return row; }),
      findMany: jest.fn(async ({ where }: any) => payments.filter((p) =>
        (!where?.orderId || p.orderId === where.orderId)
        && (!where?.status || (where.status.in ? where.status.in.includes(p.status) : p.status === where.status))
        && (!where?.gateway || p.gateway === where.gateway)
        && (!where?.collectedBy || p.collectedBy === where.collectedBy))),
      findFirst: jest.fn(async ({ where }: any) => payments.find((p) => (!where?.id || p.id === where.id) && (!where?.orderId || p.orderId === where.orderId) && (!where?.gateway || p.gateway === where.gateway)) || null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = payments.find((p) => p.id === where.id && (!where.status || p.status === where.status));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    extraWorkItem: { findMany: jest.fn(async () => []) },
    partnerLedgerEntry: { count: jest.fn(async () => ledgerEntries.filter((e) => e.type === 'JOB_EARNING').length) },
    $queryRaw: jest.fn(async () => []),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  prisma.orderTimeline = { create: jest.fn() };
  prisma.orderOtpLog = { create: jest.fn() };
  prisma.auditLog = { create: jest.fn(async () => ({})) }; // cash confirmations are audited

  const ledger: any = {
    postEntry: jest.fn(async (_tx: any, _vendorId: string, type: string, amount: number) => { ledgerEntries.push({ type, amount }); return {}; }),
    trueUpCommission: jest.fn(async (tx: any, vendorId: string, orderId: string, remainingCommission: number) => {
      if (remainingCommission <= 0) return null;
      return ledger.postEntry(tx, vendorId, 'COMMISSION', -remainingCommission);
    }),
    postHold: jest.fn(async () => ({})),
    getWarrantyDefaults: jest.fn(async () => ({ days: 7, percent: 0 })),
  };
  const paymentNotify: any = { workCompleted: jest.fn(async () => {}), paymentSuccess: jest.fn(async () => {}) };
  const paymentsSvc: any = { createPaymentLink: jest.fn(async () => null) };
  const svc = new OrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, paymentsSvc, paymentNotify, ledger, {} as any, {} as any);
  (svc as any).autoGenerateInvoice = jest.fn().mockResolvedValue(undefined);
  return { svc, order, payments, ledgerEntries, getPendingPayout: () => pendingPayout };
}

// ₹1000 job, ₹150 Remont commission, ₹850 partner payout
const job = (extra: Record<string, any>) => ({
  id: 'order-1', vendorId: 'vendor-1', customerId: 'cust-1', guestPhone: null, orderNumber: 'ORD-1',
  status: 'STARTED', endOtp: '4321', endOtpVerified: false, endOtpFailedAttempts: 0,
  remontCommission: 150, vendorPayout: 850, leadCostAmount: 0, totalAmount: 1000, walletUsed: 0,
  service: { category: null }, ...extra,
});

describe('End-to-end reconciliation — ONLINE job', () => {
  it('credits exactly vendorPayout, no cash liability, since Remont already received the customer payment', async () => {
    const { svc, getPendingPayout } = makeService(job({ paymentMethod: 'ONLINE', paymentStatus: 'PAID' }), [{ amount: 1000, status: 'PAID' }]);
    await svc.complete('vendor-user-1', 'order-1', '4321', []);
    expect(getPendingPayout()).toBe(850);
  });
});

describe('End-to-end reconciliation — COD job (full cash collection)', () => {
  it('cash collected WITH the OTP-verified completion: nets to Remont-owed commission (−150), never payout AND cash', async () => {
    const { svc, getPendingPayout, payments } = makeService(job({ paymentMethod: 'COD', paymentStatus: 'PENDING' }));
    await svc.complete('vendor-user-1', 'order-1', '4321', [], undefined, { mode: 'CASH' as any });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toEqual(expect.objectContaining({ amount: 1000, status: 'PAID', verificationMethod: 'COMPLETION_OTP' }));
    expect(getPendingPayout()).toBe(-150); // 850 payout − 1000 cash in hand
  });

  it('older app flow — complete, then report cash separately: nothing moves until the customer confirms, then the same −150', async () => {
    const { svc, getPendingPayout, payments, order } = makeService(job({ paymentMethod: 'COD', paymentStatus: 'PENDING' }));
    await svc.complete('vendor-user-1', 'order-1', '4321', []);
    expect(order.earningsStatus).toBe('DEFERRED');
    expect(getPendingPayout()).toBe(0); // unpaid job: nothing withdrawable

    await svc.collectBalance('vendor-user-1', 'SERVICE_VENDOR' as any, 'order-1', 'CASH' as any);
    expect(payments[0].status).toBe('PENDING'); // partner's own report is not proof
    expect(getPendingPayout()).toBe(0);

    await svc.verifyCashCollection({ sub: 'cust-1', role: 'CUSTOMER' as any }, 'order-1', payments[0].id);
    expect(payments[0]).toEqual(expect.objectContaining({ status: 'PAID', verificationMethod: 'CUSTOMER' }));
    expect(getPendingPayout()).toBe(-150);
    expect(order.paymentStatus).toBe('PAID');
  });

  it('a partner cannot confirm their own reported cash; another customer cannot either', async () => {
    const { svc, payments, getPendingPayout } = makeService(job({ paymentMethod: 'COD', paymentStatus: 'PENDING' }));
    await svc.complete('vendor-user-1', 'order-1', '4321', []);
    await svc.collectBalance('vendor-user-1', 'SERVICE_VENDOR' as any, 'order-1', 'CASH' as any);
    await expect(svc.verifyCashCollection({ sub: 'vendor-user-1', role: 'SERVICE_VENDOR' as any }, 'order-1', payments[0].id)).rejects.toThrow();
    await expect(svc.verifyCashCollection({ sub: 'someone-else', role: 'CUSTOMER' as any }, 'order-1', payments[0].id)).rejects.toThrow();
    expect(payments[0].status).toBe('PENDING');
    expect(getPendingPayout()).toBe(0);
  });

  it('confirming the same cash twice applies it once', async () => {
    const { svc, payments, getPendingPayout } = makeService(job({ paymentMethod: 'COD', paymentStatus: 'PENDING' }));
    await svc.complete('vendor-user-1', 'order-1', '4321', []);
    await svc.collectBalance('vendor-user-1', 'SERVICE_VENDOR' as any, 'order-1', 'CASH' as any);
    await svc.verifyCashCollection({ sub: 'cust-1', role: 'CUSTOMER' as any }, 'order-1', payments[0].id);
    await svc.verifyCashCollection({ sub: 'admin-1', role: 'ADMIN' as any }, 'order-1', payments[0].id, 'Called customer, confirmed cash paid');
    expect(getPendingPayout()).toBe(-150);
  });
});
