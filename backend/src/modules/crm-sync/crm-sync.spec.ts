import { CrmOrderSyncService } from './crm-sync.module';

const KEY = 'test-ai-catalog-key-0123456789abcdef0123'; // not a real secret
const REF = 'b'.repeat(32);

function order(over: Record<string, any> = {}) {
  return {
    id: 'mo1', masterOrderNumber: 'RM260925001', channel: 'WHATSAPP', status: 'PENDING_PAYMENT',
    paymentStatus: 'PENDING', paymentMethod: 'ONLINE', totalAmount: '588.82', guestName: 'Rahul',
    guestPhone: '+919812345678', snapshotCity: 'Bhopal', customer: { name: 'Rahul', phone: '+919812345678' },
    childOrders: [
      { service: { id: 'svcacservice1', name: 'AC Service' }, items: [] },
      { service: null, items: [{ productId: 'prodabcdefgh1', quantity: 2, product: { name: 'Havells Fan' } }] },
    ],
    ...over,
  };
}

function make(mo: any) {
  const prisma = { masterOrder: { findUnique: jest.fn(async () => mo) } };
  return new CrmOrderSyncService(prisma as any);
}

describe('CrmOrderSyncService', () => {
  const OLD = { ...process.env };
  const realFetch = global.fetch;
  afterEach(() => { process.env = { ...OLD }; global.fetch = realFetch; });

  it('builds the real order: number, status, total, customer and items', async () => {
    const p = await make(order()).buildPayload('mo1', 'order.created', REF);
    expect(p).toMatchObject({
      event: 'order.created', crmRef: REF, masterOrderNumber: 'RM260925001', status: 'PENDING_PAYMENT',
      paymentStatus: 'PENDING', totalAmount: 588.82, customerPhone: '+919812345678', city: 'Bhopal',
      items: [{ type: 'service', id: 'svcacservice1', name: 'AC Service', quantity: 1 },
              { type: 'product', id: 'prodabcdefgh1', name: 'Havells Fan', quantity: 2 }],
    });
  });

  it('never sends orders that did not come from a CRM link', async () => {
    expect(await make(order({ channel: 'WEBSITE' })).buildPayload('mo1', 'order.paid')).toBeNull();
    expect(await make(order()).buildPayload('mo1', 'order.paid')).not.toBeNull();   // WhatsApp-channel
  });

  it('posts with the shared key, and is off without a URL', async () => {
    process.env.AI_CATALOG_API_KEY = KEY;
    const calls: any[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => { calls.push({ url, init }); return { ok: true } as any; }) as any;

    delete process.env.CRM_ORDER_WEBHOOK_URL;
    await (make(order()) as any).send('mo1', 'order.paid');
    expect(calls).toHaveLength(0);

    process.env.CRM_ORDER_WEBHOOK_URL = 'https://crm.example/integrations/website/orders';
    await (make(order()) as any).send('mo1', 'order.paid');
    expect(calls[0].url).toBe('https://crm.example/integrations/website/orders');
    expect(calls[0].init.headers['x-ai-catalog-key']).toBe(KEY);
    expect(JSON.parse(calls[0].init.body).event).toBe('order.paid');
  });

  it('a CRM outage never throws into checkout/payment', async () => {
    process.env.AI_CATALOG_API_KEY = KEY;
    process.env.CRM_ORDER_WEBHOOK_URL = 'https://crm.example/x';
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    expect(() => make(order()).notify('mo1', 'order.paid')).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});
