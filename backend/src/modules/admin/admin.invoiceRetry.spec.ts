import { AdminService } from './admin.module';

/**
 * Admin's "Generate Invoice" button is the retry mechanism for
 * OrdersService.autoGenerateInvoice()'s own fire-and-forget failures — this is the SAME
 * generateForOrder() call (idempotent: returns the existing Invoice if one already exists),
 * so retrying after fixing whatever caused the failure can never create a duplicate.
 */
function makeService() {
  const prisma: any = {
    order: { findUnique: jest.fn(), update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })), findMany: jest.fn().mockResolvedValue([]) },
  };
  const config: any = { get: jest.fn((_key: string, def: any) => def) };
  const payments: any = {};
  const settlements: any = {};
  const cities: any = {};
  const events: any = { emit: jest.fn() };
  const ledger: any = {};
  const invoices: any = { generateForOrder: jest.fn() };
  const svc = new AdminService(prisma, config, payments, settlements, cities, events, ledger, invoices, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma, invoices };
}

describe('AdminService.generateInvoice — retry path for a failed auto-invoice', () => {
  it('clears invoiceGenerationFailed/Error on a successful retry', async () => {
    const { svc, prisma, invoices } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', invoiceGenerationFailed: true, invoiceGenerationError: 'Missing GST configuration' });
    invoices.generateForOrder.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1' });

    const result = await svc.generateInvoice('order-1');

    expect(result).toEqual({ id: 'inv-1', invoiceNumber: 'INV-1' });
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' }, data: { invoiceGenerationFailed: false, invoiceGenerationError: null },
    });
  });

  it('records the failure again (with the new error) if the retry itself still fails', async () => {
    const { svc, prisma, invoices } = makeService();
    prisma.order.findUnique.mockResolvedValue({ id: 'order-1', invoiceGenerationFailed: true });
    invoices.generateForOrder.mockRejectedValue(new Error('Still broken'));

    await expect(svc.generateInvoice('order-1')).rejects.toThrow('Still broken');

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' }, data: { invoiceGenerationFailed: true, invoiceGenerationError: 'Still broken' },
    });
  });
});

describe('AdminService.listOrders — invoiceFailed filter', () => {
  it('filters to Order.invoiceGenerationFailed:true when requested', async () => {
    const { svc, prisma } = makeService();

    await svc.listOrders({ invoiceFailed: true });

    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ invoiceGenerationFailed: true }),
    }));
  });

  it('does not add the filter when not requested', async () => {
    const { svc, prisma } = makeService();

    await svc.listOrders({});

    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.invoiceGenerationFailed).toBeUndefined();
  });
});
