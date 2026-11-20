import { DispatchRetryService, RoutingService } from './orders.module';
import { scheduledReleaseAt, isScheduledForLater, loadScheduledDispatchConfig, ROUTING_DECISION_SCHEDULED } from '../../common';

// Slots are written in IST (+05:30), the way checkout builds slotStart.
const ist = (s: string) => new Date(`${s}+05:30`);

describe('scheduledReleaseAt (morning of service day OR slot − lead, whichever is earlier)', () => {
  const cfg = { morningTime: '08:00', leadMinutes: 180 };

  it('afternoon slot releases at 08:00 IST on the service day', () => {
    expect(scheduledReleaseAt(ist('2026-10-10T17:00:00'), cfg)).toEqual(ist('2026-10-10T08:00:00'));
  });

  it('early slot releases lead minutes before it', () => {
    expect(scheduledReleaseAt(ist('2026-10-10T09:00:00'), cfg)).toEqual(ist('2026-10-10T06:00:00'));
  });

  it('just-after-midnight slot releases the previous evening (lead wins across the date line)', () => {
    expect(scheduledReleaseAt(ist('2026-10-10T00:30:00'), cfg)).toEqual(ist('2026-10-09T21:30:00'));
  });

  it('falls back to defaults on a malformed morning time', () => {
    expect(scheduledReleaseAt(ist('2026-10-10T17:00:00'), { morningTime: 'nonsense', leadMinutes: 180 }))
      .toEqual(ist('2026-10-10T08:00:00'));
  });

  it('isScheduledForLater: future slot is held, slot inside the window is not, null slot is immediate', () => {
    const now = ist('2026-10-07T10:00:00');
    expect(isScheduledForLater(ist('2026-10-10T11:00:00'), cfg, now)).toBe(true);
    expect(isScheduledForLater(ist('2026-10-07T12:00:00'), cfg, now)).toBe(false);
    expect(isScheduledForLater(null, cfg, now)).toBe(false);
  });

  it('loadScheduledDispatchConfig reads SiteSettings and survives a client without them', async () => {
    const prisma = { siteSetting: { findMany: jest.fn().mockResolvedValue([
      { key: 'dispatch_scheduled_morning_time', value: '07:30' },
      { key: 'dispatch_scheduled_lead_minutes', value: '120' },
    ]) } };
    await expect(loadScheduledDispatchConfig(prisma)).resolves.toEqual({ morningTime: '07:30', leadMinutes: 120 });
    await expect(loadScheduledDispatchConfig({})).resolves.toEqual({ morningTime: '08:00', leadMinutes: 180 });
  });
});

describe('RoutingService.route — scheduled hold', () => {
  function makeRouting(order: any) {
    const prisma: any = {
      order: { findUnique: jest.fn().mockResolvedValue(order), update: jest.fn().mockResolvedValue({}) },
      serviceVendor: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const dispatch: any = { dispatch: jest.fn(async () => []) };
    const events: any = { emit: jest.fn() };
    return { routing: new RoutingService(prisma, events, dispatch), prisma, dispatch };
  }
  const base = { id: 'o1', orderNumber: 'ORD-1', vendorId: null, service: { fulfillmentType: 'DIRECT_PARTNER', requiredSkills: [] }, address: { city: 'Bhopal' } };

  it('holds a far-future order as SCHEDULED without dispatching or assigning', async () => {
    const { routing, prisma, dispatch } = makeRouting({ ...base, slotStart: new Date(Date.now() + 5 * 24 * 3600_000) });
    await routing.route('o1');
    expect(dispatch.dispatch).not.toHaveBeenCalled();
    expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { routingDecision: ROUTING_DECISION_SCHEDULED } });
  });

  it('dispatches an order with no slot (ASAP) immediately, as before', async () => {
    const { routing, dispatch } = makeRouting({ ...base, slotStart: null });
    await routing.route('o1');
    expect(dispatch.dispatch).toHaveBeenCalledWith('o1');
  });
});

describe('DispatchRetryService.sweep — scheduled orders', () => {
  it('skips orders not yet released and re-routes released SCHEDULED ones', async () => {
    const prisma: any = { order: { findMany: jest.fn().mockResolvedValue([
      { id: 'later', orderNumber: 'L', slotStart: new Date(Date.now() + 20 * 3600_000), routingDecision: ROUTING_DECISION_SCHEDULED },
      { id: 'due', orderNumber: 'D', slotStart: new Date(Date.now() + 30 * 60_000), routingDecision: ROUTING_DECISION_SCHEDULED },
      { id: 'asap', orderNumber: 'A', slotStart: null, routingDecision: 'MANUAL_FALLBACK' },
    ]) } };
    const dispatch: any = { dispatch: jest.fn(async () => []) };
    const routing: any = { route: jest.fn(async () => undefined) };
    await new DispatchRetryService(prisma, dispatch, routing).sweep();
    expect(routing.route).toHaveBeenCalledTimes(1);
    expect(routing.route).toHaveBeenCalledWith('due');
    expect(dispatch.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.dispatch).toHaveBeenCalledWith('asap');
  });
});
