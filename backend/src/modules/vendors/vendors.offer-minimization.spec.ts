import { ServiceVendorsService } from './vendors.module';
import { JobRingPolicyService } from '../notification-engine/job-ring-policy.service';
import { partnerOfferView } from '../../common';

/**
 * Data minimization for an UNCLAIMED job offer: available-jobs, the scheduled preview and the
 * job-offer ring payload (socket + stored Notification rows) must carry only what the partner
 * apps render — never the full Order row (customer contact/address, payment, OTP, internal
 * routing/dispatch fields).
 */

// A full Order row as Prisma would return it with `include`, including sensitive columns.
const fullOrder = {
  id: 'order-1', orderNumber: 'ORD-1', status: 'CONFIRMED', vendorId: null,
  totalAmount: '500.00', serviceAmount: '450.00', vendorPayout: '400.00',
  createdAt: new Date('2026-10-07T04:00:00Z'), slotStart: null, slotEnd: null,
  // ↓ must never leave the server for an unclaimed offer
  customerId: 'cust-1', startOtp: '1234', endOtp: '5678', paymentStatus: 'PAID', paymentMethod: 'ONLINE',
  walletUsed: '0', remontCommission: '100', adminNotes: 'VIP', routingDecision: 'MANUAL_FALLBACK',
  dispatchAttempts: 1, leadCostAmount: '50', snapshotGpsLat: 23.2, couponCode: 'X',
  customer: { name: 'Asha', phone: '9999999999' },
  service: { name: 'Fan Installation', categoryId: 'cat-1', category: { key: 'ELECTRICAL' }, basePrice: 999, fulfillmentType: 'DIRECT_PARTNER' },
  address: { city: 'Bhopal', area: 'Arera Colony', fullAddress: 'H-12, Street 4', pincode: '462016', landmark: 'Temple', latitude: 23.21, longitude: 77.43 },
};

const ALLOWED = ['id', 'orderNumber', 'status', 'vendorId', 'totalAmount', 'serviceAmount', 'vendorPayout', 'createdAt', 'slotStart', 'slotEnd', 'service', 'address', 'distanceKm', 'releaseAt'];
const FORBIDDEN = ['customerId', 'customer', 'startOtp', 'endOtp', 'paymentStatus', 'paymentMethod', 'walletUsed', 'remontCommission', 'adminNotes', 'routingDecision', 'dispatchAttempts', 'leadCostAmount', 'snapshotGpsLat', 'couponCode'];

function expectMinimal(view: any) {
  for (const k of Object.keys(view)) expect(ALLOWED).toContain(k);
  for (const k of FORBIDDEN) expect(view).not.toHaveProperty(k);
  expect(Object.keys(view.address).sort()).toEqual(['area', 'city']);
  expect(Object.keys(view.service).sort()).toEqual(['categoryId', 'name']);
}

describe('partnerOfferView', () => {
  it('keeps only the allowlisted fields (no address detail, contact, payment, OTP or internal data)', () => {
    const view = partnerOfferView(fullOrder);
    expectMinimal(view);
    expect(view).toMatchObject({ id: 'order-1', totalAmount: 500, address: { city: 'Bhopal', area: 'Arera Colony' }, service: { name: 'Fan Installation' } });
  });
});

describe('availableJobs response', () => {
  it('selects only offer columns from the DB and returns minimal objects with distance', async () => {
    const prisma: any = {
      serviceVendor: { findUnique: jest.fn().mockResolvedValue({
        id: 'v1', userId: 'u1', status: 'ACTIVE', memberStatus: null, skills: ['ELECTRICAL'], baseCity: 'Bhopal', serviceRadius: 20,
        currentLatitude: 23.25, currentLongitude: 77.41, lastLocationUpdate: new Date(),
      }) },
      order: { findMany: jest.fn().mockResolvedValue([fullOrder]) },
    };
    const service = new ServiceVendorsService(prisma, {} as any, { emit: jest.fn() } as any, {} as any);
    const [job] = await service.availableJobs('u1');

    const query = prisma.order.findMany.mock.calls[0][0];
    expect(query.include).toBeUndefined();
    expect(query.select.customer).toBeUndefined();
    expect(query.select.startOtp).toBeUndefined();
    expect(query.select.address.select.fullAddress).toBeUndefined();

    expectMinimal(job);
    expect(typeof job.distanceKm).toBe('number');
  });
});

describe('job-offer ring payload (socket + stored notification)', () => {
  it('sends the minimal offer view, never the full order', async () => {
    const engine: any = { notify: jest.fn().mockResolvedValue(undefined) };
    const ring = new JobRingPolicyService({} as any, engine, { emit: jest.fn() } as any);
    await ring.onJobOffer({ vendorUserId: 'u1', orderId: 'order-1', order: fullOrder });

    const sent = engine.notify.mock.calls[0][0];
    expectMinimal(sent.data.order);
    expect(sent.body).toContain('Arera Colony');
    expect(sent.body).not.toContain('H-12');
  });

  it('keeps vendorId so the app can tell an already-assigned job apart', async () => {
    const engine: any = { notify: jest.fn().mockResolvedValue(undefined) };
    const ring = new JobRingPolicyService({} as any, engine, { emit: jest.fn() } as any);
    await ring.onJobOffer({ vendorUserId: 'u1', orderId: 'order-1', order: { ...fullOrder, vendorId: 'v1' } });
    expect(engine.notify.mock.calls[0][0].data.order.vendorId).toBe('v1');
  });
});
