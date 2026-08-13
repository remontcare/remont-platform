import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ServiceVendorsService } from './vendors.module';

/**
 * Security regressions for the vendor job-claim boundary.  These tests intentionally
 * exercise the service directly: route-level role checks alone cannot protect customer
 * PII or stop a stale/concurrent claim once a caller already has a vendor JWT.
 */
function makeService() {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn(), update: jest.fn() },
    order: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    orderTimeline: { create: jest.fn().mockResolvedValue({ id: 'timeline-1' }) },
    $transaction: jest.fn(async (fn: any) => fn({
      order: prisma.order,
      serviceVendor: prisma.serviceVendor,
      partnerLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
    })),
  };
  const whatsapp: any = { sendJobAssigned: jest.fn().mockResolvedValue(undefined) };
  const events: any = { emit: jest.fn() };
  // Lead Cost is 0 by default in these tests — acceptJob() skips the debit entirely when
  // the configured amount is 0, keeping the pre-existing claim-lock tests unaffected.
  const ledger: any = { getLeadCostAmount: jest.fn().mockResolvedValue(0), postLeadCost: jest.fn() };
  const service = new ServiceVendorsService(prisma, whatsapp, events, ledger);
  return { service, prisma, whatsapp, events, ledger };
}

function activeVendor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vendor-1',
    userId: 'vendor-user-1',
    status: 'ACTIVE',
    memberStatus: null,
    skills: ['PLUMBING'],
    baseCity: 'Bhopal',
    serviceRadius: 10,
    currentLatitude: null,
    currentLongitude: null,
    ...overrides,
  };
}

function eligibleOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    vendorId: null,
    status: 'CONFIRMED',
    dispatchAttempts: 1,
    serviceId: 'svc-1',
    service: { category: { key: 'PLUMBING' }, fulfillmentType: 'DIRECT_PARTNER' },
    address: {
      city: 'Bhopal',
      latitude: 23.2599,
      longitude: 77.4126,
    },
    ...overrides,
  };
}

describe('ServiceVendorsService security boundary', () => {
  describe('getJobDetail', () => {
    it('does not disclose customer contact/address data for an unassigned job', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor());
      prisma.order.findUnique.mockResolvedValue(eligibleOrder({
        customer: { name: 'Customer Name', phone: '9999999999' },
        address: { fullAddress: '42 Private Street', city: 'Bhopal' },
      }));

      await expect(service.getJobDetail('vendor-user-1', 'order-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows the vendor assigned to the job to retrieve its details', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor());
      const assignedOrder = eligibleOrder({ vendorId: 'vendor-1', customer: { name: 'Customer Name', phone: '9999999999' } });
      prisma.order.findUnique.mockResolvedValue(assignedOrder);

      await expect(service.getJobDetail('vendor-user-1', 'order-1')).resolves.toBe(assignedOrder);
    });
  });

  describe('acceptJob', () => {
    it('rejects a vendor whose account is not ACTIVE before a job can be claimed', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor({ status: 'PENDING_VERIFICATION' }));

      await expect(service.acceptJob('vendor-user-1', 'order-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a job that is not confirmed, even for an active eligible vendor', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor());
      prisma.order.findUnique.mockResolvedValue(eligibleOrder({ status: 'PENDING_PAYMENT' }));

      await expect(service.acceptJob('vendor-user-1', 'order-1')).rejects.toThrow();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a confirmed job outside the vendor skill set', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor({ skills: ['ELECTRICAL'] }));
      prisma.order.findUnique.mockResolvedValue(eligibleOrder());

      await expect(service.acceptJob('vendor-user-1', 'order-1')).rejects.toThrow();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a confirmed job beyond the vendor service radius when both locations are available', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor({
        currentLatitude: 23.2599,
        currentLongitude: 77.4126,
        serviceRadius: 5,
      }));
      prisma.order.findUnique.mockResolvedValue(eligibleOrder({
        address: { city: 'New Delhi', latitude: 28.6139, longitude: 77.209 },
      }));

      await expect(service.acceptJob('vendor-user-1', 'order-1')).rejects.toThrow();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('uses a conditional atomic update to claim one eligible, confirmed job', async () => {
      const { service, prisma, whatsapp, events } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor());
      const availableOrder = eligibleOrder();
      const assignedOrder = {
        ...availableOrder,
        vendorId: 'vendor-1',
        status: 'VENDOR_ASSIGNED',
        customer: { id: 'customer-1' },
      };
      prisma.order.findUnique.mockResolvedValue(availableOrder);
      prisma.order.findUniqueOrThrow.mockResolvedValue(assignedOrder);
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.acceptJob('vendor-user-1', 'order-1')).resolves.toEqual(assignedOrder);

      expect(prisma.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'order-1', vendorId: null, status: 'CONFIRMED' }),
        data: expect.objectContaining({ vendorId: 'vendor-1', status: 'VENDOR_ASSIGNED' }),
      }));
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(whatsapp.sendJobAssigned).toHaveBeenCalledWith('vendor-user-1', assignedOrder);
      expect(events.emit).toHaveBeenCalledWith('job.offer.resolved', { orderId: 'order-1' });
    });

    it('treats a zero-row atomic update as a lost concurrent claim and sends no notification', async () => {
      const { service, prisma, whatsapp, events } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(activeVendor());
      prisma.order.findUnique.mockResolvedValue(eligibleOrder());
      prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.acceptJob('vendor-user-1', 'order-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(whatsapp.sendJobAssigned).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(prisma.orderTimeline.create).not.toHaveBeenCalled();
    });
  });
});
