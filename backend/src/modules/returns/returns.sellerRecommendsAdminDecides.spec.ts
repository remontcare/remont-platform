import { BadRequestException } from '@nestjs/common';
import { ReturnsService } from './returns.module';

/**
 * Phase 6 — seller-recommends / admin-decides. The seller's own call
 * (recordSellerRecommendation) must NEVER be able to move inspectionStatus off PENDING or
 * trigger a refund/replacement — only finalize() (admin-only, via AdminService.adminDecideReturn)
 * actually executes anything.
 */
function makeService() {
  const prisma: any = {
    returnShipment: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
    supportCase: { update: jest.fn() },
    supportCaseLog: { create: jest.fn().mockResolvedValue({}) },
    order: { findFirst: jest.fn(), findUnique: jest.fn().mockResolvedValue({ totalAmount: 500 }), count: jest.fn().mockResolvedValue(0), create: jest.fn() },
    orderTimeline: { create: jest.fn().mockResolvedValue({ id: 'timeline-1' }) },
    shipment: { update: jest.fn() },
    $transaction: jest.fn((cb: any) => cb(prismaProxy)),
  };
  const prismaProxy = prisma;
  const refunds: any = { raise: jest.fn().mockResolvedValue({ id: 'refund-1' }), decide: jest.fn().mockResolvedValue({}) };
  const notifications: any = { create: jest.fn().mockResolvedValue({}) };
  const rateEngine: any = { pickCheapest: jest.fn().mockResolvedValue({ id: 'provider-1', name: 'Mock Economy' }) };
  const productLedger: any = { reverseSettlement: jest.fn().mockResolvedValue(undefined), chargeUnsettledDeliveryCost: jest.fn().mockResolvedValue(undefined) };
  const service = new ReturnsService(prisma, refunds, notifications, rateEngine, productLedger);
  return { service, prisma, refunds, rateEngine, productLedger };
}

describe('ReturnsService — seller recommends, admin decides', () => {
  it('recordSellerRecommendation writes ONLY the recommendation fields, never inspectionStatus', async () => {
    const { service, prisma } = makeService();
    prisma.returnShipment.findUnique.mockResolvedValue({ id: 'rs-1', status: 'DELIVERED', inspectionStatus: 'PENDING' });
    await service.recordSellerRecommendation('rs-1', 'ACCEPTED', 'seller-user-1', 'Looks fine');
    expect(prisma.returnShipment.update).toHaveBeenCalledWith({
      where: { id: 'rs-1' },
      data: expect.objectContaining({ sellerRecommendation: 'ACCEPTED', sellerRecommendationNotes: 'Looks fine' }),
    });
    const callData = prisma.returnShipment.update.mock.calls[0][0].data;
    expect(callData.inspectionStatus).toBeUndefined();
  });

  it('rejects a seller recommendation once admin has already decided (inspectionStatus no longer PENDING)', async () => {
    const { service, prisma } = makeService();
    prisma.returnShipment.findUnique.mockResolvedValue({ id: 'rs-1', status: 'DELIVERED', inspectionStatus: 'ACCEPTED' });
    await expect(service.recordSellerRecommendation('rs-1', 'ACCEPTED', 'seller-user-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('finalize() (admin-only) still works exactly as before — a seller recommendation never blocks it', async () => {
    const { service, prisma, refunds } = makeService();
    prisma.returnShipment.findUnique.mockResolvedValue({
      id: 'rs-1', kind: 'RETURN', orderId: 'order-1', status: 'DELIVERED', inspectionStatus: 'PENDING',
      sellerRecommendation: 'ACCEPTED', // seller already recommended — admin now makes the real call
      supportCase: { id: 'case-1', customerId: 'cust-1', orderId: 'order-1', caseNumber: 'SUP-000001', evidenceUrls: [], recommendedAmount: 500, requestedRemedy: 'REFUND' },
    });
    await service.finalize('rs-1', 'ACCEPTED', 'admin-1', 'ADMIN' as any, 'Confirmed good condition');
    expect(refunds.raise).toHaveBeenCalled();
    // Pre-existing (Phase 5) behaviour, unmodified by Phase 6: the wallet-credit decision is
    // always attributed to 'SYSTEM' here, regardless of which admin actually decided.
    expect(refunds.decide).toHaveBeenCalledWith('SYSTEM', 'refund-1', 'WALLET_CREDIT', expect.objectContaining({ approvedAmount: 500 }));
  });
});

describe('ReturnsService — RTO (return-to-origin)', () => {
  it('initiateRto marks the outbound Shipment CANCELLED and creates a PICKED_UP-stage RTO ReturnShipment via the cheapest provider', async () => {
    const { service, prisma, rateEngine } = makeService();
    await service.initiateRto({ id: 'order-1', orderNumber: 'REM-1' }, 'ship-1', 'cust-1', 'Changed my mind');
    expect(prisma.shipment.update).toHaveBeenCalledWith({ where: { id: 'ship-1' }, data: { status: 'CANCELLED' } });
    expect(rateEngine.pickCheapest).toHaveBeenCalled();
    expect(prisma.returnShipment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderId: 'order-1', kind: 'RTO', status: 'PICKED_UP', logisticsProviderId: 'provider-1' }),
    });
  });

  it('finalizeRto refunds via the existing RefundsService once the RTO reaches the seller', async () => {
    const { service, prisma, refunds } = makeService();
    prisma.returnShipment.findUnique.mockResolvedValue({
      id: 'rto-1', kind: 'RTO', orderId: 'order-1', status: 'DELIVERED', inspectionStatus: 'PENDING',
      order: { id: 'order-1', orderNumber: 'REM-1', customerId: 'cust-1', totalAmount: 750 },
    });
    await service.finalizeRto('rto-1', 'admin-1', 'ADMIN' as any, 'RTO settled');
    expect(refunds.raise).toHaveBeenCalledWith('cust-1', 'order-1', undefined, expect.stringContaining('RTO'), []);
    expect(refunds.decide).toHaveBeenCalledWith('admin-1', 'refund-1', 'WALLET_CREDIT', expect.objectContaining({ approvedAmount: 750 }));
  });

  it('finalize() refuses to run on an RTO shipment — must use finalizeRto() instead', async () => {
    const { service, prisma } = makeService();
    prisma.returnShipment.findUnique.mockResolvedValue({ id: 'rto-1', kind: 'RTO', status: 'DELIVERED', inspectionStatus: 'PENDING' });
    await expect(service.finalize('rto-1', 'ACCEPTED', 'admin-1', 'ADMIN' as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});
