import { OrdersService } from './orders.module';

/**
 * Reliability fix: OrdersService.autoGenerateInvoice() runs fire-and-forget from complete()
 * (a throw there must never fail job completion itself). Previously a failure was only
 * logged — the order stayed COMPLETED forever with no invoice and nothing admin-visible.
 * Now the failure (and its clearing on a later successful retry) is recorded on the order
 * itself via invoiceGenerationFailed/invoiceGenerationError.
 */
function makeService() {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn().mockResolvedValue({ id: 'vendor-1' }), update: jest.fn() },
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
    getWarrantyDefaults: jest.fn().mockResolvedValue({ days: 7, percent: 0 }),
  };
  const paymentNotify: any = { workCompleted: jest.fn().mockResolvedValue({}) };
  const invoices: any = { generateForOrder: jest.fn() };
  const svc = new OrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, paymentNotify, ledger, invoices);
  return { svc, prisma, ledger, invoices };
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

// Job completion's own transaction is synchronous relative to the caller, but
// autoGenerateInvoice() is deliberately fire-and-forget (`.catch(...)`, never awaited) — flush
// one macrotask boundary so its (already-resolved-or-rejected) promise chain has settled
// before asserting on its side effects.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('OrdersService.complete — auto-invoice generation failure tracking', () => {
  it('records invoiceGenerationFailed + the error message when generateForOrder throws, without failing job completion itself', async () => {
    const { svc, prisma, invoices } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'vendor-user-1' });
    prisma.order.findUnique.mockResolvedValue(baseOrder());
    invoices.generateForOrder.mockRejectedValue(new Error('Missing GST configuration'));

    const result = await svc.complete('vendor-user-1', 'order-1', '', []);
    await flush();

    // complete() itself succeeds — a downstream invoice failure must never undo/block the
    // job completion the vendor/customer already see as done.
    expect(result).toBeDefined();
    expect(prisma.order.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'order-1' },
      data: expect.objectContaining({ invoiceGenerationFailed: true, invoiceGenerationError: 'Missing GST configuration' }),
    }));
  });

  it('clears any prior failure flag and sets status INVOICED when generation succeeds', async () => {
    const { svc, prisma, invoices } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', userId: 'vendor-user-1' });
    prisma.order.findUnique.mockResolvedValue(baseOrder());
    invoices.generateForOrder.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1' });

    await svc.complete('vendor-user-1', 'order-1', '', []);
    await flush();

    expect(prisma.order.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'order-1' },
      data: expect.objectContaining({ status: 'INVOICED', invoiceGenerationFailed: false, invoiceGenerationError: null }),
    }));
  });
});
