import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SupportCasesService } from './support.module';

function makeOrder(overrides: any = {}) {
  return {
    id: 'order-1', customerId: 'cust-1', vendorId: 'vendor-1', status: 'CONFIRMED',
    dispatchAttempts: 0, createdAt: new Date(), completedAt: null, totalAmount: 1500,
    items: [], service: { category: { warrantyDays: 7, warrantyHoldPercent: 15 } },
    ...overrides,
  };
}

function makeService(orderOverrides: any = {}) {
  const order = makeOrder(orderOverrides);
  const caseRows = new Map<string, any>();
  let seq = 0;

  const prisma: any = {
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    serviceVendor: { findUnique: jest.fn().mockResolvedValue({ id: 'vendor-1', userId: 'vendor-user-1' }) },
    user: { findUnique: jest.fn().mockResolvedValue({ phone: '9999999999' }) },
    supportCase: {
      count: jest.fn(async () => seq),
      create: jest.fn(async ({ data }: any) => {
        seq += 1;
        const row = { id: `case-${seq}`, logs: [], ...data };
        caseRows.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = { ...caseRows.get(where.id), ...data };
        caseRows.set(where.id, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => caseRows.get(where.id) || null),
    },
    supportCaseLog: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const policyEngine: any = {
    getPolicyConfig: jest.fn().mockResolvedValue({ visitCharge: 200, diagnosisCharge: 150, slaMin: 60, returnWindowDays: 7 }),
    deriveServiceStage: jest.fn().mockReturnValue('EN_ROUTE'),
    getIssueOptions: jest.fn().mockReturnValue(['PARTNER_ON_THE_WAY', 'OTHER_ISSUE']),
    recommend: jest.fn(),
  };
  const refunds: any = {
    raise: jest.fn().mockResolvedValue({ id: 'refund-1' }),
    decide: jest.fn().mockResolvedValue({ id: 'refund-1', status: 'PROCESSED' }),
  };
  const admin: any = { forceAssignVendor: jest.fn().mockResolvedValue({}) };
  const ledger: any = { getWarrantyDefaults: jest.fn().mockResolvedValue({ days: 7, percent: 15 }) };
  const paymentNotify: any = { supportCaseUpdate: jest.fn().mockResolvedValue(undefined) };
  const notifications: any = { create: jest.fn().mockResolvedValue({}) };
  const returns: any = { initiate: jest.fn().mockResolvedValue(undefined), finalize: jest.fn().mockResolvedValue(undefined) };
  const warranty: any = { openCase: jest.fn().mockResolvedValue(undefined) };

  const svc = new SupportCasesService(prisma, policyEngine, refunds, admin, ledger, paymentNotify, notifications, returns, warranty);
  return { svc, prisma, policyEngine, refunds, admin, ledger, paymentNotify, notifications, returns, warranty, order };
}

describe('SupportCasesService.openCase', () => {
  it('rejects opening a case for an order that does not belong to the customer', async () => {
    const { svc } = makeService();
    await expect(svc.openCase('someone-else', { orderId: 'order-1', issueType: 'PARTNER_ON_THE_WAY' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('scopes a multi-item product order to the single OrderItem\'s own price, never the whole order', async () => {
    const { svc, policyEngine } = makeService({
      items: [
        { id: 'item-1', totalPrice: 300 },
        { id: 'item-2', totalPrice: 700 },
      ],
      totalAmount: 1000,
    });
    policyEngine.recommend.mockReturnValue({ routeType: 'SUPPORT_CASE', resolutionType: null, amount: null, reasonForCustomer: 'review', policyApplied: 'x' });

    await svc.openCase('cust-1', { orderId: 'order-1', orderItemId: 'item-1', issueType: 'DAMAGED_PRODUCT' });

    expect(policyEngine.recommend).toHaveBeenCalledWith(expect.objectContaining({ amountBasis: 300, itemType: 'PRODUCT' }));
  });

  it('rejects an orderItemId that does not belong to the order', async () => {
    const { svc } = makeService({ items: [{ id: 'item-1', totalPrice: 300 }] });
    await expect(svc.openCase('cust-1', { orderId: 'order-1', orderItemId: 'not-mine', issueType: 'DAMAGED_PRODUCT' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('AUTO_RESOLUTION immediately raises and decides a refund, resolving the case with no admin involved', async () => {
    const { svc, refunds, policyEngine } = makeService();
    policyEngine.recommend.mockReturnValue({
      routeType: 'AUTO_RESOLUTION', resolutionType: 'REFUND_MINUS_VISIT', amount: 1300,
      reasonForCustomer: 'visit charge applied', policyApplied: 'visit charge',
    });

    const result = await svc.openCase('cust-1', { orderId: 'order-1', issueType: 'PARTNER_ON_THE_WAY' });

    expect(refunds.raise).toHaveBeenCalledWith('cust-1', 'order-1', undefined, expect.stringContaining('PARTNER_ON_THE_WAY'), []);
    expect(refunds.decide).toHaveBeenCalledWith('SYSTEM', 'refund-1', 'WALLET_CREDIT', { approvedAmount: 1300, adminNotes: 'visit charge applied' });
    expect(result.status).toBe('RESOLVED');
    expect(result.decidedBy).toBeUndefined();
  });

  it('a DISPUTE route puts the case in WAITING_PARTNER and notifies the assigned partner', async () => {
    const { svc, policyEngine, notifications } = makeService();
    policyEngine.recommend.mockReturnValue({
      routeType: 'DISPUTE', resolutionType: 'FREE_REWORK', amount: null,
      reasonForCustomer: 'within warranty', policyApplied: 'warranty',
    });

    const result = await svc.openCase('cust-1', { orderId: 'order-1', issueType: 'SERVICE_COMPLETED_ISSUE_NOT_FIXED' });

    expect(result.status).toBe('WAITING_PARTNER');
    expect(notifications.create).toHaveBeenCalledWith('vendor-user-1', expect.objectContaining({ title: expect.any(String) }));
  });

  it('a SUPPORT_CASE route stays OPEN with no money movement and no partner notification', async () => {
    const { svc, refunds, notifications, policyEngine } = makeService();
    policyEngine.recommend.mockReturnValue({
      routeType: 'SUPPORT_CASE', resolutionType: null, amount: null,
      reasonForCustomer: 'needs review', policyApplied: 'none',
    });

    const result = await svc.openCase('cust-1', { orderId: 'order-1', issueType: 'OTHER_ISSUE' });

    expect(result.status).toBe('OPEN');
    expect(refunds.raise).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });
});

describe('SupportCasesService.adminDecide', () => {
  it('rejects a decision with no reason', async () => {
    const { svc, policyEngine } = makeService();
    policyEngine.recommend.mockReturnValue({ routeType: 'SUPPORT_CASE', resolutionType: null, amount: null, reasonForCustomer: 'x', policyApplied: 'x' });
    const kase = await svc.openCase('cust-1', { orderId: 'order-1', issueType: 'OTHER_ISSUE' });
    await expect(svc.adminDecide('admin-1', kase.id, 'NO_REFUND', undefined, '')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects deciding a case twice', async () => {
    const { svc, policyEngine } = makeService();
    policyEngine.recommend.mockReturnValue({ routeType: 'SUPPORT_CASE', resolutionType: null, amount: null, reasonForCustomer: 'x', policyApplied: 'x' });
    const kase = await svc.openCase('cust-1', { orderId: 'order-1', issueType: 'OTHER_ISSUE' });
    await svc.adminDecide('admin-1', kase.id, 'NO_REFUND', undefined, 'not eligible');
    await expect(svc.adminDecide('admin-1', kase.id, 'NO_REFUND', undefined, 'again')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REASSIGN_PARTNER calls the existing forceAssignVendor rather than reinventing dispatch', async () => {
    const { svc, admin, policyEngine } = makeService();
    policyEngine.recommend.mockReturnValue({ routeType: 'SUPPORT_CASE', resolutionType: 'FULL_REFUND', amount: 1500, reasonForCustomer: 'x', policyApplied: 'x' });
    const kase = await svc.openCase('cust-1', { orderId: 'order-1', issueType: 'PARTNER_NOT_ASSIGNED' });

    await svc.adminDecide('admin-1', kase.id, 'REASSIGN_PARTNER', undefined, 'reassigning to a faster partner', { newVendorId: 'vendor-2' });

    expect(admin.forceAssignVendor).toHaveBeenCalledWith('order-1', 'vendor-2', 'admin-1', 'ADMIN');
  });

  it('a refund-shaped admin decision raises and decides through the existing RefundsService', async () => {
    const { svc, refunds, policyEngine } = makeService();
    policyEngine.recommend.mockReturnValue({ routeType: 'SUPPORT_CASE', resolutionType: null, amount: null, reasonForCustomer: 'x', policyApplied: 'x' });
    const kase = await svc.openCase('cust-1', { orderId: 'order-1', issueType: 'OTHER_ISSUE' });

    await svc.adminDecide('admin-1', kase.id, 'PARTIAL_REFUND', 400, 'goodwill gesture');

    expect(refunds.raise).toHaveBeenCalledWith('cust-1', 'order-1', undefined, expect.any(String), []);
    expect(refunds.decide).toHaveBeenCalledWith('admin-1', 'refund-1', 'WALLET_CREDIT', { approvedAmount: 400, adminNotes: 'goodwill gesture' });
  });
});

describe('SupportCasesService.partnerRespond', () => {
  it('rejects a response from a vendor who is not this case\'s assigned partner', async () => {
    const { svc, prisma, policyEngine } = makeService();
    policyEngine.recommend.mockReturnValue({ routeType: 'DISPUTE', resolutionType: 'FREE_REWORK', amount: null, reasonForCustomer: 'x', policyApplied: 'x' });
    const kase = await svc.openCase('cust-1', { orderId: 'order-1', issueType: 'SERVICE_COMPLETED_ISSUE_NOT_FIXED' });
    prisma.serviceVendor.findUnique.mockResolvedValueOnce({ id: 'some-other-vendor', userId: 'other-user' });

    await expect(svc.partnerRespond('other-user', kase.id, 'I fixed it properly')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a valid partner response moves the case to ADMIN_REVIEW', async () => {
    const { svc, policyEngine } = makeService();
    policyEngine.recommend.mockReturnValue({ routeType: 'DISPUTE', resolutionType: 'FREE_REWORK', amount: null, reasonForCustomer: 'x', policyApplied: 'x' });
    const kase = await svc.openCase('cust-1', { orderId: 'order-1', issueType: 'SERVICE_COMPLETED_ISSUE_NOT_FIXED' });

    const updated = await svc.partnerRespond('vendor-user-1', kase.id, 'This is a different issue than what I fixed');

    expect(updated.status).toBe('ADMIN_REVIEW');
    expect(updated.partnerResponse).toBe('This is a different issue than what I fixed');
  });
});
