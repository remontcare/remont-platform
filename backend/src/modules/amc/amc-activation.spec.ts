import { BadRequestException } from '@nestjs/common';
import { AmcService } from './amc.module';

function makeService() {
  const prisma: any = {
    amcPlan: { findUnique: jest.fn() },
    amcSubscription: {
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 0),
      create: jest.fn(async (args: any) => ({ id: 'sub-1', ...args.data })),
      findUnique: jest.fn(),
      update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
    },
  };
  const payments: any = {
    createOrder: jest.fn(async () => ({ gateway: 'RAZORPAY', gatewayOrderId: 'rzp_1', keyId: 'key', txId: 'tx-1' })),
    verifyAndMarkPaid: jest.fn(async () => true),
  };
  const svc = new AmcService(prisma, payments, {} as any);
  return { svc, prisma, payments };
}

describe('AmcService — pay-before-activate fix', () => {
  it('subscribe() creates the subscription as PENDING_PAYMENT with zero service credits, not ACTIVE', async () => {
    const { svc, prisma } = makeService();
    prisma.amcPlan.findUnique.mockResolvedValue({
      id: 'plan-1', isActive: true, durationMonths: 12, priceYearly: 4999, freeServicesCount: 4,
    });
    await svc.subscribe('user-1', 'plan-1');
    expect(prisma.amcSubscription.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PENDING_PAYMENT', servicesRemaining: 0 }),
    }));
  });

  it('renew() also starts PENDING_PAYMENT rather than granting credits up front', async () => {
    const { svc, prisma } = makeService();
    prisma.amcSubscription.findUnique.mockResolvedValue({
      id: 'sub-old', userId: 'user-1', planId: 'plan-1', endDate: new Date(),
      plan: { durationMonths: 12, priceYearly: 4999, freeServicesCount: 4 },
      autoRenew: true,
    });
    await svc.renew('user-1', 'sub-old');
    expect(prisma.amcSubscription.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PENDING_PAYMENT', servicesRemaining: 0 }),
    }));
  });

  it('confirmPayment() activates and grants service credits only after signature verification succeeds', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.amcSubscription.findUnique.mockResolvedValue({
      id: 'sub-1', userId: 'user-1', status: 'PENDING_PAYMENT', plan: { freeServicesCount: 4 },
    });
    await svc.confirmPayment('user-1', 'sub-1', 'pay_1', 'order_1', 'sig_1');
    expect(payments.verifyAndMarkPaid).toHaveBeenCalledWith('order_1', 'pay_1', 'sig_1');
    expect(prisma.amcSubscription.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'ACTIVE', servicesRemaining: 4 }),
    }));
  });

  it('confirmPayment() rejects an invalid signature without activating or granting credits', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.amcSubscription.findUnique.mockResolvedValue({
      id: 'sub-1', userId: 'user-1', status: 'PENDING_PAYMENT', plan: { freeServicesCount: 4 },
    });
    payments.verifyAndMarkPaid.mockResolvedValue(false);
    await expect(svc.confirmPayment('user-1', 'sub-1', 'pay_1', 'order_1', 'bad-sig')).rejects.toThrow(BadRequestException);
    expect(prisma.amcSubscription.update).not.toHaveBeenCalled();
  });

  it('confirmPayment() is idempotent once already ACTIVE — no re-verification, no double credit grant', async () => {
    const { svc, prisma, payments } = makeService();
    prisma.amcSubscription.findUnique.mockResolvedValue({
      id: 'sub-1', userId: 'user-1', status: 'ACTIVE', plan: { freeServicesCount: 4 },
    });
    await svc.confirmPayment('user-1', 'sub-1', 'pay_1', 'order_1', 'sig_1');
    expect(payments.verifyAndMarkPaid).not.toHaveBeenCalled();
    expect(prisma.amcSubscription.update).not.toHaveBeenCalled();
  });
});
