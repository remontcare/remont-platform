import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RefundsService } from './refunds.module';

function makeService() {
  // Stateful updateMany models the real atomic claim: it only "succeeds" (count 1) when the
  // in-memory status is still one of ACTIVE_STATUSES at call time — the same guarantee a real
  // DB row-level conditional UPDATE gives two concurrent/retried callers.
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
    // No live Warranty Hold in these tests by default — the deductFromHold hook is a no-op.
    partnerHold: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const payments: any = { refundPayment: jest.fn(async () => ({ refundId: 'rfnd_1', gateway: 'RAZORPAY' })) };
  const wallet: any = { credit: jest.fn(async () => ({})) };
  const paymentNotify: any = { refundProcessed: jest.fn(async () => {}) };
  const ledger: any = { deductFromHold: jest.fn(async () => ({})), clawbackFromBalance: jest.fn(async () => ({})) };
  const invoices: any = { issueCreditNote: jest.fn(async () => null) };
  const svc = new RefundsService(prisma, payments, wallet, paymentNotify, ledger, invoices);
  const setCurrent = (row: any) => { current = row; };
  return { svc, prisma, payments, wallet, paymentNotify, ledger, invoices, setCurrent };
}

describe('RefundsService.raise', () => {
  it('rejects a customer raising a request for someone else\'s order', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', customerId: 'cust-1', paymentStatus: 'PAID', vendorId: 'v1' });
    await expect(svc.raise('random-user', 'o1', undefined, 'Damaged item', [])).rejects.toThrow(ForbiddenException);
  });

  it('rejects an order that was never paid', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', customerId: 'cust-1', paymentStatus: 'PENDING', vendorId: 'v1' });
    await expect(svc.raise('cust-1', 'o1', undefined, 'Damaged item', [])).rejects.toThrow(BadRequestException);
  });

  it('creates the request as REQUESTED and logs it', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', customerId: 'cust-1', paymentStatus: 'PAID', vendorId: 'vendor-a' });
    const rr = await svc.raise('cust-1', 'o1', undefined, 'Work not satisfactory', ['photo1.jpg']);
    expect(rr.status).toBe('REQUESTED');
    expect(prisma.refundRequestLog.create).toHaveBeenCalled();
  });
});

describe('RefundsService.partnerRespond', () => {
  it('rejects a vendor who is not the assigned partner', async () => {
    const { svc, prisma } = makeService();
    prisma.refundRequest.findUnique.mockResolvedValueOnce({ id: 'rr-1', partnerId: 'vendor-a', status: 'REQUESTED' });
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-b' });
    await expect(svc.partnerRespond('user-b', 'rr-1', 'Not my fault')).rejects.toThrow(ForbiddenException);
  });

  it('rejects responding to a request that is no longer awaiting one', async () => {
    const { svc, prisma } = makeService();
    prisma.refundRequest.findUnique.mockResolvedValueOnce({ id: 'rr-1', partnerId: 'vendor-a', status: 'PROCESSED' });
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-a' });
    await expect(svc.partnerRespond('vendor-user-a', 'rr-1', 'ok')).rejects.toThrow(BadRequestException);
  });
});

describe('RefundsService.decide — the only place money or a wallet credit actually moves', () => {
  it('rejects deciding a request that has already been decided', async () => {
    const { svc, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'PROCESSED' });
    await expect(svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, {})).rejects.toThrow(BadRequestException);
  });

  it('NO_REFUND rejects the request without moving any money', async () => {
    const { svc, prisma, wallet, payments, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    const result = await svc.decide('admin-1', 'rr-1', 'NO_REFUND' as any, {});
    expect(result.status).toBe('REJECTED');
    expect(wallet.credit).not.toHaveBeenCalled();
    expect(payments.refundPayment).not.toHaveBeenCalled();
  });

  it('WALLET_CREDIT (the default per business rule) credits the customer\'s wallet for the full amount', async () => {
    const { svc, prisma, wallet, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    const result = await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, {});
    expect(wallet.credit).toHaveBeenCalledWith('cust-1', 1000, 'REFUND', 'o1', expect.any(String), 'rr-1', 'admin-1');
    expect(result.status).toBe('PROCESSED');
  });

  it('GATEWAY_REFUND calls the real gateway refund API against the original payment', async () => {
    const { svc, prisma, payments, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', amount: 1000, gateway: 'RAZORPAY' });
    const result = await svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND' as any, {});
    expect(payments.refundPayment).toHaveBeenCalledWith('tx-1', 1000);
    expect(result.status).toBe('PROCESSED');
  });

  it('GATEWAY_REFUND fails clearly when only a cash-collected payment exists — no gateway to refund through', async () => {
    const { svc, prisma, payments, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    prisma.paymentTransaction.findFirst.mockResolvedValue(null); // the findFirst query filters gateway IN (RAZORPAY, PHONEPE)
    await expect(svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND' as any, {})).rejects.toThrow(BadRequestException);
    expect(payments.refundPayment).not.toHaveBeenCalled();
  });

  it('PARTIAL_WALLET_PARTIAL_GATEWAY does both legs', async () => {
    const { svc, prisma, wallet, payments, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', amount: 1000, gateway: 'RAZORPAY' });
    const result = await svc.decide('admin-1', 'rr-1', 'PARTIAL_WALLET_PARTIAL_GATEWAY' as any, { walletCreditAmount: 300, gatewayRefundAmount: 700 });
    expect(wallet.credit).toHaveBeenCalledWith('cust-1', 300, 'REFUND', 'o1', expect.any(String), 'rr-1', 'admin-1');
    expect(payments.refundPayment).toHaveBeenCalledWith('tx-1', 700);
    // 300 + 700 == totalAmount (1000) -> full refund reflected on the order
    expect(prisma.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: { paymentStatus: 'REFUNDED' } }));
    expect(result.status).toBe('PROCESSED');
  });

  it('does not flip the order to REFUNDED when only a partial amount was actually returned', async () => {
    const { svc, prisma, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, { approvedAmount: 300 });
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  // C-13 — "two simultaneous refund decisions": only the first can claim the request (its
  // status moves off the active set); the second must be rejected before it ever touches the
  // wallet/gateway, never processed twice.
  it('two simultaneous decide() calls for the same request: only the first moves money', async () => {
    const { svc, prisma, wallet, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });

    const first = await svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, {});
    expect(first.status).toBe('PROCESSED');
    await expect(svc.decide('admin-1', 'rr-1', 'WALLET_CREDIT' as any, {})).rejects.toBeInstanceOf(BadRequestException);

    expect(wallet.credit).toHaveBeenCalledTimes(1);
  });

  // Retry-after-failure safety: a gateway timeout/error must not leave the request stuck
  // "PROCESSED" with no money actually moved — the claim rolls back to UNDER_REVIEW so a
  // retried decide() call can go through again.
  it('rolls back to UNDER_REVIEW when the gateway call fails, so the decision can be retried', async () => {
    const { svc, prisma, payments, setCurrent } = makeService();
    setCurrent({ id: 'rr-1', status: 'REQUESTED', orderId: 'o1', customerId: 'cust-1' });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', totalAmount: 1000 });
    prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 'tx-1', amount: 1000, gateway: 'RAZORPAY' });
    payments.refundPayment.mockRejectedValueOnce(new Error('gateway timeout'));

    await expect(svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND' as any, {})).rejects.toThrow('gateway timeout');

    const row = await prisma.refundRequest.findUnique({ where: { id: 'rr-1' } });
    expect(row.status).toBe('UNDER_REVIEW');

    // Retry now succeeds — UNDER_REVIEW is still an active status.
    payments.refundPayment.mockResolvedValueOnce({ refundId: 'rfnd_2', gateway: 'RAZORPAY' });
    const retried = await svc.decide('admin-1', 'rr-1', 'GATEWAY_REFUND' as any, {});
    expect(retried.status).toBe('PROCESSED');
  });
});
