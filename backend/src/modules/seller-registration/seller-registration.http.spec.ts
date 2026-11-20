process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaService } from '../../prisma/prisma.module';
import { WhatsappService } from '../whatsapp/whatsapp.module';
import { JwtStrategy } from '../auth/auth.module';
import { resolveTrustProxyHops } from '../../common/trust-proxy';
import { SellerRegistrationController, SellerRegistrationService } from './seller-registration.module';

/**
 * Over real HTTP, with the real JwtStrategy, guards and throttler (database mocked):
 * the seller-registration API answers only for the phone in the caller's OTP-issued token,
 * and rate limits key on the real client IP behind a single trusted proxy hop.
 */
const USERS: Record<string, any> = {
  a: { id: 'a', phone: '+919876543210', role: 'PRODUCT_VENDOR', isVerified: true, isBlocked: false, name: 'A' },
  b: { id: 'b', phone: '+918888888888', role: 'CUSTOMER', isVerified: true, isBlocked: false, name: 'B' },
};
const REG_OF_B = { id: 'r-b', registrationId: 'SR-20261005-ABCDEF0123', phone: '+918888888888', status: 'PENDING', agreedTerms: false, currentStep: 3, pickupLocations: [] };

describe('seller-registration over HTTP', () => {
  let app: INestApplication;
  let base: string;
  let tokenA: string;
  const prisma: any = {
    user: { findUnique: jest.fn(async ({ where }: any) => USERS[where.id] ?? null) },
    sellerRegistration: {
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async ({ where }: any) => (where.registrationId === REG_OF_B.registrationId ? REG_OF_B : null)),
      create: jest.fn(async ({ data }: any) => ({ ...data, id: 'new' })),
      update: jest.fn(async () => ({})),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: process.env.JWT_SECRET }), ThrottlerModule.forRoot([{ ttl: 60_000, limit: 200 }])],
      controllers: [SellerRegistrationController],
      providers: [
        SellerRegistrationService, JwtStrategy,
        { provide: PrismaService, useValue: prisma },
        { provide: WhatsappService, useValue: { sendCustom: jest.fn() } },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // Same wiring as main.ts on Railway (one proxy hop).
    app.getHttpAdapter().getInstance().set('trust proxy', resolveTrustProxyHops({ RAILWAY_ENVIRONMENT_ID: 'x' } as any));
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/seller-registration`;
    tokenA = moduleRef.get(JwtService).sign({ sub: 'a', phone: USERS.a.phone, role: 'PRODUCT_VENDOR' });
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => { prisma.sellerRegistration.findFirst.mockClear(); prisma.sellerRegistration.create.mockClear(); });

  const call = (path: string, opts: { token?: string; body?: any; ip?: string } = {}) => fetch(base + path, {
    method: opts.body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': opts.ip ?? '10.0.0.1',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  it('rejects every applicant endpoint without a token (phone number alone gets nothing)', async () => {
    expect((await call('/init', { body: { phone: USERS.b.phone } })).status).toBe(401);
    expect((await call(`/status?phone=${encodeURIComponent(USERS.b.phone)}`)).status).toBe(401);
    expect((await call('/save-step', { body: { registrationId: REG_OF_B.registrationId, step: 6, data: { bankAccountNumber: '1' } } })).status).toBe(401);
    expect((await call('/pickup-locations', { body: { registrationId: REG_OF_B.registrationId, locations: [{}] } })).status).toBe(401);
    expect((await call('/submit', { body: { registrationId: REG_OF_B.registrationId } })).status).toBe(401);
    expect((await call(`/draft/${REG_OF_B.registrationId}`)).status).toBe(401);
    expect(prisma.sellerRegistration.update).not.toHaveBeenCalled();
  });

  it('rejects a forged/invalid token', async () => {
    expect((await call('/status', { token: 'not.a.jwt' })).status).toBe(401);
  });

  it("status/init only ever use the token's own phone", async () => {
    expect((await call(`/status?phone=${encodeURIComponent(USERS.b.phone)}`, { token: tokenA })).status).toBe(403);
    expect((await call('/init', { token: tokenA, body: { phone: USERS.b.phone } })).status).toBe(403);
    expect(prisma.sellerRegistration.findFirst).not.toHaveBeenCalled();

    await call('/status', { token: tokenA });
    expect(prisma.sellerRegistration.findFirst.mock.calls[0][0].where).toEqual({ phone: USERS.a.phone });

    const res = await call('/init', { token: tokenA, body: { phone: '9876543210' } });
    expect(res.status).toBe(201);
    expect(prisma.sellerRegistration.create.mock.calls[0][0].data.phone).toBe(USERS.a.phone);
  });

  it("someone else's registration id reads and changes nothing", async () => {
    expect((await call(`/draft/${REG_OF_B.registrationId}`, { token: tokenA })).status).toBe(404);
    expect((await call(`/pickup-locations/${REG_OF_B.registrationId}`, { token: tokenA })).status).toBe(404);
    expect((await call('/save-step', { token: tokenA, body: { registrationId: REG_OF_B.registrationId, step: 6, data: { bankAccountNumber: '1' } } })).status).toBe(404);
    expect((await call('/submit', { token: tokenA, body: { registrationId: REG_OF_B.registrationId } })).status).toBe(404);
    expect(prisma.sellerRegistration.update).not.toHaveBeenCalled();
  });

  it('rate-limits per real client IP; a spoofed X-Forwarded-For prefix cannot dodge it or affect others', async () => {
    // Railway appends the real client IP; whatever the client sent sits to its left.
    for (let i = 0; i < 30; i++) {
      expect((await call('/status', { token: tokenA, ip: `6.6.6.${i}, 203.0.113.7` })).status).toBe(404); // allowed through: no application yet
    }
    expect((await call('/status', { token: tokenA, ip: '1.2.3.4, 203.0.113.7' })).status).toBe(429);
    // A different real client is in its own bucket (not sharing the proxy's address).
    expect((await call('/status', { token: tokenA, ip: '198.51.100.9' })).status).toBe(404);
  });
});

describe('resolveTrustProxyHops', () => {
  it('trusts exactly one hop on Railway, none elsewhere, and honours a sane override', () => {
    expect(resolveTrustProxyHops({ RAILWAY_ENVIRONMENT_NAME: 'production' } as any)).toBe(1);
    expect(resolveTrustProxyHops({} as any)).toBe(0);
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '2', RAILWAY_ENVIRONMENT_NAME: 'p' } as any)).toBe(2);
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: 'true' } as any)).toBe(0);
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '0', RAILWAY_ENVIRONMENT_NAME: 'p' } as any)).toBe(0);
  });
});
