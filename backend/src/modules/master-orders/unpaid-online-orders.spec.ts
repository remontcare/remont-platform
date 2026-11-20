import 'reflect-metadata';
import * as crypto from 'crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { AuthMasterCheckoutDto, MasterOrdersService } from './master-orders.module';
import { GuestBookingDto, RoutingService, DispatchService, OrdersService } from '../orders/orders.module';
import { AdminService } from '../admin/admin.module';

/**
 * A cancelled, failed or pending online payment must never become a confirmed or
 * fulfilment-ready order, and no order is ever created without an explicit payment choice.
 */

const errorsOf = async (cls: any, body: any) => (await validate(plainToInstance(cls, body))).map((e) => e.property);

describe('Payment method must be chosen explicitly', () => {
  it('signed-in checkout (POST /master-orders) rejects a missing or unknown method, accepts ONLINE / COD', async () => {
    const base = { items: [{ type: 'SERVICE', serviceId: 's1', quantity: 1 }] };
    expect(await errorsOf(AuthMasterCheckoutDto, base)).toContain('paymentMethod');
    expect(await errorsOf(AuthMasterCheckoutDto, { ...base, paymentMethod: 'CARD' })).toContain('paymentMethod');
    expect(await errorsOf(AuthMasterCheckoutDto, { ...base, paymentMethod: 'ONLINE' })).not.toContain('paymentMethod');
    expect(await errorsOf(AuthMasterCheckoutDto, { ...base, paymentMethod: 'COD' })).not.toContain('paymentMethod');
  });

  it('guest booking (POST /orders/public/book) rejects a missing method — it used to become a confirmed COD order', async () => {
    const base = { name: 'A', phone: '9000000000', serviceId: 's1', cityId: 'c1', fullAddress: 'x', slotDate: '2026-12-01', slotTime: '10:00' };
    expect(await errorsOf(GuestBookingDto, base)).toContain('paymentMethod');
    expect(await errorsOf(GuestBookingDto, { ...base, paymentMethod: 'COD' })).not.toContain('paymentMethod');
  });

  it('MasterOrdersService.checkout refuses without a payment method — before touching the database or pricing', async () => {
    const touched: string[] = [];
    const prisma: any = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); return new Proxy({}, { get: () => async () => { throw new Error('DB touched'); } }); } });
    const priceCart = jest.fn();
    for (const paymentMethod of [undefined, '', 'CARD']) {
      await expect(MasterOrdersService.prototype.checkout.call({ prisma, priceCart }, { items: [{ type: 'SERVICE', serviceId: 's1', quantity: 1 }] } as any, { customerId: 'c1', paymentMethod } as any))
        .rejects.toThrow('Please choose a payment method: Pay Online or Cash on Service.');
    }
    expect(touched).toEqual([]);
    expect(priceCart).not.toHaveBeenCalled();
  });
});

describe('Unpaid online orders are never fulfilment-ready', () => {
  const unpaidOrder = (status = 'PENDING_PAYMENT') => ({
    id: 'o1', orderNumber: 'REM-1', status, paymentMethod: 'ONLINE', paymentStatus: 'PENDING',
    service: { fulfillmentType: 'DIRECT_PARTNER', category: { key: 'PLUMBING' } }, address: { latitude: 23.2, longitude: 77.4 },
  });

  it('routing refuses an unpaid (or cancelled) order — no dispatch, no partner, nothing written', async () => {
    for (const status of ['PENDING_PAYMENT', 'CANCELLED']) {
      const prisma: any = { order: { findUnique: jest.fn(async () => unpaidOrder(status)), update: jest.fn() } };
      const dispatch: any = { dispatch: jest.fn() };
      const routing = new RoutingService(prisma, { emit: jest.fn() } as any, dispatch);
      await routing.route('o1');
      expect(dispatch.dispatch).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
    }
  });

  it('dispatch never offers an unpaid order to partners', async () => {
    const prisma: any = { order: { findUnique: jest.fn(async () => unpaidOrder()) }, serviceVendor: { findMany: jest.fn() }, vendor: { findMany: jest.fn() } };
    const svc = new DispatchService(prisma, { emit: jest.fn() } as any);
    expect(await svc.dispatch('o1')).toEqual([]);
    expect(prisma.serviceVendor.findMany).not.toHaveBeenCalled();
  });

  it('admin "Assign partner" refuses an unpaid online order', async () => {
    const prisma: any = { order: { findUnique: jest.fn(async ({ select }: any) => (select && select.status ? { status: 'PENDING_PAYMENT' } : { serviceId: 's1', vendorId: null, arrivedAt: null, serviceModel: null, pricingSnapshot: null })) } };
    await expect(AdminService.prototype.forceAssignVendor.call({ prisma }, 'o1', 'v1')).rejects.toThrow(/not confirmed/);
  });

  it('admin "Assign partner" refuses a cancelled order', async () => {
    const prisma: any = { order: { findUnique: jest.fn(async ({ select }: any) => (select && select.status ? { status: 'CANCELLED' } : { serviceId: 's1', vendorId: null })) } };
    await expect(AdminService.prototype.forceAssignVendor.call({ prisma }, 'o1', 'v1')).rejects.toThrow(/cancelled/);
  });
});

describe('Unpaid online attempts are not shown as orders to the customer', () => {
  const UNPAID = { paymentMethod: 'ONLINE', paymentStatus: { in: ['PENDING', 'INITIATED', 'FAILED', 'CANCELLED'] }, status: { in: ['PENDING_PAYMENT', 'CANCELLED'] } };

  it('My Orders (master orders) excludes unpaid online attempts', async () => {
    let where: any;
    const prisma: any = { masterOrder: { findMany: jest.fn(async (a: any) => { where = a.where; return []; }) } };
    await MasterOrdersService.prototype.findMine.call({ prisma }, 'c1');
    expect(where).toMatchObject({ customerId: 'c1', NOT: UNPAID });
  });

  it('My Orders (orders) excludes unpaid online attempts, also with a status filter', async () => {
    const calls: any[] = [];
    const prisma: any = { order: { findMany: jest.fn(async (a: any) => { calls.push(a.where); return []; }) } };
    await OrdersService.prototype.myOrders.call({ prisma }, 'c1');
    await OrdersService.prototype.myOrders.call({ prisma }, 'c1', 'CONFIRMED' as any);
    expect(calls[0]).toMatchObject({ customerId: 'c1', NOT: UNPAID });
    expect(calls[1]).toMatchObject({ customerId: 'c1', status: 'CONFIRMED', NOT: UNPAID });
  });
});

describe('Duplicate / concurrent payment callbacks confirm exactly once', () => {
  const SECRET = 'test-razorpay-secret';
  beforeEach(() => { process.env.RAZORPAY_KEY_SECRET = SECRET; });

  it('browser callback and webhook-driven confirm at the same moment → one confirmation, one dispatch', async () => {
    const master: any = { id: 'mo1', masterOrderNumber: 'MREM-1', customerId: 'c1', totalAmount: 1000, walletUsed: 0, status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', childOrders: [{ id: 'ch1', serviceId: 's1', bundleDispatchDeferred: false, type: 'SERVICE' }] };
    let claimed = false;
    const prisma: any = {
      masterOrder: { findUnique: jest.fn(async () => ({ ...master })) },
      paymentTransaction: { findFirst: jest.fn(async () => ({ id: 'tx1', gatewayOrderId: 'order_1', orderId: 'mo1' })), updateMany: jest.fn(async () => ({ count: 1 })) },
      $transaction: jest.fn(async (fn: any) => fn({
        // the conditional PENDING_PAYMENT → CONFIRMED claim: only the first caller wins
        masterOrder: { updateMany: jest.fn(async () => { await new Promise((r) => setTimeout(r, 10)); if (claimed) return { count: 0 }; claimed = true; return { count: 1 }; }) },
        order: { update: jest.fn(async () => ({})) }, orderTimeline: { create: jest.fn(async () => ({})) },
      })),
    };
    const routing: any = { route: jest.fn(async () => undefined) };
    const svc = new MasterOrdersService(prisma, {} as any, {} as any, {} as any, { getVerifiedCapturedAmount: jest.fn(async () => 1000) } as any, { dispatch: jest.fn() } as any, routing, { paymentSuccess: jest.fn(async () => undefined) } as any, {} as any, {} as any, { notify: jest.fn() } as any);
    const sig = crypto.createHmac('sha256', SECRET).update('order_1|pay_1').digest('hex');
    await Promise.allSettled([
      svc.confirmPayment('mo1', 'pay_1', 'order_1', sig),
      svc.confirmPayment('mo1', 'pay_1', 'order_1', sig),
    ]);
    expect(routing.route).toHaveBeenCalledTimes(1);
  });

  it('a forged or missing signature never confirms', async () => {
    const prisma: any = { masterOrder: { findUnique: jest.fn(async () => ({ id: 'mo1', customerId: 'c1', totalAmount: 1000, status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', childOrders: [] })) }, paymentTransaction: { findFirst: jest.fn(async () => null) } };
    const svc = new MasterOrdersService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(svc.confirmPayment('mo1', 'pay_1', 'order_1', 'forged')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.confirmPayment('mo1', 'pay_1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
