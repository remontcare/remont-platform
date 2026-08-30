import { RefundsService } from './refunds.module';

/**
 * Phase 6 —
 *  C-06: a refund that moves money for an order that already has an issued Invoice must
 *  produce a CreditNote against it — previously the Invoice was never touched/adjusted at
 *  all after a post-invoice refund.
 *  H-06: a refund decided after this order's warranty hold has already matured/released
 *  (vendor already paid out) previously had NO recovery path — the vendor kept the full
 *  payout and Remont absorbed the whole refund. Must now claw it back from the vendor's
 *  live balance instead.
 */
function makeService() {
  let current: any = null;
  const prisma: any = {
    order: { findUnique: jest.fn(), update: jest.fn(async (args: any) => ({ id: 'o1', ...args.data })) },
    masterOrder: { findUnique: jest.fn(), update: jest.fn(async (args: any) => ({ id: 'mo1', ...args.data })) },
    serviceVendor: { findUnique: jest.fn() },
    paymentTransaction: { findFirst: jest.fn() },
    refundRequest: {
      create: jest.fn(async (args: any) => { current = { id: 'rr-1', status: 'REQUESTED', ...args.data }; return current; }),
      findUnique: jest.fn(async () => (current ? { ...current } : null)),
      updateMany: jest.fn(async (args: any) => {
        if (!current || current.id !== args.where.id) return { count: 0 };
        const statusFilter = args.where.status;
        const matches = statusFilter?.in ? statusFilter.in.includes(current.status) : current.status === statusFilter;
        if (!matches) return { count: 0 };
        current = { ...current, ...args.data };
        return { count: 1 };
      }),
      update: jest.fn(async (args: any) => { current = { ...current, ...args.data }; return { id: args.where.id, ...current }; }),
      findMany: jest.fn(async () => []),
    },
    refundRequestLog: { create: jest.fn(async () => ({})) },
    user: { findUnique: jest.fn(async () => ({ phone: '9999999999' })) },
    partnerHold: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const payments: any = { refundPayment: jest.fn(async () => ({ refundId: 'rfnd_1', gateway: 'RAZORPAY' })) };
  const wallet: any = { credit: jest.fn(async () => ({})) };
  const paymentNotify: any = { refundProcessed: jest.fn(async () => {}) };
  const ledger: any = { deductFromHold: jest.fn(async () => ({})), clawbackFromBalance: jest.fn(async () => ({})) };
  const invoices: any = { issueCreditNote: jest.fn(async () => ({ id: 'cn-1' })) };
  const svc = new RefundsService(prisma, payments, wallet, paymentNotify, ledger, invoices);
  const setCurrent = (row: any) => { current = row; };
  return { svc, prisma, payments, wallet, paymentNotify, ledger, invoices, setCurrent };
}

describe('RefundsService.decide — credit note issuance (C-06)', () => {
  it('issues a credit note after a WALLET_CREDIT refund actually moves money', async () => {
    const { svc, setCurrent, invoices } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 300, adminNotes: 'Defective item' });
    expect(invoices.issueCreditNote).toHaveBeenCalledWith('order-1', 'rr-1', 300, 'Defective item');
  });

  it('issues a credit note after a GATEWAY_REFUND too', async () => {
    const { svc, prisma, setCurrent, invoices } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'ptx-1', amount: 500 });
    await svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND', { approvedAmount: 500 });
    expect(invoices.issueCreditNote).toHaveBeenCalledWith('order-1', 'rr-1', 500, expect.any(String));
  });

  it('does NOT issue a credit note for NO_REFUND — no money moved, nothing to correct', async () => {
    const { svc, setCurrent, invoices } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    await svc.decide('admin-1', 'rr-1', 'NO_REFUND', {});
    expect(invoices.issueCreditNote).not.toHaveBeenCalled();
  });

  it('a credit-note failure never blocks or undoes an already-completed refund', async () => {
    const { svc, setCurrent, invoices } = makeService();
    invoices.issueCreditNote.mockRejectedValue(new Error('DB unreachable'));
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    const result = await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 300 });
    expect(result.approvedAmount).toBe(300); // refund itself still completed successfully
  });
});

describe('RefundsService.decide — vendor clawback when the warranty hold is gone (H-06)', () => {
  it('deducts from the hold when one is still live — clawbackFromBalance is NOT used', async () => {
    const { svc, prisma, setCurrent, ledger } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    prisma.partnerHold.findFirst.mockResolvedValue({ id: 'hold-1' });
    await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 200 });
    expect(ledger.deductFromHold).toHaveBeenCalledWith(expect.anything(), 'hold-1', 200);
    expect(ledger.clawbackFromBalance).not.toHaveBeenCalled();
  });

  it('claws back from the vendor\'s live balance when no HELD warranty hold exists (already released) — previously a silent no-op', async () => {
    const { svc, prisma, setCurrent, ledger } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    prisma.partnerHold.findFirst.mockResolvedValue(null); // hold already matured/released
    prisma.order.findUnique.mockResolvedValue({ vendorId: 'vendor-a' });
    await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 200 });
    expect(ledger.deductFromHold).not.toHaveBeenCalled();
    expect(ledger.clawbackFromBalance).toHaveBeenCalledWith(expect.anything(), 'vendor-a', 'order-1', 200, expect.any(String));
  });

  it('does nothing (no crash) when the order has no assigned partner at all', async () => {
    const { svc, prisma, setCurrent, ledger } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'order-1', customerId: 'cust-1' });
    prisma.partnerHold.findFirst.mockResolvedValue(null);
    prisma.order.findUnique.mockResolvedValue({ vendorId: null });
    await expect(svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT', { approvedAmount: 200 })).resolves.toBeDefined();
    expect(ledger.clawbackFromBalance).not.toHaveBeenCalled();
  });
});
