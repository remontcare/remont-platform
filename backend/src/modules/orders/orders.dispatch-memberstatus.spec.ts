import { DispatchService, RoutingService } from './orders.module';
import { NOT_FROZEN_MEMBER_FILTER } from '../../common';

/**
 * Regression coverage for a production incident: ServiceVendor.memberStatus is nullable
 * (null = independent/non-agency vendor, not "frozen"). A bare `memberStatus: { not:
 * 'FROZEN' }` compiles to SQL `<> 'FROZEN'`, and NULL <> 'FROZEN' evaluates to UNKNOWN under
 * three-valued SQL logic — so that filter silently excluded every non-agency vendor from
 * DispatchService.dispatch() and RoutingService.route() candidate queries. In production this
 * meant automatic dispatch (and, after this session's admin-vendor-list addition, manual
 * assignment too) returned zero candidates for any city/skill where only independent
 * (non-agency) vendors were online — exactly the "vendor is online, nothing shows up, neither
 * automatic nor manual" symptom that surfaced this bug. Fixed via the shared
 * NOT_FROZEN_MEMBER_FILTER (common/index.ts): `OR: [{ memberStatus: null }, { memberStatus:
 * { not: FROZEN } }]`.
 */
describe('Non-agency (memberStatus: null) vendor eligibility', () => {
  describe('DispatchService.dispatch', () => {
    function makeService() {
      const prisma: any = {
        order: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
        serviceVendor: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const events: any = { emit: jest.fn() };
      const service = new DispatchService(prisma, events);
      return { service, prisma, events };
    }

    it('uses the null-safe NOT_FROZEN_MEMBER_FILTER, not a bare memberStatus:{not:FROZEN}', async () => {
      const { service, prisma } = makeService();
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1', orderNumber: 'ORD-1',
        address: { latitude: 23.25, longitude: 77.41 },
        service: { category: { key: 'ELECTRICAL' } },
      });

      await service.dispatch('order-1');

      expect(prisma.serviceVendor.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining(NOT_FROZEN_MEMBER_FILTER),
      }));
    });

    it('includes an online, in-radius, non-agency (memberStatus: null) vendor as a dispatch candidate', async () => {
      const { service, prisma, events } = makeService();
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1', orderNumber: 'ORD-1',
        address: { latitude: 23.25, longitude: 77.41 },
        service: { category: { key: 'ELECTRICAL' } },
      });
      prisma.serviceVendor.findMany.mockResolvedValue([{
        id: 'vendor-1', userId: 'vendor-user-1', memberStatus: null,
        currentLatitude: 23.2748554, currentLongitude: 77.4463786,
        serviceRadius: 10, rating: 5, isVipPro: false,
      }]);

      const top = await service.dispatch('order-1');

      expect(top).toHaveLength(1);
      expect(top[0].vendorId).toBe('vendor-1');
      expect(events.emit).toHaveBeenCalledWith('job.offer.created', expect.objectContaining({ vendorUserId: 'vendor-user-1', orderId: 'order-1' }));
    });
  });

  describe('RoutingService.route — candidate query', () => {
    function makeService() {
      const prisma: any = {
        order: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
        serviceVendor: { findMany: jest.fn().mockResolvedValue([]) },
        orderTimeline: { create: jest.fn().mockResolvedValue({}) },
      };
      const events: any = { emit: jest.fn() };
      const dispatch: any = { dispatch: jest.fn(async () => []) };
      const service = new RoutingService(prisma, events, dispatch);
      return { service, prisma, events, dispatch };
    }

    it('uses the null-safe NOT_FROZEN_MEMBER_FILTER for the DIRECT_PARTNER candidate query', async () => {
      const { service, prisma } = makeService();
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1', orderNumber: 'ORD-1',
        service: { fulfillmentType: 'DIRECT_PARTNER', requiredSkills: [] },
        address: { city: 'Bhopal' },
      });

      await service.route('order-1');

      expect(prisma.serviceVendor.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining(NOT_FROZEN_MEMBER_FILTER),
      }));
    });
  });
});
