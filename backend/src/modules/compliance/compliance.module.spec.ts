import { EInvoiceService, EWayBillService } from './compliance.module';

/**
 * Phase 7 — e-Invoice / e-Way Bill. Both adapters are MOCK/sandbox (no real IRP/EWB
 * credentials exist in this codebase) — these tests exercise applicability determination,
 * status transitions, and idempotency, per the phase's own instruction to use mock
 * responses. See common/gstCompliance.spec.ts for the underlying pure applicability checks.
 */
function makeEInvoiceService() {
  const prisma: any = {
    eInvoiceRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(async (args: any) => ({ id: 'ei-1', invoiceId: args.where.invoiceId, ...(args.create || args.update) })),
      update: jest.fn(async (args: any) => ({ id: 'ei-1', ...args.data })),
    },
    invoice: { findUnique: jest.fn() },
    order: { findUnique: jest.fn() },
    siteSetting: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  return { svc: new EInvoiceService(prisma), prisma };
}

function makeEWayBillService() {
  const prisma: any = {
    eWayBillRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(async (args: any) => ({ id: 'ewb-1', orderId: args.where.orderId, ...(args.create || args.update) })),
      update: jest.fn(async (args: any) => ({ id: 'ewb-1', ...args.data })),
    },
    order: { findUnique: jest.fn() },
    siteSetting: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  return { svc: new EWayBillService(prisma), prisma };
}

describe('EInvoiceService.evaluateAndSubmit', () => {
  it('9. e-Invoice NOT required for a B2C MARKETPLACE_PRODUCT invoice even with e-Invoicing enabled for the seller', async () => {
    const { svc, prisma } = makeEInvoiceService();
    prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-1', orderId: 'order-1', transactionType: 'MARKETPLACE_PRODUCT', supplierGstin: '23AAAAA0000A1Z5' });
    // Call order inside evaluateAndSubmit(): orderForGstin (masterOrder.customerGstin) first,
    // then resolveIssuerEInvoicingEnabled()'s own order.findUnique (items[].product.vendor) second.
    prisma.order.findUnique
      .mockResolvedValueOnce({ masterOrder: null }) // no customerGstin — B2C
      .mockResolvedValueOnce({ items: [{ product: { vendor: { eInvoiceEnabled: true } } }] });
    const result = await svc.evaluateAndSubmit('inv-1');
    expect(result.status).toBe('NOT_REQUIRED');
  });

  it('10. e-Invoice required and SUCCEEDS for a B2B invoice from an e-Invoicing-enabled, GST-registered seller', async () => {
    const { svc, prisma } = makeEInvoiceService();
    prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-1', orderId: 'order-1', transactionType: 'MARKETPLACE_PRODUCT', supplierGstin: '23AAAAA0000A1Z5', invoiceNumber: 'INV-CTI-2026-27-000001', customerTotal: 1180 });
    prisma.order.findUnique
      .mockResolvedValueOnce({ masterOrder: { customerGstin: '06AABCU7755Q1ZK' } }) // B2B
      .mockResolvedValueOnce({ items: [{ product: { vendor: { eInvoiceEnabled: true } } }] });
    const result = await svc.evaluateAndSubmit('inv-1');
    expect(result.status).toBe('SUCCESS');
    expect(result.irn).toMatch(/^MOCK-IRN-/);
    expect(result.ackNumber).toBeDefined();
  });

  it('11. e-Invoice required but the (mock) IRP submission fails — marked FAILED, never SUCCESS', async () => {
    const { svc, prisma } = makeEInvoiceService();
    prisma.invoice.findUnique.mockResolvedValue({ id: 'inv-1', orderId: 'order-1', transactionType: 'DIRECT_PROJECT', supplierGstin: '23AAAAA0000A1Z5', invoiceNumber: 'INV-CTI-2026-27-000001', customerTotal: 1000 });
    prisma.siteSetting.findUnique.mockResolvedValue({ value: 'true' }); // Remont's own e-invoicing enabled
    prisma.order.findUnique.mockResolvedValueOnce({ masterOrder: { customerGstin: '06AABCU7755Q1ZK' } });
    jest.spyOn(svc as any, 'mockIrpSubmit').mockRejectedValue(new Error('IRP timeout'));
    const result = await svc.evaluateAndSubmit('inv-1');
    expect(result.status).toBe('FAILED');
    expect(result.errorMessage).toBe('IRP timeout');
    expect(result.irn).toBeUndefined();
  });

  it('12. idempotency: an invoice already SUCCESS is never resubmitted to the IRP a second time', async () => {
    const { svc, prisma } = makeEInvoiceService();
    prisma.eInvoiceRecord.findUnique.mockResolvedValue({ invoiceId: 'inv-1', status: 'SUCCESS', irn: 'MOCK-IRN-inv-1-1' });
    const result = await svc.evaluateAndSubmit('inv-1');
    expect(result.irn).toBe('MOCK-IRN-inv-1-1'); // returned as-is
    expect(prisma.invoice.findUnique).not.toHaveBeenCalled(); // never even re-evaluated
  });

  it('cancel() only works on a SUCCESSfully-registered e-Invoice', async () => {
    const { svc, prisma } = makeEInvoiceService();
    prisma.eInvoiceRecord.findUnique.mockResolvedValue({ invoiceId: 'inv-1', status: 'FAILED' });
    await expect(svc.cancel('inv-1', 'test')).rejects.toThrow();
    prisma.eInvoiceRecord.findUnique.mockResolvedValue({ invoiceId: 'inv-1', status: 'SUCCESS' });
    const result = await svc.cancel('inv-1', 'Order cancelled');
    expect(result.status).toBe('CANCELLED');
  });
});

describe('EWayBillService.evaluate', () => {
  it('14. e-Way Bill required for a PRODUCT order above the ₹50,000 default threshold', async () => {
    const { svc, prisma } = makeEWayBillService();
    prisma.order.findUnique.mockResolvedValue({ type: 'PRODUCT', productsTaxableAmount: 55000, productsAmount: 55000, gstAmount: 5000 });
    const result = await svc.evaluate('order-1');
    expect(result.status).toBe('GENERATED');
    expect(result.ewbNumber).toMatch(/^MOCK-EWB-/);
  });

  it('15. e-Way Bill NOT required for a SERVICE order regardless of value', async () => {
    const { svc, prisma } = makeEWayBillService();
    prisma.order.findUnique.mockResolvedValue({ type: 'SERVICE', productsTaxableAmount: 0, productsAmount: 0, gstAmount: 0 });
    const result = await svc.evaluate('order-1');
    expect(result.status).toBe('NOT_REQUIRED');
  });

  it('15b. e-Way Bill NOT required for a PRODUCT order below the threshold', async () => {
    const { svc, prisma } = makeEWayBillService();
    prisma.order.findUnique.mockResolvedValue({ type: 'PRODUCT', productsTaxableAmount: 10000, productsAmount: 10000, gstAmount: 1800 });
    const result = await svc.evaluate('order-1');
    expect(result.status).toBe('NOT_REQUIRED');
  });

  it('respects an admin-configured threshold override instead of the ₹50,000 default', async () => {
    const { svc, prisma } = makeEWayBillService();
    prisma.siteSetting.findUnique.mockResolvedValue({ value: '10000' });
    prisma.order.findUnique.mockResolvedValue({ type: 'PRODUCT', productsTaxableAmount: 15000, productsAmount: 15000, gstAmount: 0 });
    const result = await svc.evaluate('order-1');
    expect(result.status).toBe('GENERATED'); // 15000 > the overridden 10000 threshold
  });

  it('idempotency: an already-GENERATED e-Way Bill is never regenerated', async () => {
    const { svc, prisma } = makeEWayBillService();
    prisma.eWayBillRecord.findUnique.mockResolvedValue({ orderId: 'order-1', status: 'GENERATED', ewbNumber: 'MOCK-EWB-order-1-1' });
    const result = await svc.evaluate('order-1');
    expect(result.ewbNumber).toBe('MOCK-EWB-order-1-1');
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });
});
