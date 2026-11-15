// Duplicate-add protection across concurrent requests (two browser tabs, retries): only the first
// atomic claim for (customer, item) may add it; an explicit request for more still works.
jest.mock('./openai-client', () => {
  const actual = jest.requireActual('./openai-client');
  return { ...actual, openAiChatWithTools: jest.fn() };
});

import { AiAgentService } from './ai-agent.module';
import { AiToolExecutor, CHAT_TOOL_ALLOWLIST } from './ai-tools';
import { AiLimitsService } from './ai-limits';
import { openAiChatWithTools } from './openai-client';

const mockedChat = openAiChatWithTools as jest.Mock;

function realExecutor() {
  const servicesSvc = {
    search: jest.fn(async (): Promise<any> => []),
    getService: jest.fn(async (id: string): Promise<any> => {
      if (id === 'svc-1') return { id: 'svc-1', name: 'General Pest Control (2BHK)', basePrice: 999, unit: 'per visit', isActive: true, category: { key: 'PEST_CONTROL' } };
      throw new Error('Service not found');
    }),
  };
  const none: any = {};
  return new AiToolExecutor(servicesSvc as any, none, none, none, none, none, none, none);
}

describe('AiLimitsService.claimOnce — atomic first-claim-wins (in-memory store, no REDIS_URL)', () => {
  it('only the first claim inside the window succeeds; other keys are independent; it expires', async () => {
    const limits = new AiLimitsService({} as any);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => limits.claimOnce('cart:c:abc:svc-1', 200)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await limits.claimOnce('cart:c:abc:svc-2', 200)).toBe(true);
    expect(await limits.claimOnce('cart:c:other:svc-1', 200)).toBe(true);
    await new Promise((r) => setTimeout(r, 260));
    expect(await limits.claimOnce('cart:c:abc:svc-1', 200)).toBe(true);
  });
});

describe('cart tools with a claim', () => {
  const ctx = (claim: () => Promise<boolean>) => ({ allowedTools: CHAT_TOOL_ALLOWLIST.PUBLIC, cart: new Map(), addedThisTurn: new Set<string>(), claimCartAdd: jest.fn(claim) });

  it('a lost claim (another tab just added it) refuses the add and tells the model why', async () => {
    const exec = realExecutor();
    const c = ctx(async () => false);
    const { result, action } = await exec.execute('add_service_to_cart', { serviceId: 'svc-1', name: 'x' }, c);
    expect(action).toBeUndefined();
    expect(result).toMatchObject({ added: false, duplicate: true, recentlyAdded: true });
    expect(c.claimCartAdd).toHaveBeenCalledWith('svc-1');
  });

  it('a won claim adds the item at the catalogue price', async () => {
    const exec = realExecutor();
    const { action } = await exec.execute('add_service_to_cart', { serviceId: 'svc-1', name: 'x' }, ctx(async () => true));
    expect(action).toMatchObject({ type: 'ADD_SERVICE_TO_CART', payload: { id: 'svc-1', price: 999, qty: 1 } });
  });

  it('an explicit request for more (addAnother) is not blocked by a recent claim', async () => {
    const exec = realExecutor();
    const c = ctx(async () => false);
    const { action } = await exec.execute('add_service_to_cart', { serviceId: 'svc-1', name: 'x', addAnother: true }, c);
    expect(action).toMatchObject({ type: 'ADD_SERVICE_TO_CART', payload: { id: 'svc-1' } });
    expect(c.claimCartAdd).not.toHaveBeenCalled();
  });

  it('an invalid id never consumes a claim', async () => {
    const exec = realExecutor();
    const c = ctx(async () => true);
    await exec.execute('add_service_to_cart', { serviceId: 'made-up', name: 'x' }, c);
    expect(c.claimCartAdd).not.toHaveBeenCalled();
  });
});

describe('AiAgentService.chat — two tabs sending at the same moment', () => {
  beforeEach(() => {
    mockedChat.mockReset();
    // Each request: the model asks to add svc-1, then answers once it sees the tool result.
    mockedChat.mockImplementation(async (_k: string, _m: string, convo: any[]) => {
      await new Promise((r) => setTimeout(r, 20)); // let the two requests interleave
      return convo[convo.length - 1].role === 'tool'
        ? { role: 'assistant', content: 'Done.' }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'c' + Math.random(), type: 'function', function: { name: 'add_service_to_cart', arguments: '{"serviceId":"svc-1","name":"Pest"}' } }] };
    });
  });

  function service() {
    let n = 0;
    const prisma = { aiSession: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({ id: 'sess-' + (++n), ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    } };
    const config = { get: (k: string, f?: any) => (({ AI_PROVIDER: 'OPENAI', OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-4o-mini' } as any)[k] ?? f) };
    const real = new AiLimitsService({} as any);
    const limits: any = {
      config: async () => ({}),
      admit: async () => ({ release: async () => undefined, identityKey: 'ip:same-office' }),
      budgetAllows: async () => ({ allowed: true }),
      reserve: async () => ({ ok: true, settle: async () => undefined }),
      usageSnapshot: async () => ({}),
      claimOnce: (k: string, t: number) => real.claimOnce(k, t),
    };
    return new AiAgentService(prisma as any, { captureLead: jest.fn() } as any, config as any, realExecutor(), limits);
  }

  const adds = (r: any) => (r.actions || []).filter((a: any) => a.type === 'ADD_SERVICE_TO_CART').length;

  it('same browser, two tabs, same item at once → exactly one add', async () => {
    const svc = service();
    const [a, b] = await Promise.all([
      svc.chat({ message: 'Pest control add karo', clientId: 'a'.repeat(32), cart: [] } as any),
      svc.chat({ message: 'Pest control add karo', clientId: 'a'.repeat(32), cart: [] } as any),
    ]);
    expect(adds(a) + adds(b)).toBe(1);
  });

  it('two different customers on the same network are independent → both add', async () => {
    const svc = service();
    const [a, b] = await Promise.all([
      svc.chat({ message: 'Pest control add karo', clientId: 'a'.repeat(32), cart: [] } as any),
      svc.chat({ message: 'Pest control add karo', clientId: 'b'.repeat(32), cart: [] } as any),
    ]);
    expect(adds(a)).toBe(1);
    expect(adds(b)).toBe(1);
  });

  it('a model that keeps calling tools still ends with a real answer (last round has no tools)', async () => {
    mockedChat.mockReset();
    const choices: string[] = [];
    mockedChat.mockImplementation(async (_k: string, _m: string, _c: any[], _t: any, opts: any) => {
      choices.push(opts.toolChoice);
      return opts.toolChoice === 'none'
        ? { role: 'assistant', content: 'Aapke cart me already hai — Book Now dabaiye.' }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'c' + Math.random(), type: 'function', function: { name: 'add_service_to_cart', arguments: '{"serviceId":"svc-1","name":"Pest"}' } }] };
    });
    const res: any = await service().chat({ message: 'ab checkout karna hai', clientId: 'c'.repeat(32), cart: [{ id: 'svc-1', name: 'Pest', qty: 1 }] } as any);
    expect(choices).toEqual(['auto', 'auto', 'auto', 'none']);
    expect(res.reply).toBe('Aapke cart me already hai — Book Now dabaiye.');
    expect((res.actions || []).length).toBe(0); // already in the cart: never re-added
  });

  it('a signed-in customer in two tabs (no browser id needed) → exactly one add', async () => {
    const svc = service();
    const actor = { userId: 'user-1' };
    const [a, b] = await Promise.all([
      svc.chat({ message: 'Pest control add karo', cart: [] } as any, actor as any),
      svc.chat({ message: 'Pest control add karo', cart: [] } as any, actor as any),
    ]);
    expect(adds(a) + adds(b)).toBe(1);
  });
});
