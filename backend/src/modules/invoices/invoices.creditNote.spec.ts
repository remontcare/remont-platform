import { InvoicesService } from './invoices.module';

/**
 * Phase 6 (C-06) — InvoicesService.issueCreditNote(): the formal GST correction record for
 * a post-invoice refund. Must never touch the original (immutable, Phase 4) Invoice row,
 * must reuse its already-computed GST figures (no duplicate tax calculation), and must be
 * a no-op when there's no Invoice to correct in the first place.
 */
function makeService() {
  const prisma: any = {
    invoice: { findUnique: jest.fn(), update: jest.fn() },
    creditNote: { create: jest.fn(async (args: any) => ({ id: 'cn-1', ...args.data })) },
    $queryRaw: jest.fn(async () => [{ lastNumber: 1 }]),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return { svc: new InvoicesService(prisma), prisma };
}

describe('InvoicesService.issueCreditNote (C-06)', () => {
  it('returns null when the order has no Invoice at all — nothing was ever formally invoiced, nothing to correct', async () => {
    const { svc, prisma } = makeService();
    prisma.invoice.findUnique.mockResolvedValue(null);
    const result = await svc.issueCreditNote('order-1', 'rr-1', 300, 'Defective item');
    expect(result).toBeNull();
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
  });

  it('returns null for a zero or negative refund amount', async () => {
    const { svc, prisma } = makeService();
    const result = await svc.issueCreditNote('order-1', 'rr-1', 0, 'n/a');
    expect(result).toBeNull();
    expect(prisma.invoice.findUnique).not.toHaveBeenCalled();
  });

  it('a partial refund reverses GST proportionally, reusing the invoice\'s OWN already-computed figures — never re-deriving GST', async () => {
    const { svc, prisma } = makeService();
    prisma.invoice.findUnique.mockResolvedValue({
      id: 'inv-1', customerSubtotal: 1000, customerCgst: 90, customerSgst: 90, customerIgst: 0, customerTotal: 1180,
    });
    const cn = (await svc.issueCreditNote('order-1', 'rr-1', 590, 'Half returned'))!; // 590/1180 = 50%
    expect(cn.invoiceId).toBe('inv-1');
    expect(cn.orderId).toBe('order-1');
    expect(cn.refundRequestId).toBe('rr-1');
    expect(cn.taxableValueReversed).toBe(500); // 1000 * 0.5
    expect(cn.cgstReversed).toBe(45); // 90 * 0.5
    expect(cn.sgstReversed).toBe(45);
    expect(cn.totalReversed).toBe(590);
    expect(cn.creditNoteNumber).toMatch(/^INV-CN-\d{4}-\d{2}-\d{6}$/); // its own series, distinct from every invoice series
  });

  it('a full refund reverses 100% of the invoice\'s GST, capped at the invoice total even if the refund somehow exceeds it', async () => {
    const { svc, prisma } = makeService();
    prisma.invoice.findUnique.mockResolvedValue({
      id: 'inv-1', customerSubtotal: 1000, customerCgst: 90, customerSgst: 90, customerIgst: 0, customerTotal: 1180,
    });
    const cn = (await svc.issueCreditNote('order-1', 'rr-1', 5000, 'Full refund — customer overpaid check'))!;
    expect(cn.taxableValueReversed).toBe(1000);
    expect(cn.cgstReversed).toBe(90);
    expect(cn.totalReversed).toBe(1180); // capped at the actual invoice total, not the (larger) requested amount
  });

  it('an inter-state invoice reverses IGST instead of CGST/SGST', async () => {
    const { svc, prisma } = makeService();
    prisma.invoice.findUnique.mockResolvedValue({
      id: 'inv-1', customerSubtotal: 1000, customerCgst: 0, customerSgst: 0, customerIgst: 180, customerTotal: 1180,
    });
    const cn = (await svc.issueCreditNote('order-1', 'rr-1', 1180, 'Full refund'))!;
    expect(cn.igstReversed).toBe(180);
    expect(cn.cgstReversed).toBe(0);
    expect(cn.sgstReversed).toBe(0);
  });

  it('never mutates the original Invoice row — only ever reads it', async () => {
    const { svc, prisma } = makeService();
    prisma.invoice.findUnique.mockResolvedValue({
      id: 'inv-1', customerSubtotal: 1000, customerCgst: 90, customerSgst: 90, customerIgst: 0, customerTotal: 1180,
    });
    await svc.issueCreditNote('order-1', 'rr-1', 590, 'Half returned');
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });
});
