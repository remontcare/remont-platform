process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtStrategy } from '../auth/auth.module';
import { CrmService } from '../crm/crm.module';
import { AiAgentController, AiAgentService, AiToolsController, AiToolsService } from './ai-agent.module';
import { AiLimitsService } from './ai-limits';
import { AiToolExecutor } from './ai-tools';

/**
 * Over real HTTP, with the real JwtStrategy and guards (database mocked, AI provider off so no
 * paid call can happen): the public chat stays open to anonymous visitors, a bad token is a 401
 * rather than a silent downgrade, transcripts need login + ownership, and the /ai/tools/* budget
 * endpoints are admin-only — role read from the database, not from the token.
 */
const USERS: Record<string, any> = {
  cust: { id: 'cust', phone: '+919876543210', role: 'CUSTOMER', isVerified: true, isBlocked: false, name: 'C' },
  other: { id: 'other', phone: '+918888888888', role: 'CUSTOMER', isVerified: true, isBlocked: false, name: 'O' },
  partner: { id: 'partner', phone: '+917777777777', role: 'SERVICE_VENDOR', isVerified: true, isBlocked: false, name: 'P' },
  seller: { id: 'seller', phone: '+916666666666', role: 'PRODUCT_VENDOR', isVerified: true, isBlocked: false, name: 'S' },
  admin: { id: 'admin', phone: '+915555555555', role: 'ADMIN', isVerified: true, isBlocked: false, name: 'A' },
  blocked: { id: 'blocked', phone: '+914444444444', role: 'CUSTOMER', isVerified: true, isBlocked: true, name: 'B' },
};

jest.setTimeout(20_000);

describe('Remi AI over HTTP', () => {
  let app: INestApplication;
  let base: string;
  let jwt: JwtService;
  let sessions: Record<string, any>;
  const sign = (u: any, extra: Record<string, any> = {}) => jwt.sign({ sub: u.id, phone: u.phone, role: u.role, ...extra });

  const prisma: any = {
    user: { findUnique: jest.fn(async ({ where }: any) => USERS[where.id] ?? null) },
    aiSession: {
      findUnique: jest.fn(async ({ where }: any) => sessions[where.id] ?? null),
      findMany: jest.fn(async ({ where }: any) => Object.values(sessions).filter((s: any) => s.userId === where?.userId)),
      create: jest.fn(async ({ data }: any) => { const s = { id: `s${Object.keys(sessions).length + 1}`, endedAt: null, ...data }; sessions[s.id] = s; return s; }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(sessions[where.id], data)),
    },
    order: { findUnique: jest.fn(async () => null), count: jest.fn(async () => 0) },
    serviceVendor: { count: jest.fn(async () => 0) },
    lead: { count: jest.fn(async () => 0) },
    review: { aggregate: jest.fn(async () => ({ _avg: { rating: null }, _count: { id: 0 } })) },
    siteSetting: { findMany: jest.fn(async () => []) },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: process.env.JWT_SECRET }), ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [AiAgentController, AiToolsController],
      providers: [
        AiAgentService, AiToolsService, AiLimitsService, JwtStrategy,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: (k: string, d?: any) => ({ AI_PROVIDER: 'RULE_BASED' } as any)[k] ?? d } },
        { provide: CrmService, useValue: { captureLead: jest.fn(async (d: any) => ({ id: 'lead-1', ...d })) } },
        { provide: AiToolExecutor, useValue: { execute: jest.fn(async () => ({ result: {} })) } },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    jwt = moduleRef.get(JwtService);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    sessions = { 'sess-cust': { id: 'sess-cust', userId: 'cust', messages: [{ role: 'user', content: 'flat 4B' }], endedAt: null } };
    jest.clearAllMocks();
  });

  const req = (method: string, path: string, body?: any, token?: string) => fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  describe('POST /ai/chat', () => {
    it('anonymous visitors can still chat (public sales flow preserved)', async () => {
      const res = await req('POST', '/ai/chat', { message: 'AC repair chahiye' });
      expect(res.status).toBe(201);
      expect((await res.json()).reply).toBeTruthy();
    });

    it('a logged-in customer chats as themselves; a body userId is ignored', async () => {
      const res = await req('POST', '/ai/chat', { message: 'hi', userId: 'other' }, sign(USERS.cust));
      expect(res.status).toBe(201);
      expect(prisma.aiSession.create.mock.calls[0][0].data.userId).toBe('cust');
    });

    it.each([
      ['garbage token', () => 'not-a-jwt'],
      ['wrong signature', () => new JwtService({ secret: 'attacker' }).sign({ sub: 'admin', role: 'ADMIN' })],
      ['expired token', () => sign(USERS.cust, { exp: Math.floor(Date.now() / 1000) - 60 })],
      ['blocked user', () => sign(USERS.blocked)],
      ['deleted user', () => sign({ id: 'ghost', phone: '+910000000000', role: 'CUSTOMER' })],
    ])('%s → 401, not a silent anonymous downgrade', async (_label, token) => {
      const res = await req('POST', '/ai/chat', { message: 'hi' }, token());
      expect(res.status).toBe(401);
      expect(prisma.aiSession.create).not.toHaveBeenCalled();
    });

    it('oversized message → 400', async () => {
      expect((await req('POST', '/ai/chat', { message: 'x'.repeat(5000) })).status).toBe(400);
    });

    it("cannot continue another user's session", async () => {
      const res = await req('POST', '/ai/chat', { message: 'what is my address?', sessionId: 'sess-cust' }, sign(USERS.other));
      const body = await res.json();
      expect(body.sessionId).not.toBe('sess-cust');
      expect(JSON.stringify(body)).not.toContain('flat 4B');
    });
  });

  describe('transcripts and session end', () => {
    it('GET /ai/sessions/:id: no token 401, other user 404, owner 200, admin 200', async () => {
      expect((await req('GET', '/ai/sessions/sess-cust')).status).toBe(401);
      expect((await req('GET', '/ai/sessions/sess-cust', undefined, sign(USERS.other))).status).toBe(404);
      expect((await req('GET', '/ai/sessions/sess-cust', undefined, sign(USERS.cust))).status).toBe(200);
      expect((await req('GET', '/ai/sessions/sess-cust', undefined, sign(USERS.admin))).status).toBe(200);
    });

    it("POST /ai/session/end: anonymous or another user cannot end/convert someone's session", async () => {
      expect((await req('POST', '/ai/session/end', { sessionId: 'sess-cust', orderId: 'o1' })).status).toBe(404);
      expect((await req('POST', '/ai/session/end', { sessionId: 'sess-cust', orderId: 'o1' }, sign(USERS.other))).status).toBe(404);
      expect(sessions['sess-cust'].endedAt).toBeNull();
    });
  });

  describe('/ai/tools/* is admin-only', () => {
    const endpoints: [string, string, any][] = [
      ['GET', '/ai/tools/usage', undefined],
      ['GET', '/ai/tools/insights', undefined],
      ['POST', '/ai/tools/generate/service-description', { name: 'AC', category: 'AC' }],
      ['POST', '/ai/tools/generate/product-description', { name: 'Fan', category: 'Fans' }],
      ['POST', '/ai/tools/generate/seo', { type: 'service', subject: 'AC' }],
      ['POST', '/ai/tools/qualify-lead', { message: 'hi' }],
      ['POST', '/ai/tools/recommendations', { orderHistory: [], city: 'Indore' }],
      ['POST', '/ai/tools/vendor-reply', { message: 'hi' }],
    ];

    it.each(endpoints)('%s %s: no token 401; customer, partner, seller 403', async (method, path, body) => {
      const r0 = await req(method, path, body);
      expect(r0.status).toBe(401);
      for (const u of [USERS.cust, USERS.partner, USERS.seller]) { const r = await req(method, path, body, sign(u)); expect(r.status).toBe(403); }
    });

    it('a customer token that claims ADMIN is still refused (role comes from the database)', async () => {
      expect((await req('GET', '/ai/tools/usage', undefined, sign(USERS.cust, { role: 'ADMIN' }))).status).toBe(403);
    });

    it('an admin gets the usage view (no cost shown without configured pricing)', async () => {
      const res = await req('GET', '/ai/tools/usage', undefined, sign(USERS.admin));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.estimatedCostInr).toBeNull();
      expect(body.limits).toBeTruthy();
      expect(JSON.stringify(body)).not.toMatch(/sk-|OPENAI_API_KEY/);
    });

    it('an admin passes the guard on generation endpoints', async () => {
      const res = await req('POST', '/ai/tools/generate/seo', { type: 'service', subject: 'AC' }, sign(USERS.admin));
      expect([401, 403]).not.toContain(res.status);
    });
  });
});
