import { BadRequestException } from '@nestjs/common';
import { ExtraWorkService } from './orders.module';

/**
 * POST /orders/:id/extra-work/verify-otp put the body's `otp` straight into a Prisma where.
 * A missing otp (filter dropped) or an operator object ({ not: null }) matched the pending
 * item and approved the charge without the customer's code.
 */
function makeService() {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn().mockResolvedValue({ id: 'v1' }) },
    order: { findUnique: jest.fn().mockResolvedValue({ id: 'o1', vendorId: 'v1', status: 'STARTED' }) },
    extraWorkItem: { findMany: jest.fn().mockResolvedValue([{ id: 'x1' }]), updateMany: jest.fn() },
  };
  return { prisma, service: new ExtraWorkService(prisma, {} as any, {} as any) };
}

describe('ExtraWorkService.verifyOtp', () => {
  it.each([
    ['missing', undefined],
    ['an operator object', { not: null }],
    ['an empty string', ''],
    ['a number', 1234],
    ['non-digits', 'abcd'],
  ])('rejects %s otp without querying or approving anything', async (_label, otp) => {
    const { service, prisma } = makeService();
    await expect(service.verifyOtp('u1', 'o1', otp as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.extraWorkItem.findMany).not.toHaveBeenCalled();
    expect(prisma.extraWorkItem.updateMany).not.toHaveBeenCalled();
  });

  it('still looks up a well-formed code', async () => {
    const { service, prisma } = makeService();
    prisma.extraWorkItem.findMany.mockResolvedValue([]);
    await expect(service.verifyOtp('u1', 'o1', '1234')).rejects.toThrow('Invalid OTP');
    expect(prisma.extraWorkItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { orderId: 'o1', status: 'PENDING', otp: '1234' },
    }));
  });
});
