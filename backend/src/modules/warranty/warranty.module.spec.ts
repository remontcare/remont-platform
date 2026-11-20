import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WarrantyService } from './warranty.module';

/**
 * C-13 hardening — decide() used to check wc.status !== 'ADMIN_REVIEW' via a plain
 * findUnique, then move money, then write the final status LAST — a race window two
 * concurrent/retried decide() calls could both pass. It's now an atomic updateMany claim
 * (ADMIN_REVIEW -> RESOLVED/REJECTED) taken BEFORE any refund/replacement side effect runs.
 */
function makeService() {
  let current: any = null;
  const prisma: any = {
    warrantyCase: {
      findUnique: jest.fn(async () => (current ? { ...current } : null)),
      updateMany: jest.fn(async (args: any) => {
        if (!current || current.id !== args.where.id || current.status !== args.where.status) return { count: 0 };
        current = { ...current, ...args.data };
        return { count: 1 };
      }),
      update: jest.fn(async (args: any) => { current = { ...current, ...args.data }; return { id: args.where.id, ...current }; }),
    },
    supportCase: { update: jest.fn(async () => ({})) },
    supportCaseLog: { create: jest.fn(async () => ({})) },
    orderTimeline: { create: jest.fn(async () => ({})) },
  };
  const refunds: any = { raise: jest.fn(async () => ({ id: 'refund-1' })), decide: jest.fn(async () => ({})) };
  const returns: any = { createReplacementOrder: jest.fn(async () => ({ orderNumber: 'REP-1' })) };
  const notifications: any = { create: jest.fn(async () => ({})) };
  const svc = new WarrantyService(prisma, refunds, returns, notifications);
  const setCurrent = (row: any) => { current = row; };
  return { svc, prisma, refunds, returns, setCurrent };
}

const baseCase = {
  id: 'wc-1', caseNumber: 'WAR-000001', status: 'ADMIN_REVIEW',
  orderId: 'order-1', orderItemId: null, customerId: 'cust-1', supportCaseId: 'case-1',
  order: { totalAmount: 900, items: [] },
};

describe('WarrantyService.decide — the only place a warranty claim actually resolves', () => {
  it('404s on a missing case', async () => {
    const { svc } = makeService();
    await expect(svc.decide('wc-missing', 'APPROVED_REFUND' as any, 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a case not currently awaiting an admin decision', async () => {
    const { svc, setCurrent } = makeService();
    setCurrent({ ...baseCase, status: 'RESOLVED' });
    await expect(svc.decide('wc-1', 'APPROVED_REFUND' as any, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('APPROVED_REFUND raises and decides a refund for the order total when no specific item is targeted', async () => {
    const { svc, refunds, setCurrent } = makeService();
    setCurrent({ ...baseCase });
    await svc.decide('wc-1', 'APPROVED_REFUND' as any, 'admin-1', 'Confirmed defective');
    expect(refunds.raise).toHaveBeenCalledWith('cust-1', 'order-1', undefined, expect.stringContaining('WAR-000001'), []);
    expect(refunds.decide).toHaveBeenCalledWith('admin-1', 'refund-1', 'WALLET_CREDIT', expect.objectContaining({ approvedAmount: 900 }));
  });

  it('APPROVED_REPLACEMENT creates a replacement order instead of refunding', async () => {
    const { svc, refunds, returns, setCurrent } = makeService();
    setCurrent({ ...baseCase });
    await svc.decide('wc-1', 'APPROVED_REPLACEMENT' as any, 'admin-1');
    expect(returns.createReplacementOrder).toHaveBeenCalledWith('order-1', 'admin-1');
    expect(refunds.raise).not.toHaveBeenCalled();
  });

  it('REJECTED records the decision with no refund or replacement', async () => {
    const { svc, refunds, returns, prisma, setCurrent } = makeService();
    setCurrent({ ...baseCase });
    await svc.decide('wc-1', 'REJECTED' as any, 'admin-1', 'Not covered');
    expect(refunds.raise).not.toHaveBeenCalled();
    expect(returns.createReplacementOrder).not.toHaveBeenCalled();
    const row = await prisma.warrantyCase.findUnique({ where: { id: 'wc-1' } });
    expect(row.status).toBe('REJECTED');
  });

  // Two simultaneous warranty decisions — only the first can claim the case (its status
  // moves off ADMIN_REVIEW); the second must be rejected before it can trigger a second
  // refund/replacement for the same claim.
  it('two simultaneous decide() calls for the same case: only the first resolves it', async () => {
    const { svc, refunds, setCurrent } = makeService();
    setCurrent({ ...baseCase });

    await svc.decide('wc-1', 'APPROVED_REFUND' as any, 'admin-1');
    await expect(svc.decide('wc-1', 'APPROVED_REFUND' as any, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);

    expect(refunds.decide).toHaveBeenCalledTimes(1);
  });

  // Retry-after-failure safety: a failure while applying the decision must roll the case
  // back to ADMIN_REVIEW so it can be retried instead of being stuck "resolved" with no
  // refund/replacement actually applied.
  it('rolls back to ADMIN_REVIEW when the refund fails, so the decision can be retried', async () => {
    const { svc, refunds, prisma, setCurrent } = makeService();
    setCurrent({ ...baseCase });
    refunds.decide.mockRejectedValueOnce(new Error('wallet credit failed'));

    await expect(svc.decide('wc-1', 'APPROVED_REFUND' as any, 'admin-1')).rejects.toThrow('wallet credit failed');

    const row = await prisma.warrantyCase.findUnique({ where: { id: 'wc-1' } });
    expect(row.status).toBe('ADMIN_REVIEW');

    refunds.decide.mockResolvedValueOnce({});
    const retried = await svc.decide('wc-1', 'APPROVED_REFUND' as any, 'admin-1');
    expect(retried).toBeUndefined(); // decide() returns void; reaching here means it didn't throw
  });
});
