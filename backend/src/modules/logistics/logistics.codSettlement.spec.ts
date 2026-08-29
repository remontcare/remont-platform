import { BadRequestException } from '@nestjs/common';
import { ShipmentService, LogisticsService } from './logistics.module';

/**
 * Phase 5 — COD settlement ladder (COD_EXPECTED -> COD_COLLECTED -> COD_SETTLEMENT_PENDING ->
 * COD_SETTLED -> COD_RECONCILED). Every step is guarded by an explicit adjacency check so a
 * stale/duplicate/out-of-order call is rejected, not silently ignored.
 */
function makeService() {
  const prisma: any = {
    shipment: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn(), create: jest.fn() },
    order: { findUnique: jest.fn(), update: jest.fn() },
    orderTimeline: { create: jest.fn().mockResolvedValue({ id: 'timeline-1' }) },
  };
  const logistics: any = {};
  const mockProvider: any = { name: 'MOCK_DEMO' };
  const rateEngine: any = { pickCostReferenceProvider: jest.fn().mockResolvedValue(null) };
  const productLedger: any = { settleProductOrder: jest.fn() };
  const service = new ShipmentService(prisma, logistics as LogisticsService, mockProvider, rateEngine, productLedger);
  return { service, prisma };
}

describe('ShipmentService — COD settlement ladder', () => {
  it('allows COD_EXPECTED -> COD_COLLECTED', async () => {
    const { service, prisma } = makeService();
    prisma.shipment.findUnique.mockResolvedValue({ id: 'ship-1', orderId: 'order-1', codSettlementStatus: 'COD_EXPECTED' });
    await service.markCodCollected('ship-1', 'partner-1');
    expect(prisma.shipment.update).toHaveBeenCalledWith({
      where: { id: 'ship-1' },
      data: expect.objectContaining({ codSettlementStatus: 'COD_COLLECTED', codCollectedBy: 'partner-1' }),
    });
  });

  it('rejects collecting COD twice (already COD_COLLECTED)', async () => {
    const { service, prisma } = makeService();
    prisma.shipment.findUnique.mockResolvedValue({ id: 'ship-1', orderId: 'order-1', codSettlementStatus: 'COD_COLLECTED' });
    await expect(service.markCodCollected('ship-1', 'partner-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects settling a shipment that has not been handed over yet (skips a rung)', async () => {
    const { service, prisma } = makeService();
    prisma.shipment.findUnique.mockResolvedValue({ id: 'ship-1', orderId: 'order-1', codSettlementStatus: 'COD_COLLECTED' });
    await expect(service.codSettle('ship-1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows the full ladder in order: SETTLEMENT_PENDING -> SETTLED -> RECONCILED', async () => {
    const { service, prisma } = makeService();
    prisma.shipment.findUnique.mockResolvedValue({ id: 'ship-1', orderId: 'order-1', codSettlementStatus: 'COD_SETTLEMENT_PENDING' });
    await service.codSettle('ship-1', 'admin-1');
    expect(prisma.shipment.update).toHaveBeenCalledWith({
      where: { id: 'ship-1' },
      data: expect.objectContaining({ codSettlementStatus: 'COD_SETTLED' }),
    });

    prisma.shipment.findUnique.mockResolvedValue({ id: 'ship-1', orderId: 'order-1', codSettlementStatus: 'COD_SETTLED' });
    await service.codReconcile('ship-1', 'admin-1');
    expect(prisma.shipment.update).toHaveBeenCalledWith({
      where: { id: 'ship-1' },
      data: expect.objectContaining({ codSettlementStatus: 'COD_RECONCILED' }),
    });
  });

  it('codSettleBatch skips (does not fail) a shipment already past the target state', async () => {
    const { service, prisma } = makeService();
    prisma.shipment.findUnique
      .mockResolvedValueOnce({ id: 'ship-1', orderId: 'order-1', codSettlementStatus: 'COD_SETTLEMENT_PENDING' })
      .mockResolvedValueOnce({ id: 'ship-2', orderId: 'order-2', codSettlementStatus: 'COD_RECONCILED' });
    const result = await service.codSettleBatch(['ship-1', 'ship-2'], 'admin-1');
    expect(result.settled).toEqual(['ship-1']);
    expect(result.skipped).toEqual(['ship-2']);
  });

  it('createShipmentForOrder is a no-op guard when the seller has not marked ready-for-pickup', async () => {
    const { service, prisma } = makeService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'order-1', items: [{ product: { id: 'p1', vendor: { pickupLocations: [] } } }], addressId: 'addr-1',
      productFulfillmentStage: 'PROCESSING',
    });
    await service.createShipmentForOrder('order-1');
    expect(prisma.shipment.create).not.toHaveBeenCalled();
  });
});
