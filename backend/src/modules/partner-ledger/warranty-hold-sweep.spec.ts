import { WarrantyHoldSweepService } from './partner-ledger.module';

/**
 * Vendor Wallet: the daily cron sweep that auto-releases matured Warranty Holds. The query
 * itself (status HELD, type WARRANTY_HOLD, releaseDueAt <= now) is what does the filtering
 * against not-yet-due and non-warranty holds — this test asserts the sweep queries with
 * exactly those conditions and releases everything the query returns, one at a time.
 */
function makeService() {
  const prisma: any = {
    partnerHold: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (fn: any) => fn({})),
  };
  const ledger: any = { releaseHold: jest.fn().mockResolvedValue({}) };
  const service = new WarrantyHoldSweepService(prisma, ledger);
  return { service, prisma, ledger };
}

describe('WarrantyHoldSweepService.sweep', () => {
  it('queries only HELD WARRANTY_HOLD rows whose releaseDueAt has passed', async () => {
    const { service, prisma } = makeService();
    await service.sweep();
    expect(prisma.partnerHold.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'HELD', type: 'WARRANTY_HOLD', releaseDueAt: { lte: expect.any(Date) } },
    }));
  });

  it('releases every matured hold returned by the query', async () => {
    const { service, prisma, ledger } = makeService();
    prisma.partnerHold.findMany.mockResolvedValue([{ id: 'hold-1' }, { id: 'hold-2' }]);
    await service.sweep();
    expect(ledger.releaseHold).toHaveBeenCalledWith(expect.anything(), 'hold-1');
    expect(ledger.releaseHold).toHaveBeenCalledWith(expect.anything(), 'hold-2');
  });

  it('a failure releasing one hold does not stop the rest of the sweep', async () => {
    const { service, prisma, ledger } = makeService();
    prisma.partnerHold.findMany.mockResolvedValue([{ id: 'hold-bad' }, { id: 'hold-good' }]);
    ledger.releaseHold.mockImplementationOnce(() => { throw new Error('boom'); });
    await service.sweep();
    expect(ledger.releaseHold).toHaveBeenCalledWith(expect.anything(), 'hold-good');
  });

  it('does nothing when no holds are due', async () => {
    const { service, ledger } = makeService();
    await service.sweep();
    expect(ledger.releaseHold).not.toHaveBeenCalled();
  });
});
