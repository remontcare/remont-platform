import * as crypto from 'crypto';
import { PaymentsService } from './payments.module';

/**
 * Razorpay refund idempotency (official: X-Refund-Idempotency on POST /v1/payments/{id}/refund)
 * and webhook de-duplication by Razorpay's event id — no network, no real money: fetch is mocked.
 */
function makeService() {
  const events = new Map<string, any>();
  const prisma: any = {
    paymentWebhookEvent: {
      findUnique: jest.fn(async ({ where }: any) => events.get(where.eventId) ?? null),
      create: jest.fn(async ({ data }: any) => { if (events.has(data.eventId)) throw Object.assign(new Error('unique'), { code: 'P2002' }); const r = { ...data, processedAt: null }; events.set(data.eventId, r); return r; }),
      update: jest.fn(async ({ where, data }: any) => { const r = { ...events.get(where.eventId), ...data }; events.set(where.eventId, r); return r; }),
    },
    paymentTransaction: { findFirst: jest.fn(async () => null), update: jest.fn() },
  };
  const emitter: any = { emitAsync: jest.fn(async () => []), emit: jest.fn() };
  const svc = new PaymentsService(prisma, {} as any, emitter);
  Object.assign(svc as any, { razorpayKeyId: 'rzp_test_key', razorpayKeySecret: 'secret', razorpayWebhookSecret: 'whsec' });
  return { svc, prisma, emitter, events };
}
const sign = (body: string) => crypto.createHmac('sha256', 'whsec').update(body).digest('hex');
const jsonResponse = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('createRazorpayRefund — idempotent request + careful outcome classification', () => {
  const realFetch = global.fetch;
  afterEach(() => { (global as any).fetch = realFetch; });

  it('sends the idempotency header and the identical body every time', async () => {
    const { svc } = makeService();
    const fetchMock = jest.fn(async () => jsonResponse(200, { id: 'rfnd_1', status: 'pending', amount: 60000, receipt: 'prf_1' }));
    (global as any).fetch = fetchMock;
    const a = await svc.createRazorpayRefund('pay_1', 60000, 'rfnd_cmv8rr0001', 'prf_1', { internal_refund_id: 'prf_1' });
    await svc.createRazorpayRefund('pay_1', 60000, 'rfnd_cmv8rr0001', 'prf_1', { internal_refund_id: 'prf_1' });
    expect(a).toEqual({ ok: true, refund: { id: 'rfnd_1', status: 'pending', amount: 60000, receipt: 'prf_1' } });
    const [url, init] = (fetchMock.mock.calls[0] as any[]);
    expect(url).toBe('https://api.razorpay.com/v1/payments/pay_1/refund');
    expect(init.headers['X-Refund-Idempotency']).toBe('rfnd_cmv8rr0001');
    expect(JSON.parse(init.body)).toEqual({ amount: 60000, receipt: 'prf_1', notes: { internal_refund_id: 'prf_1' } });
    expect((fetchMock.mock.calls[1] as any[])[1].body).toBe(init.body);
  });

  it.each([
    ['timeout / network error', () => Promise.reject(new Error('The operation was aborted due to timeout')), 'UNCERTAIN'],
    ['409 same key still in progress', async () => jsonResponse(409, { error: { description: 'Another request with the same idempotency key is still in progress.' } }), 'IN_PROGRESS'],
    ['409 same key, different request', async () => jsonResponse(409, { error: { description: 'Different request with the same idempotency key has already been processed.' } }), 'KEY_CONFLICT'],
    ['400 amount greater than captured', async () => jsonResponse(400, { error: { description: 'The refund amount provided is greater than amount captured.' } }), 'DEFINITE_REJECTION'],
    ['400 already fully refunded (maybe by an earlier attempt)', async () => jsonResponse(400, { error: { description: 'The payment has been fully refunded already.' } }), 'UNCERTAIN'],
    ['500 server error', async () => jsonResponse(500, { error: { description: 'Internal server error - Failed to fetch idempotency record' } }), 'UNCERTAIN'],
  ])('%s → %s', async (_l, impl, kind) => {
    const { svc } = makeService();
    (global as any).fetch = jest.fn(impl as any);
    const r: any = await svc.createRazorpayRefund('pay_1', 60000, 'rfnd_cmv8rr0001', 'prf_1', {});
    expect(r.ok).toBe(false);
    expect(r.kind).toBe(kind);
  });

  it('an invalid key (Razorpay needs ≥10 chars of [A-Za-z0-9_-]) is refused without calling Razorpay', async () => {
    const { svc } = makeService();
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    expect(await svc.createRazorpayRefund('pay_1', 100, 'short', 'r', {})).toEqual(expect.objectContaining({ ok: false, kind: 'DEFINITE_REJECTION' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Webhook — signature first, then de-duplication by Razorpay event id', () => {
  const body = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 60000, status: 'processed', receipt: 'prf_1', notes: { internal_refund_id: 'prf_1' } } } } });

  it('forwards a refund event once; a duplicate delivery of the same event id is skipped', async () => {
    const { svc, emitter } = makeService();
    expect(await svc.handleWebhook(body, sign(body), 'evt_1')).toEqual({ received: true });
    expect(await svc.handleWebhook(body, sign(body), 'evt_1')).toEqual({ received: true, duplicate: true });
    expect(emitter.emitAsync).toHaveBeenCalledTimes(1);
    expect(emitter.emitAsync).toHaveBeenCalledWith('provider.refund.update', expect.objectContaining({ refundId: 'rfnd_1', event: 'refund.processed', amount: 60000, receipt: 'prf_1' }));
  });

  it('an event whose processing failed is processed again on Razorpay\'s retry', async () => {
    const { svc, emitter } = makeService();
    emitter.emitAsync.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.handleWebhook(body, sign(body), 'evt_2')).rejects.toThrow('db down');
    await svc.handleWebhook(body, sign(body), 'evt_2');
    expect(emitter.emitAsync).toHaveBeenCalledTimes(2);
  });

  it('a bad signature is rejected before anything is recorded', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.handleWebhook(body, 'bad', 'evt_3')).rejects.toThrow(/signature/);
    expect(prisma.paymentWebhookEvent.create).not.toHaveBeenCalled();
  });
});
