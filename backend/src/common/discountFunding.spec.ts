import { applySellerFundedDiscountToProductGst, buildDiscountAllocationData, distributeInvoiceDiscount } from './index';

/**
 * Phase 3 (discount/GST/settlement audit, C-02/C-03/M-04) — unit coverage for the pure
 * helpers both checkout paths (MasterOrdersService.checkout(), OrdersService.create()) and
 * invoice generation (InvoicesService.generateForOrder()) share, so the funding/GST/
 * settlement/invoice vocabulary can never drift between them. Integration coverage that
 * exercises these through the real checkout()/generateForOrder() flows lives in
 * master-orders.discountFunding.spec.ts, orders.discountFunding.spec.ts and
 * invoices.discountFunding.spec.ts.
 */

describe('applySellerFundedDiscountToProductGst', () => {
  it('is a no-op when there is no discount', () => {
    const items = [{ taxableValue: 1000, gstAmount: 120 }];
    const result = applySellerFundedDiscountToProductGst(items, 1000, 120, 1000, 0);
    expect(result.ratio).toBe(1);
    expect(result.productsTaxableAmount).toBe(1000);
    expect(result.productGstOnTop).toBe(120);
    expect(result.items[0]).toEqual(items[0]);
  });

  it('scales taxable value and GST by the exact discount ratio for a GST-EXCLUSIVE line', () => {
    // 1000 taxable + 120 GST(12%) on a 1000 group amount, 100 (10%) discount.
    const items = [{ taxableValue: 1000, gstAmount: 120 }];
    const result = applySellerFundedDiscountToProductGst(items, 1000, 120, 1000, 100);
    expect(result.ratio).toBe(0.9);
    expect(result.productsTaxableAmount).toBe(900);
    expect(result.productGstOnTop).toBe(108); // 120 * 0.9 — same 12% effective rate preserved
    expect(result.items[0].taxableValue).toBe(900);
    expect(result.items[0].gstAmount).toBe(108);
  });

  it('scaling an INCLUSIVE line is exactly equivalent to re-resolving GST on the discounted amount', () => {
    // 1180 inclusive @ 18% => taxableValue 1000, gstAmount 180. A 236 (20%) discount means
    // the real discounted gross is 944 — re-resolving GST on 944 gives taxableValue 800,
    // gstAmount 144. Scaling by ratio 0.8 must land on the exact same numbers.
    const items = [{ taxableValue: 1000, gstAmount: 180 }];
    const result = applySellerFundedDiscountToProductGst(items, 1000, 180, 1180, 236);
    expect(result.ratio).toBe(0.8);
    expect(result.productsTaxableAmount).toBe(800);
    expect(result.productGstOnTop).toBe(144);
  });

  it('never produces a negative ratio when the discount exceeds the group amount (defensive clamp)', () => {
    const items = [{ taxableValue: 100, gstAmount: 12 }];
    const result = applySellerFundedDiscountToProductGst(items, 100, 12, 100, 500);
    expect(result.ratio).toBe(0);
    expect(result.productsTaxableAmount).toBe(0);
    expect(result.productGstOnTop).toBe(0);
  });

  it('leaves null taxableValue/gstAmount (legacy pre-Phase-8 items) untouched', () => {
    const items = [{ taxableValue: null, gstAmount: null }];
    const result = applySellerFundedDiscountToProductGst(items as any, 0, 0, 1000, 100);
    expect(result.items[0].taxableValue).toBeNull();
    expect(result.items[0].gstAmount).toBeNull();
  });
});

describe('buildDiscountAllocationData', () => {
  it('records NOT_APPLICABLE_NO_DISCOUNT for a zero-discount order — always written, never skipped', () => {
    const row = buildDiscountAllocationData({ orderId: 'o1', discountAmount: 0, fundingSource: 'PLATFORM', isProductOrder: true });
    expect(row.gstTreatment).toBe('NOT_APPLICABLE_NO_DISCOUNT');
    expect(row.accountingTreatment).toBe('NONE');
    expect(row.taxableValueReduced).toBe(false);
    expect(row.settlementImpact).toBe(0);
    expect(Number(row.customerDiscountAmount)).toBe(0);
  });

  it('a SERVICE order always reduces taxable value and is forced PLATFORM-funded, regardless of the coupon', () => {
    const row = buildDiscountAllocationData({ orderId: 'o1', discountAmount: 100, fundingSource: 'SELLER', isProductOrder: false });
    expect(row.fundingSource).toBe('PLATFORM');
    expect(row.taxableValueReduced).toBe(true);
    expect(row.gstTreatment).toBe('SERVICE_TAXABLE_VALUE_REDUCED_PRE_EXISTING');
    expect(row.accountingTreatment).toBe('PLATFORM_MARKETING_EXPENSE');
    expect(row.settlementImpact).toBe(0);
  });

  it('a PLATFORM-funded PRODUCT order (the default) never reduces taxable value or seller settlement', () => {
    const row = buildDiscountAllocationData({ orderId: 'o1', sellerId: 'seller-1', discountAmount: 100, fundingSource: 'PLATFORM', isProductOrder: true, taxableValueAdjustment: 90 });
    expect(row.taxableValueReduced).toBe(false);
    expect(row.taxableValueAdjustment).toBe(0); // ignored — never applied for PLATFORM funding
    expect(row.settlementImpact).toBe(0);
    expect(row.gstTreatment).toBe('NOT_REDUCED_PLATFORM_FUNDED_PENDING_CA_REVIEW');
    expect(row.accountingTreatment).toBe('PLATFORM_MARKETING_EXPENSE');
  });

  it('a SELLER-funded PRODUCT order with an identified seller reduces taxable value and debits settlement', () => {
    const row = buildDiscountAllocationData({ orderId: 'o1', sellerId: 'seller-1', discountAmount: 100, fundingSource: 'SELLER', isProductOrder: true, taxableValueAdjustment: 90 });
    expect(row.taxableValueReduced).toBe(true);
    expect(row.taxableValueAdjustment).toBe(90);
    expect(row.settlementImpact).toBe(-90);
    expect(row.gstTreatment).toBe('TAXABLE_VALUE_REDUCED_SELLER_FUNDED');
    expect(row.accountingTreatment).toBe('SELLER_BORNE_PRICE_REDUCTION');
  });

  it('a SELLER-funded PRODUCT order with NO identified seller (e.g. multi-vendor cart) cannot be attributed — falls back to platform-funded, unreduced', () => {
    const row = buildDiscountAllocationData({ orderId: 'o1', sellerId: null, discountAmount: 100, fundingSource: 'SELLER', isProductOrder: true });
    expect(row.taxableValueReduced).toBe(false);
    expect(row.gstTreatment).toBe('NOT_REDUCED_PLATFORM_FUNDED_PENDING_CA_REVIEW');
    expect(row.settlementImpact).toBe(0);
  });

  it('a mixed service+product order (OrdersService.create()) with an unreduced product side still flags the service side as reduced', () => {
    const row = buildDiscountAllocationData({
      orderId: 'o1', discountAmount: 100, fundingSource: 'PLATFORM', isProductOrder: true, hasReducedServiceComponent: true,
    });
    expect(row.taxableValueReduced).toBe(true); // the service half really is reduced
    expect(row.gstTreatment).toBe('MIXED_ORDER_SERVICE_COMPONENT_REDUCED_PRODUCT_COMPONENT_NOT');
    expect(row.settlementImpact).toBe(0); // no seller-funded product reduction occurred
  });
});

describe('distributeInvoiceDiscount', () => {
  it('is a no-op for zero discount or an empty line set', () => {
    const lines = [{ description: 'A', qty: 1, rate: 1000, taxRatePercent: 18 }];
    expect(distributeInvoiceDiscount(lines, 0)).toBe(lines);
    expect(distributeInvoiceDiscount([], 100)).toEqual([]);
  });

  it('distributes proportionally by gross share, last line absorbing the rounding remainder', () => {
    const lines = [
      { description: 'A', qty: 1, rate: 300, taxRatePercent: 18 },
      { description: 'B', qty: 1, rate: 700, taxRatePercent: 18 },
    ];
    const result = distributeInvoiceDiscount(lines, 100);
    expect(result[0].discount).toBe(30); // 30% share
    expect(result[1].discount).toBe(70); // 70% share
    expect(result[0].discount! + result[1].discount!).toBe(100); // exact-sum-preserving
  });

  it('never discounts a line below zero even if the requested discount exceeds its gross value', () => {
    const lines = [{ description: 'A', qty: 1, rate: 50, taxRatePercent: 18 }];
    const result = distributeInvoiceDiscount(lines, 500);
    expect(result[0].discount).toBeLessThanOrEqual(50);
  });
});
