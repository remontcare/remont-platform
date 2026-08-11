import { LeadSource } from '@prisma/client';

jest.mock('./openai-client', () => {
  const actual = jest.requireActual('./openai-client');
  return { ...actual, openAiChatWithTools: jest.fn() };
});

import { AiAgentService } from './ai-agent.module';
import { openAiChatWithTools } from './openai-client';

const mockedChat = openAiChatWithTools as jest.Mock;

function makePrisma(overrides: Partial<Record<string, any>> = {}) {
  return {
    aiSession: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({ id: 'sess-1', ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, resultLeadId: null, ...data })),
    },
    ...overrides,
  };
}
function makeCrm() {
  return { captureLead: jest.fn(async (data: any) => ({ id: 'fallback-lead-1', ...data })) };
}
function makeConfig(vars: Record<string, string> = {}) {
  const defaults: Record<string, string> = { AI_PROVIDER: 'OPENAI', OPENAI_API_KEY: 'sk-test-key', OPENAI_MODEL: 'gpt-4o-mini', ...vars };
  return { get: (key: string, fallback?: any) => (key in defaults ? defaults[key] : fallback) };
}
function makeToolExecutor(executeImpl?: jest.Mock) {
  return { execute: executeImpl || jest.fn(async () => ({ result: {} })) };
}

describe('AiAgentService.chat() — tool-calling loop (OpenAI mocked, zero live DB/network)', () => {
  beforeEach(() => mockedChat.mockReset());

  it('plain reply with no tool calls: returns text as-is, no tools executed', async () => {
    mockedChat.mockResolvedValueOnce({ role: 'assistant', content: 'Namaste! Kaise help karu?' });
    const toolExecutor = makeToolExecutor();
    const svc = new AiAgentService(makePrisma() as any, makeCrm() as any, makeConfig() as any, toolExecutor as any);

    const res = await svc.chat({ message: 'Hi' });

    expect(res.reply).toBe('Namaste! Kaise help karu?');
    expect(res.actions).toEqual([]);
    expect(toolExecutor.execute).not.toHaveBeenCalled();
    expect(mockedChat).toHaveBeenCalledTimes(1);
  });

  it('one round of tool calling: executes the tool, feeds the result back, returns the final reply + collected action', async () => {
    mockedChat
      .mockResolvedValueOnce({
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_services', arguments: '{"query":"AC cooling"}' } }],
      })
      .mockResolvedValueOnce({ role: 'assistant', content: 'AC Service & Repair mil gaya — book kar doon?' });

    const executeMock = jest.fn(async (name: string) => {
      if (name === 'search_services') return { result: [{ id: 'svc-1', name: 'AC Service & Repair', basePrice: 499 }] };
      return { result: {} };
    });
    const toolExecutor = makeToolExecutor(executeMock);
    const svc = new AiAgentService(makePrisma() as any, makeCrm() as any, makeConfig() as any, toolExecutor as any);

    const res = await svc.chat({ message: 'AC cooling nahi kar raha', city: 'Bhopal' });

    expect(executeMock).toHaveBeenCalledWith('search_services', { query: 'AC cooling' }, expect.objectContaining({ city: 'Bhopal' }));
    expect(res.reply).toBe('AC Service & Repair mil gaya — book kar doon?');
    expect(mockedChat).toHaveBeenCalledTimes(2);
  });

  it('add_service_to_cart tool call surfaces its FrontendAction on the response', async () => {
    mockedChat
      .mockResolvedValueOnce({
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add_service_to_cart', arguments: '{"serviceId":"svc-1","name":"AC Service","price":499}' } }],
      })
      .mockResolvedValueOnce({ role: 'assistant', content: 'Cart me add kar diya!' });

    const action = { type: 'ADD_SERVICE_TO_CART', payload: { id: 'svc-1', name: 'AC Service', price: 499 } };
    const executeMock = jest.fn(async () => ({ result: { added: true }, action }));
    const toolExecutor = makeToolExecutor(executeMock);
    const svc = new AiAgentService(makePrisma() as any, makeCrm() as any, makeConfig() as any, toolExecutor as any);

    const res = await svc.chat({ message: 'Haan book kar do' });
    expect(res.actions).toEqual([action]);
  });

  it('a tool call that creates a lead is reflected in the response leadId and persisted on the session', async () => {
    mockedChat
      .mockResolvedValueOnce({
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'create_lead', arguments: '{"customerName":"Anjali","customerPhone":"9876543210","serviceInterested":"Interior"}' } }],
      })
      .mockResolvedValueOnce({ role: 'assistant', content: 'Requirement note kar liya!' });

    const executeMock = jest.fn(async () => ({ result: { leadId: 'lead-abc', created: true } }));
    const toolExecutor = makeToolExecutor(executeMock);
    const prisma = makePrisma();
    const svc = new AiAgentService(prisma as any, makeCrm() as any, makeConfig() as any, toolExecutor as any);

    const res = await svc.chat({ message: '2BHK interior chahiye' });
    expect(res.leadId).toBe('lead-abc');
    expect(prisma.aiSession.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ resultLeadId: 'lead-abc' }) }));
  });

  it('present_options overrides the generic suggestions with the AI-chosen clickable choices', async () => {
    mockedChat
      .mockResolvedValueOnce({
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'present_options', arguments: '{"options":["House","Flat","Commercial"]}' } }],
      })
      .mockResolvedValueOnce({ role: 'assistant', content: 'Property type?' });

    const executeMock = jest.fn(async (name: string, args: any) =>
      name === 'present_options' ? { result: { presented: true, options: args.options } } : { result: {} });
    const toolExecutor = makeToolExecutor(executeMock);
    const svc = new AiAgentService(makePrisma() as any, makeCrm() as any, makeConfig() as any, toolExecutor as any);

    const res = await svc.chat({ message: 'painting karwani hai' });
    expect(res.reply).toBe('Property type?');
    expect(res.suggestions).toEqual(['House', 'Flat', 'Commercial']);
  });

  it('without a present_options call, suggestions fall back to the generic per-intent list as before', async () => {
    mockedChat.mockResolvedValueOnce({ role: 'assistant', content: 'AC service book kar dete hain?' });
    const toolExecutor = makeToolExecutor();
    const svc = new AiAgentService(makePrisma() as any, makeCrm() as any, makeConfig() as any, toolExecutor as any);

    const res = await svc.chat({ message: 'AC cooling nahi kar raha' });
    expect(res.suggestions.length).toBeGreaterThan(0);
    expect(res.suggestions).not.toEqual(['House', 'Flat', 'Commercial']);
  });

  it('the loop is capped — a model that only ever calls tools does not run forever', async () => {
    mockedChat.mockResolvedValue({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'search_services', arguments: '{"query":"x"}' } }],
    });
    const toolExecutor = makeToolExecutor(jest.fn(async () => ({ result: [] })));
    const svc = new AiAgentService(makePrisma() as any, makeCrm() as any, makeConfig() as any, toolExecutor as any);

    const res = await svc.chat({ message: 'test runaway' });
    expect(mockedChat.mock.calls.length).toBeLessThanOrEqual(4);
    // Falls back to a rule-based reply rather than returning an empty string.
    expect(res.reply).toBeTruthy();
  });

  it('OpenAI throwing mid-conversation falls back to the rule-based reply, never crashes the request', async () => {
    mockedChat.mockRejectedValueOnce(new Error('OpenAI 500: upstream error'));
    const toolExecutor = makeToolExecutor();
    const svc = new AiAgentService(makePrisma() as any, makeCrm() as any, makeConfig() as any, toolExecutor as any);

    const res = await svc.chat({ message: 'AC cooling nahi kar raha' });
    expect(res.reply).toBeTruthy();
    expect(res.intent).toBe('AC');
  });

  it('when AI_PROVIDER is not OPENAI, uses the rule-based path and never calls OpenAI at all', async () => {
    const toolExecutor = makeToolExecutor();
    const svc = new AiAgentService(makePrisma() as any, makeCrm() as any, makeConfig({ AI_PROVIDER: 'RULE_BASED' }) as any, toolExecutor as any);

    const res = await svc.chat({ message: 'Bathroom leakage ho raha hai' });
    expect(mockedChat).not.toHaveBeenCalled();
    expect(res.intent).toBe('PLUMBING');
  });

  it('the automatic fallback lead-capture (pre-existing behavior) still fires when no tool created a lead', async () => {
    mockedChat.mockResolvedValueOnce({ role: 'assistant', content: 'Samajh gaya, AC service book karte hain.' });
    const toolExecutor = makeToolExecutor();
    const crm = makeCrm();
    const svc = new AiAgentService(makePrisma() as any, crm as any, makeConfig() as any, toolExecutor as any);

    const res = await svc.chat({ message: 'AC cooling nahi kar raha', customerPhone: '9876543210', city: 'Bhopal' });
    expect(crm.captureLead).toHaveBeenCalledWith(expect.objectContaining({ customerPhone: '9876543210', source: LeadSource.AI_CHAT, serviceInterested: 'AC' }));
    expect(res.leadId).toBe('fallback-lead-1');
  });
});
