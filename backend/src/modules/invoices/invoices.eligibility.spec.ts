import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { InvoicesService, assertInvoiceEligible } from './invoices.module';

/**
 * Server-side invoice guard — a tax invoice is permanent, so a NEW one may only be issued
 * for an order that is a real sale: a product order its seller has accepted, never one
 * that is pending, unaccepted, rejected, cancelled/refunded or in an unknown status.
 */
function makeService(order: any, existingInvoice: any = null) {
  const prisma: any = {
    order: { findUnique: jest.fn(async () => order), update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })) },
    invoice: {
      findUnique: jest.fn(async () => existingInvoice),
      create: jest.fn(async (args: any) => ({ id: 'inv-1', ...args.data })),
    },
    siteSetting: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    taxConfig: { findMany: jest.fn(async () => []) },
  };
  let seq = 0;
  prisma.$queryRaw = jest.fn(async () => [{ lastNumber: ++seq }]);
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return { svc: new InvoicesService(prisma), prisma };
}

const SELLER_USER = 'seller-user';
function productOrder(overrides: any = {}) {
  return {
    id: 'o1', customerId: 'cust-1', vendor: null, invoice: null, orderNumber: 'REM-1', type: 'PRODUCT',
    status: 'CONFIRMED', paymentStatus: 'PAID', productFulfillmentStage: 'SELLER_ACCEPTED',
    subtotal: 1000, totalAmount: 1180, gstAmount: 180, serviceAmount: 0, remontCommission: 0, platformCharges: 0,
    snapshotState: 'Madhya Pradesh', billingTransactionType: null, couponDiscount: 0, membershipDiscount: 0, discountAllocation: null,
    service: null, serviceItems: [], extraWorkItems: [],
    items: [{
      quantity: 1, unitPrice: 1000,
      product: { name: 'Widget', hsnSac: null, gstOverridePercent: null, gstInclusive: null, categoryId: 'cat-1', unit: 'piece',
        vendor: { userId: SELLER_USER, businessName: 'Seller Co', address: 'Addr', gstNumber: '23AAAAA0000A1Z5', state: 'Madhya Pradesh' } },
    }],
    ...overrides,
  };
}

describe('Invoice eligibility guard', () => {
  it('accepted order → invoice allowed (seller endpoint, full engine)', async () => {
    const { svc, prisma } = makeService(productOrder());
    await expect(svc.generate(SELLER_USER, 'o1')).resolves.toMatchObject({ id: 'inv-1' });
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
  });

  it.each(['PROCESSING', 'READY_FOR_PICKUP', 'HANDED_TO_LOGISTICS'])('later fulfilment stage %s → allowed', (stage) => {
    expect(() => assertInvoiceEligible({ status: 'CONFIRMED', productFulfillmentStage: stage })).not.toThrow();
  });

  it('completed service order (no fulfilment stage) → allowed', () => {
    expect(() => assertInvoiceEligible({ status: 'COMPLETED', productFulfillmentStage: null })).not.toThrow();
  });

  it.each([
    ['rejected', { productFulfillmentStage: 'SELLER_REJECTED' }, /rejected by the seller/],
    ['unaccepted / new', { productFulfillmentStage: 'AWAITING_SELLER' }, /not been accepted/],
    ['pending payment', { status: 'PENDING_PAYMENT', productFulfillmentStage: 'AWAITING_SELLER' }, /not been accepted|pending payment/],
    ['pending payment (no stage)', { status: 'PENDING_PAYMENT', productFulfillmentStage: null }, /pending payment/],
    ['cancelled', { status: 'CANCELLED' }, /cancelled/],
    ['refunded', { status: 'REFUNDED' }, /refunded/],
    ['invalid status', { status: 'SOMETHING_ELSE' }, /order status "SOMETHING_ELSE"/],
    ['missing status', { status: undefined }, /order status "unknown"/],
    ['invalid stage', { productFulfillmentStage: 'TELEPORTED' }, /fulfilment stage "TELEPORTED"/],
  ])('%s order → blocked with a business error, no invoice created', async (_label, overrides, msg) => {
    const { svc, prisma } = makeService(productOrder(overrides));
    const err = await svc.generate(SELLER_USER, 'o1').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(msg);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('the guard also covers the internal/admin path (generateForOrder)', async () => {
    const { svc, prisma } = makeService(productOrder({ productFulfillmentStage: 'SELLER_REJECTED' }));
    await expect(svc.generateForOrder('o1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it('an invoice issued earlier stays downloadable even if the order is later cancelled', async () => {
    const existing = { id: 'inv-old', invoiceNumber: 'INV-1' };
    const { svc, prisma } = makeService(productOrder({ status: 'CANCELLED' }), existing);
    await expect(svc.generateForOrder('o1')).resolves.toBe(existing);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it('ownership is still checked before eligibility', async () => {
    const { svc } = makeService(productOrder());
    await expect(svc.generate('someone-else', 'o1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
