import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.module';

/**
 * LedgerEntryType.ADJUSTMENT existed in the schema with zero write path anywhere in the
 * codebase — no way to record a manual correction (goodwill credit, data-entry fix,
 * clawing back an accidental overpayment). postLedgerAdjustment() mirrors createAdminHold's
 * exact pattern: validate, post through the ledger inside one transaction, keep
 * pendingPayout in sync.
 */
function makeService() {
  const vendor = { id: 'v1' };
  const prisma: any = {
    serviceVendor: {
      findUnique: jest.fn().mockResolvedValue(vendor),
      update: jest.fn().mockResolvedValue(vendor),
    },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const config: any = { get: jest.fn((_key: string, def: any) => def) };
  const payments: any = {};
  const settlements: any = {};
  const cities: any = {};
  const events: any = { emit: jest.fn() };
  const ledger: any = { postEntry: jest.fn().mockResolvedValue({ id: 'entry-1' }) };
  const svc = new AdminService(prisma, config, payments, settlements, cities, events, ledger, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma, ledger };
}

describe('AdminService.postLedgerAdjustment', () => {
  it('rejects a zero amount', async () => {
    const { svc } = makeService();
    await expect(svc.postLedgerAdjustment('v1', 0, 'goodwill credit', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-finite amount', async () => {
    const { svc } = makeService();
    await expect(svc.postLedgerAdjustment('v1', NaN, 'goodwill credit', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing reason', async () => {
    const { svc } = makeService();
    await expect(svc.postLedgerAdjustment('v1', 100, '  ', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s on an unknown vendor', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValueOnce(null);
    await expect(svc.postLedgerAdjustment('missing', 100, 'goodwill credit', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('posts a positive ADJUSTMENT entry and increments pendingPayout for a credit', async () => {
    const { svc, prisma, ledger } = makeService();
    await svc.postLedgerAdjustment('v1', 250, 'goodwill credit', 'admin-1');
    expect(ledger.postEntry).toHaveBeenCalledWith(
      expect.anything(), 'v1', 'ADJUSTMENT', 250,
      expect.objectContaining({ createdBy: 'admin-1', notes: 'goodwill credit' }),
    );
    expect(prisma.serviceVendor.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { pendingPayout: { increment: 250 } },
    });
  });

  it('posts a negative ADJUSTMENT entry and decrements pendingPayout for a debit', async () => {
    const { svc, prisma, ledger } = makeService();
    await svc.postLedgerAdjustment('v1', -150, 'clawing back overpayment', 'admin-1');
    expect(ledger.postEntry).toHaveBeenCalledWith(
      expect.anything(), 'v1', 'ADJUSTMENT', -150,
      expect.objectContaining({ notes: 'clawing back overpayment' }),
    );
    expect(prisma.serviceVendor.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { pendingPayout: { increment: -150 } },
    });
  });

  it('writes an audit log entry for the adjustment', async () => {
    const { svc, prisma } = makeService();
    await svc.postLedgerAdjustment('v1', 250, 'goodwill credit', 'admin-1');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'VENDOR_LEDGER_ADJUSTMENT' }),
    }));
  });
});
