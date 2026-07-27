import { computeInvoiceBreakdown } from './index';

describe('computeInvoiceBreakdown', () => {
  const baseInput = {
    orderNumber: 'REM-0001',
    subtotal: 1000,
    totalAmount: 1180,
    gstAmount: 180,
    serviceAmount: 1000,
    remontCommission: 150,
    approvedExtraWorkAmount: 0,
  };

  it('splits GST evenly into CGST/SGST on the customer side', () => {
    const b = computeInvoiceBreakdown(baseInput, 0);
    expect(b.customerCgst).toBe(90);
    expect(b.customerSgst).toBe(90);
    expect(b.customerCgst + b.customerSgst).toBe(baseInput.gstAmount);
  });

  it('folds approved extra-work amount into vendor labor', () => {
    const b = computeInvoiceBreakdown({ ...baseInput, approvedExtraWorkAmount: 500 }, 0);
    expect(b.vendorLabor).toBe(1500);
  });

  it('numbers invoices sequentially as INV-<orderNumber>-<seq>', () => {
    expect(computeInvoiceBreakdown(baseInput, 0).invoiceNumber).toBe('INV-REM-0001-0001');
    expect(computeInvoiceBreakdown(baseInput, 41).invoiceNumber).toBe('INV-REM-0001-0042');
  });

  it('defaults the Remont booking fee to 49 and lets it be overridden', () => {
    expect(computeInvoiceBreakdown(baseInput, 0).bookingFee).toBe(49);
    expect(computeInvoiceBreakdown(baseInput, 0, 99).bookingFee).toBe(99);
  });

  it('produces the same numbers regardless of call site — the bug this replaces was three drifting copies', () => {
    const a = computeInvoiceBreakdown(baseInput, 3);
    const b = computeInvoiceBreakdown({ ...baseInput }, 3);
    expect(a).toEqual(b);
  });
});
