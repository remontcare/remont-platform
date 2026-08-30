import { ReturnsService } from './returns.module';

/**
 * Phase 6 —
 *  H-04: a partial return's settlement reversal used one blended, whole-order,
 *  customer-price ratio (amount/order.totalAmount) applied uniformly across every item's
 *  GST, even when the order mixes items at different GST rates. When the support case
 *  names a specific item (SupportCase.orderItemId, already tracked), the reversal must use
 *  THAT item's own frozen taxable-value share instead — exact, not blended.
 *  C-09: a REPLACEMENT decision never reversed the original order's settlement at all (the
 *  seller kept the original GROSS_SALE credit as if nothing was returned), and the new
 *  replacement Order was created with every financial/tax field at zero, invisible to GST/
 *  settlement accounting. Both must now happen: reverse the original, then give the
 *  replacement Order real frozen tax/fee data so its own later delivery settles correctly.
 */
function makeService() {
  const prisma: any = {
    returnShipment: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })), create: jest.fn() },
    supportCase: { update: jest.fn() },
    supportCaseLog: { create: jest.fn().mockResolvedValue({}) },
    order: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({ totalAmount: 1500, productsTaxableAmount: 1500, productsAmount: 1500 }),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(async (args: any) => ({ id: 'replacement-1', orderNumber: 'REP-000001', ...args.data })),
    },
    orderItem: { findUnique: jest.fn() },
    orderTimeline: { create: jest.fn().mockResolvedValue({ id: 'timeline-1' }) },
    shipment: { update: jest.fn() },
    $transaction: jest.fn((cb: any) => cb(prismaProxy)),
  };
  const prismaProxy = prisma;
  const refunds: any = { raise: jest.fn().mockResolvedValue({ id: 'refund-1' }), decide: jest.fn().mockResolvedValue({}) };
  const notifications: any = { create: jest.fn().mockResolvedValue({}) };
  const rateEngine: any = { pickCheapest: jest.fn().mockResolvedValue({ id: 'provider-1' }) };
  const productLedger: any = { reverseSettlement: jest.fn().mockResolvedValue(undefined), chargeUnsettledDeliveryCost: jest.fn().mockResolvedValue(undefined) };
  const service = new ReturnsService(prisma, refunds, notifications, rateEngine, productLedger);
  return { service, prisma, refunds, productLedger };
}

describe('ReturnsService — settlement reversal ratio (H-04)', () => {
  it('a case with NO orderItemId falls back to the existing whole-order customer-price ratio, unchanged', async () => {
    const { service, prisma, productLedger } = makeService();
    prisma.returnShipment.findUnique.mockResolvedValue({
      id: 'rs-1', kind: 'RETURN', orderId: 'order-1', status: 'DELIVERED', inspectionStatus: 'PENDING',
      supportCase: { id: 'case-1', customerId: 'cust-1', orderId: 'order-1', caseNumber: 'SUP-1', evidenceUrls: [], recommendedAmount: 750, requestedRemedy: 'REFUND', orderItemId: null },
    });
    await service.finalize('rs-1', 'ACCEPTED', 'admin-1', 'ADMIN' as any);
    // 750 / 1500 (order.totalAmount from the default mock) = 0.5 — the pre-existing formula.
    expect(productLedger.reverseSettlement).toHaveBeenCalledWith(expect.anything(), 'order-1', 0.5, 'RETURN');
  });

  it('a case naming a SPECIFIC item uses that item\'s own taxable-value share — exact, not blended across the order\'s other (differently-rated) items', async () => {
    const { service, prisma, productLedger } = makeService();
    prisma.returnShipment.findUnique.mockResolvedValue({
      id: 'rs-1', kind: 'RETURN', orderId: 'order-1', status: 'DELIVERED', inspectionStatus: 'PENDING',
      supportCase: { id: 'case-1', customerId: 'cust-1', orderId: 'order-1', caseNumber: 'SUP-1', evidenceUrls: [], recommendedAmount: 750, requestedRemedy: 'REFUND', orderItemId: 'item-a' },
    });
    // Order has 2 items: item-a (taxable 1000, 12% GST) + item-b (taxable 500, 28% GST) —
    // productsTaxableAmount = 1500 combined. Returning ONLY item-a must reverse exactly
    // item-a's own 1000/1500 share, ignoring the customer-price amount (750) entirely.
    prisma.orderItem.findUnique.mockResolvedValue({ taxableValue: 1000 });
    prisma.order.findUnique.mockResolvedValue({ totalAmount: 1620, productsTaxableAmount: 1500, productsAmount: 1500 });
    await service.finalize('rs-1', 'ACCEPTED', 'admin-1', 'ADMIN' as any);
    const ratio = productLedger.reverseSettlement.mock.calls[0][2];
    expect(ratio).toBeCloseTo(1000 / 1500, 10); // exact item share — NOT 750/1620 (the blended figure)
  });

  it('the item-share ratio is clamped at 1 even if the item somehow exceeds the order total (defensive)', async () => {
    const { service, prisma, productLedger } = makeService();
    prisma.returnShipment.findUnique.mockResolvedValue({
      id: 'rs-1', kind: 'RETURN', orderId: 'order-1', status: 'DELIVERED', inspectionStatus: 'PENDING',
      supportCase: { id: 'case-1', customerId: 'cust-1', orderId: 'order-1', caseNumber: 'SUP-1', evidenceUrls: [], recommendedAmount: 100, requestedRemedy: 'REFUND', orderItemId: 'item-a' },
    });
    prisma.orderItem.findUnique.mockResolvedValue({ taxableValue: 2000 });
    prisma.order.findUnique.mockResolvedValue({ totalAmount: 1000, productsTaxableAmount: 1500, productsAmount: 1500 });
    await service.finalize('rs-1', 'ACCEPTED', 'admin-1', 'ADMIN' as any);
    expect(productLedger.reverseSettlement.mock.calls[0][2]).toBe(1);
  });
});

describe('ReturnsService — replacement financial/tax treatment (C-09)', () => {
  it('a REPLACEMENT decision reverses the ORIGINAL order\'s settlement — previously skipped entirely', async () => {
    const { service, prisma, productLedger } = makeService();
    prisma.returnShipment.findUnique.mockResolvedValue({
      id: 'rs-1', kind: 'RETURN', orderId: 'order-1', status: 'DELIVERED', inspectionStatus: 'PENDING',
      supportCase: { id: 'case-1', customerId: 'cust-1', orderId: 'order-1', caseNumber: 'SUP-1', evidenceUrls: [], recommendedAmount: null, requestedRemedy: 'REPLACEMENT', orderItemId: null },
    });
    prisma.order.findFirst.mockResolvedValue(null); // no existing replacement yet
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', customerId: 'cust-1', orderNumber: 'REM-1', addressId: 'addr-1', address: null, paymentMethod: 'ONLINE',
      productsAmount: 1000, productsTaxableAmount: 1000, remontCommission: 80, vendorPayout: 900, productFeeBreakdown: { commission: { amount: 80 } },
      totalAmount: 1180, items: [{ productId: 'p1', quantity: 1, unitPrice: 1000, vendorId: 'seller-a', pickupLocationId: null, gstInclusive: false, gstRatePercent: 18, taxableValue: 1000, gstAmount: 180 }],
    });
    await service.finalize('rs-1', 'ACCEPTED', 'admin-1', 'ADMIN' as any);
    // Whole-order case (no orderItemId) -> full reversal, ratio 1 — this call did not exist
    // at all before the fix.
    expect(productLedger.reverseSettlement).toHaveBeenCalledWith(expect.anything(), 'order-1', 1, 'RETURN');
  });

  it('createReplacementOrder() copies the ORIGINAL order/items\' real GST and fee snapshot instead of leaving every financial field at zero', async () => {
    const { service, prisma } = makeService();
    prisma.order.findFirst.mockResolvedValue(null);
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', customerId: 'cust-1', orderNumber: 'REM-1', addressId: 'addr-1', address: null, paymentMethod: 'ONLINE',
      productsAmount: 1000, productsTaxableAmount: 1000, remontCommission: 80, vendorPayout: 900, productFeeBreakdown: { commission: { amount: 80 } },
      items: [{ productId: 'p1', quantity: 1, unitPrice: 1000, vendorId: 'seller-a', pickupLocationId: null, gstInclusive: false, gstRatePercent: 18, taxableValue: 1000, gstAmount: 180 }],
    });
    await service.createReplacementOrder('order-1', 'admin-1');
    const data = prisma.order.create.mock.calls[0][0].data;
    expect(data.productsTaxableAmount).toBe(1000); // was always 0 before
    expect(data.remontCommission).toBe(80); // was always 0 before
    expect(data.vendorPayout).toBe(900); // was always 0 before
    const item = data.items.create[0];
    expect(item.taxableValue).toBe(1000); // was never set before (undefined)
    expect(item.gstAmount).toBe(180);
    expect(item.gstRatePercent).toBe(18);
    expect(item.totalPrice).toBe(0); // customer is charged nothing new — unchanged, correct
  });
});
