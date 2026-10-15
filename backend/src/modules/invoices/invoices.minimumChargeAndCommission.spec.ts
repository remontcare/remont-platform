import { InvoicesService } from './invoices.module';
import { buildInvoiceViewModel } from './invoice-pdf';

/**
 * Invoices reconcile to what checkout charged: commission (already inside the service price,
 * deducted from the partner) is never added to the customer again, no booking fee is printed
 * unless charged, the minimum-charge top-up is a visible line, and the service GST rate is the
 * same one checkout used. Remont's commission document goes to the partner.
 */
function baseOrder(o: any = {}) {
  return {
    id: 'o1', customerId: 'cust-1', vendor: { userId: 'vendor-user-a', staffType: 'PARTNER', gstin: null, fullName: 'Ravi', businessName: 'Ravi Electricals' },
    invoice: null, status: 'COMPLETED', orderNumber: 'REM-1', type: 'SERVICE', snapshotState: 'Madhya Pradesh',
    billingTransactionType: null, platformCharges: 0, couponDiscount: 0, membershipDiscount: 0, minimumChargeAdjustment: 0,
    service: { name: 'Switch repair', hsnSac: null, gstOverridePercent: null },
    serviceItems: [], items: [], extraWorkItems: [], ...o,
  };
}
function makeService() {
  const prisma: any = {
    order: { findUnique: jest.fn(), update: jest.fn(async (a: any) => ({ id: a.where.id, ...a.data })) },
    invoice: { findUnique: jest.fn(async () => null), create: jest.fn(async (a: any) => ({ id: 'inv-1', ...a.data })) },
    siteSetting: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => ({ value: '49' })) }, // a booking-fee setting must NOT be printed
    taxConfig: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => [{ lastNumber: 1 }]),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return { svc: new InvoicesService(prisma), prisma };
}
const created = (prisma: any) => prisma.invoice.create.mock.calls[0][0].data;

describe('Partner job (PLATFORM_SERVICE) — customer statement equals the payment', () => {
  it('₹349 service, ₹69.80 commission inside it, paid ₹411.82 → statement ₹411.82, no fee/booking lines', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(baseOrder({ serviceAmount: 349, remontCommission: 69.8, vendorPayout: 279.2, gstAmount: 62.82, totalAmount: 411.82 }));
    await svc.generateForOrder('o1');
    const d = created(prisma);
    expect(Number(d.customerTotal)).toBe(411.82);
    expect(Number(d.customerCgst) + Number(d.customerSgst)).toBe(62.82);
    expect(Number(d.bookingFee)).toBe(0);
    expect(d.lineItemsSnapshot.customer).toHaveLength(1);
    // Remont's own document: the commission only (+GST at the platform-fee rate)
    expect(d.lineItemsSnapshot.remont.map((l: any) => l.description)).toEqual(['Remont Commission']);
    expect(Number(d.platformCommission)).toBe(69.8);
  });

  it('a minimum-charge top-up is already inside serviceAmount and reconciles too (₹5 → ₹199 incl. GST)', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(baseOrder({ serviceAmount: 168.64, minimumChargeAdjustment: 163.64, remontCommission: 33.73, gstAmount: 30.36, totalAmount: 199 }));
    await svc.generateForOrder('o1');
    expect(Number(created(prisma).customerTotal)).toBe(199);
  });

  it("Remont's commission document is addressed to the partner, not the customer", () => {
    const invoice = { transactionType: 'PLATFORM_SERVICE', lineItemsSnapshot: { remont: [] }, platformCommission: 69.8, bookingFee: 0, remontCgst: 6.28, remontSgst: 6.28, remontIgst: 0, remontTotal: 82, generatedAt: new Date() };
    const vm = buildInvoiceViewModel(invoice, 'REMONT', { company: { legalName: 'Remont', gstin: 'X', state: 'Madhya Pradesh' } as any, order: baseOrder() });
    expect(vm.recipient.name).toBe('Ravi Electricals');
    expect(vm.copyTag).toMatch(/PARTNER/);
  });
});

describe('In-house job (DIRECT_PROJECT) — same GST source as checkout', () => {
  it('nothing configured → the same 18% checkout charged (was 0%); minimum top-up is its own line', async () => {
    const { svc, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue(baseOrder({
      billingTransactionType: 'DIRECT_PROJECT', vendor: { userId: 'v', staffType: 'IN_HOUSE', gstin: null },
      serviceAmount: 168.64, minimumChargeAdjustment: 163.64, gstAmount: 30.36, totalAmount: 199,
      serviceItems: [{ quantity: 1, unitPrice: 5, service: { name: 'Switch repair', hsnSac: null, gstOverridePercent: null, unit: 'job' } }],
    }));
    await svc.generateForOrder('o1');
    const d = created(prisma);
    expect(d.lineItemsSnapshot.customer.map((l: any) => l.description)).toEqual(['Switch repair', 'Minimum service charge adjustment']);
    expect(Number(d.customerTotal)).toBe(199);
    expect(Number(d.customerCgst) + Number(d.customerSgst)).toBe(30.36);
  });
});
