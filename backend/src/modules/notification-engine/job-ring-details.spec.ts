import { buildJobRingDetails, distanceBetween } from './job-ring-details';
import { JobRingPolicyService } from './job-ring-policy.service';

/**
 * The partner's incoming-job call must announce location, confirmed date and time, amount and
 * current distance — from the order's own (latest) slot and the partner's latest valid GPS.
 */
const NOW = new Date('2026-10-09T06:00:00Z'); // 11:30 IST
const SLOT = '2026-10-12T11:00:00Z'; // Monday 12 October, 4:30 PM IST
const ORDER = {
  totalAmount: '1200.00', slotStart: SLOT,
  address: { area: 'Arera Colony', city: 'Bhopal', latitude: 23.2156, longitude: 77.4304 },
};
const FRESH_GPS = { latitude: 23.2599, longitude: 77.4126, updatedAt: new Date(NOW.getTime() - 10 * 60 * 1000) };

describe('buildJobRingDetails', () => {
  it('complete details, in order: location, date, time, amount, distance', () => {
    const d = buildJobRingDetails(ORDER, FRESH_GPS, NOW);
    expect(d).toMatchObject({ location: 'Arera Colony, Bhopal', date: 'Monday, 12 October', time: '4:30 PM', amount: '₹1,200', distanceKm: 5.3, distance: '5.3 km' });
    expect(d.spoken).toBe('Location: Arera Colony, Bhopal. Date: Monday, 12 October. Time: 4:30 PM. Amount: ₹1,200. Distance: 5.3 km away.');
  });

  it('uses the confirmed appointment in IST, never the time the ring fires', () => {
    const late = buildJobRingDetails(ORDER, FRESH_GPS, new Date('2026-10-11T22:00:00Z'));
    expect(late.date).toBe('Monday, 12 October');
    expect(late.time).toBe('4:30 PM');
    // 23:45 UTC is already the next day in India
    expect(buildJobRingDetails({ ...ORDER, slotStart: '2026-10-12T23:45:00Z' }, null, NOW)).toMatchObject({ date: 'Tuesday, 13 October', time: '5:15 AM' });
  });

  it.each([
    ['no GPS at all', null],
    ['GPS at (0,0)', { latitude: 0, longitude: 0, updatedAt: NOW }],
    ['GPS outside India', { latitude: 51.5, longitude: -0.12, updatedAt: NOW }],
    ['stale GPS (3 hours old)', { ...FRESH_GPS, updatedAt: new Date(NOW.getTime() - 3 * 3600 * 1000) }],
    ['GPS without a timestamp', { latitude: 23.25, longitude: 77.41, updatedAt: null }],
  ])('%s → "distance unavailable", never a made-up value', (_l, gps) => {
    const d = buildJobRingDetails(ORDER, gps as any, NOW);
    expect(d.distanceKm).toBeNull();
    expect(d.distance).toBeNull();
    expect(d.spoken).toContain('Distance unavailable.');
    expect(d.spoken).not.toMatch(/\d+(\.\d+)? km/);
  });

  it('job address without real coordinates (default 0,0) → distance unavailable', () => {
    const d = buildJobRingDetails({ ...ORDER, address: { ...ORDER.address, latitude: 0, longitude: 0 } }, FRESH_GPS, NOW);
    expect(d.distance).toBeNull();
  });

  it('missing location → says so; still announces the rest', () => {
    const d = buildJobRingDetails({ ...ORDER, address: null }, FRESH_GPS, NOW);
    expect(d.location).toBeNull();
    expect(d.spoken).toBe('Location: not available. Date: Monday, 12 October. Time: 4:30 PM. Amount: ₹1,200. Distance unavailable.');
    expect(buildJobRingDetails({ ...ORDER, address: { area: '', city: 'Bhopal', latitude: 23.2, longitude: 77.4 } }, null, NOW).location).toBe('Bhopal');
  });

  it('missing appointment time → "to be confirmed", no invented date/time', () => {
    const d = buildJobRingDetails({ ...ORDER, slotStart: null }, FRESH_GPS, NOW);
    expect(d.date).toBeNull();
    expect(d.time).toBeNull();
    expect(d.spoken).toBe('Location: Arera Colony, Bhopal. Date and time: to be confirmed. Amount: ₹1,200. Distance: 5.3 km away.');
    expect(buildJobRingDetails({ ...ORDER, slotStart: 'not-a-date' }, null, NOW).date).toBeNull();
  });

  it('no amount → "to be confirmed", never ₹0', () => {
    expect(buildJobRingDetails({ ...ORDER, totalAmount: 0 }, null, NOW).spoken).toContain('Amount: to be confirmed.');
  });

  it('never exposes street/house details', () => {
    const d = buildJobRingDetails({ ...ORDER, address: { ...ORDER.address, fullAddress: 'H-12, Street 4', pincode: '462016' } as any }, FRESH_GPS, NOW);
    expect(JSON.stringify(d)).not.toMatch(/H-12|Street 4|462016/);
  });

  it('distanceBetween rounds to one decimal', () => {
    expect(distanceBetween(FRESH_GPS, ORDER.address, NOW)).toBe(5.3);
  });
});

describe('JobRingPolicyService.onJobOffer — announced details', () => {
  function make(dbOrder: any, vendor: any) {
    const engine: any = { notify: jest.fn().mockResolvedValue(undefined) };
    const prisma: any = {
      order: { findUnique: jest.fn().mockResolvedValue(dbOrder) },
      serviceVendor: { findUnique: jest.fn().mockResolvedValue(vendor) },
    };
    return { ring: new JobRingPolicyService(prisma, engine, { emit: jest.fn() } as any), engine, prisma };
  }
  const recentFix = () => ({ currentLatitude: 23.2599, currentLongitude: 77.4126, lastLocationUpdate: new Date(Date.now() - 5 * 60 * 1000) });

  it('a rescheduled job announces the LATEST confirmed slot, not the dispatch snapshot', async () => {
    const snapshot = { id: 'o1', totalAmount: '1200', slotStart: '2026-10-12T11:00:00Z', service: { name: 'Fan Installation' }, address: { area: 'Arera Colony', city: 'Bhopal', latitude: 23.2156, longitude: 77.4304 } };
    const rescheduled = { ...snapshot, slotStart: new Date('2026-10-14T05:30:00Z') }; // Wed 14 Oct, 11:00 AM IST
    const { ring, engine, prisma } = make(rescheduled, recentFix());
    await ring.onJobOffer({ vendorUserId: 'u1', orderId: 'o1', order: snapshot });
    expect(prisma.order.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'o1' } }));
    const sent = engine.notify.mock.calls[0][0];
    expect(sent.data).toMatchObject({ ringDate: 'Wednesday, 14 October', ringTime: '11:00 AM', ringLocation: 'Arera Colony, Bhopal', ringAmount: '₹1,200', ringDistance: '5.3 km' });
    expect(sent.data.ringSpoken).toBe('Location: Arera Colony, Bhopal. Date: Wednesday, 14 October. Time: 11:00 AM. Amount: ₹1,200. Distance: 5.3 km away.');
    expect(sent.data.order.distanceKm).toBe(5.3);
    // older app versions still get the details in the body
    expect(sent.body).toBe('Fan Installation • Arera Colony • 14 Oct, 11:00 am • ₹1,200 • 5.3 km away');
    // ring policy itself unchanged
    expect(sent).toMatchObject({ type: 'JOB_OFFER', priority: 'HIGH', ttlSeconds: 30, channels: ['PUSH', 'IN_APP'] });
  });

  it('partner without a usable GPS fix → distance unavailable', async () => {
    const order = { id: 'o1', totalAmount: '800', slotStart: null, service: { name: 'Tap Repair' }, address: { area: 'MP Nagar', city: 'Bhopal', latitude: 23.23, longitude: 77.43 } };
    const { ring, engine } = make(order, { currentLatitude: null, currentLongitude: null, lastLocationUpdate: null });
    await ring.onJobOffer({ vendorUserId: 'u1', orderId: 'o1', order });
    const d = engine.notify.mock.calls[0][0].data;
    expect(d.ringDistance).toBe('');
    expect(d.ringSpoken).toBe('Location: MP Nagar, Bhopal. Date and time: to be confirmed. Amount: ₹800. Distance unavailable.');
  });

  it('the ring payload never carries customer, OTP, payment or street details', async () => {
    const full = {
      id: 'o1', orderNumber: 'ORD-1', status: 'CONFIRMED', vendorId: null, totalAmount: '500', slotStart: null,
      customerId: 'c1', customer: { name: 'Asha', phone: '9999999999' }, startOtp: '1234', endOtp: '5678', paymentStatus: 'PAID', adminNotes: 'VIP',
      service: { name: 'Fan Installation', categoryId: 'cat-1' },
      address: { area: 'Arera Colony', city: 'Bhopal', fullAddress: 'H-12, Street 4', pincode: '462016', latitude: 23.21, longitude: 77.43 },
    };
    const { ring, engine } = make(full, recentFix());
    await ring.onJobOffer({ vendorUserId: 'u1', orderId: 'o1', order: full });
    const sent = engine.notify.mock.calls[0][0];
    const json = JSON.stringify({ body: sent.body, data: sent.data });
    expect(json).not.toMatch(/Asha|9999999999|1234|5678|PAID|VIP|H-12|Street 4|462016|customerId/);
    expect(Object.keys(sent.data.order).sort()).toEqual(['address', 'createdAt', 'distanceKm', 'id', 'orderNumber', 'serviceAmount', 'service', 'slotEnd', 'slotStart', 'status', 'totalAmount', 'vendorId', 'vendorPayout'].sort());
  });

  it('a failed lookup never blocks the ring — falls back to the emitted order', async () => {
    const engine: any = { notify: jest.fn().mockResolvedValue(undefined) };
    const ring = new JobRingPolicyService({} as any, engine, { emit: jest.fn() } as any);
    await ring.onJobOffer({ vendorUserId: 'u1', orderId: 'o1', order: { id: 'o1', totalAmount: '500', service: { name: 'X' }, address: { area: 'A', city: 'B' } } });
    expect(engine.notify).toHaveBeenCalledTimes(1);
    expect(engine.notify.mock.calls[0][0].data.ringSpoken).toContain('Distance unavailable.');
  });
});
