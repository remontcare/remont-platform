import { ForbiddenException } from '@nestjs/common';
import { InvoicesService } from './invoices.module';

function makeService() {
  const prisma: any = {
    order: { findUnique: jest.fn() },
    invoice: {
      count: jest.fn(async () => 0),
      create: jest.fn(async (args: any) => ({ id: 'inv-1', ...args.data })),
    },
  };
  return { svc: new InvoicesService(prisma), prisma };
}

describe('InvoicesService.generate — closing the "any user can read any invoice" gap', () => {
  it('rejects a caller who is neither the order\'s customer nor its assigned vendor', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', customerId: 'cust-1', vendor: { userId: 'vendor-user-a' }, invoice: null,
      orderNumber: 'REM-1', subtotal: 1000, totalAmount: 1180, gstAmount: 180, serviceAmount: 1000,
      remontCommission: 150, extraWorkItems: [],
    });
    await expect(svc.generate('random-user', 'o1')).rejects.toThrow(ForbiddenException);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it('allows the order\'s own customer to generate it', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1', customerId: 'cust-1', vendor: { userId: 'vendor-user-a' }, invoice: null,
      orderNumber: 'REM-1', subtotal: 1000, totalAmount: 1180, gstAmount: 180, serviceAmount: 1000,
      remontCommission: 150, extraWorkItems: [],
    });
    await expect(svc.generate('cust-1', 'o1')).resolves.toBeDefined();
  });
});
