process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// This spec is about HTTP auth/ownership; the document content + virus-scan gate has its own
// spec (uploads/kyc-document.spec.ts) and needs a ClamAV daemon, so only the scan is stubbed.
jest.mock('../uploads/kyc-document', () => ({ ...jest.requireActual('../uploads/kyc-document'), assertSafeKycDocument: jest.fn(async () => undefined) }));

import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtStrategy } from '../auth/auth.module';
import {
  AdminPartnerRegistrationController, PartnerRegistrationController, PartnerRegistrationService,
} from './partner-registration.module';

/**
 * Over real HTTP, with the real JwtStrategy and guards (database mocked, nothing touches
 * Railway): partner-registration init/save-step/submit answer only for the phone in the
 * caller's OTP-issued token — same model as seller-registration.http.spec.ts.
 */
const USERS: Record<string, any> = {
  a: { id: 'a', phone: '+919876543210', role: 'SERVICE_VENDOR', isVerified: true, isBlocked: false, name: 'A' },
  b: { id: 'b', phone: '+918888888888', role: 'SERVICE_VENDOR', isVerified: true, isBlocked: false, name: 'B' },
  admin: { id: 'admin', phone: '+917777777777', role: 'ADMIN', isVerified: true, isBlocked: false, name: 'Admin' },
};
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Every item the registration form marks mandatory (registration-requirements.ts).
const COMPLETE_DRAFT = {
  fullName: 'Rahul', gender: 'MALE', dateOfBirth: '1990-04-12', city: 'Indore',
  categories: ['ELECTRICAL'], experienceYears: '3-5',
  idProofType: 'AADHAAR', idProofFront: IMG, profilePhotoUrl: IMG,
  bankAccountName: 'Rahul', bankAccountNumber: '50100123456789', bankIfsc: 'HDFC0001234',
  emergencyName: 'Sita', emergencyRelation: 'SPOUSE', emergencyPhone: '9876543210',
  agreedBackground: true, agreedCommission: true, agreedStandards: true,
  latitude: 23.25, longitude: 77.41,
};

describe('partner-registration over HTTP', () => {
  let app: INestApplication;
  let base: string;
  let tokenA: string;
  let tokenB: string;
  let tokenAdmin: string;
  let regs: Record<string, any>;

  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id ? USERS[where.id] ?? null : Object.values(USERS).find((u: any) => u.phone === where.phone) ?? null),
    },
    partnerRegistration: {
      findFirst: jest.fn(async ({ where }: any) => Object.values(regs).find((r: any) => r.phone === where.phone) ?? null),
      findUnique: jest.fn(async ({ where }: any) => regs[where.registrationId] ?? null),
      create: jest.fn(async ({ data }: any) => { regs[data.registrationId] = { agreedTerms: false, status: 'PENDING', ...data }; return regs[data.registrationId]; }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = where.registrationId ? regs[where.registrationId] : Object.values(regs).find((x: any) => x.id === where.id);
        Object.assign(r, data);
        return r;
      }),
      count: jest.fn(async () => Object.keys(regs).length),
      findMany: jest.fn(async () => Object.values(regs)),
    },
    legalPolicy: { findMany: jest.fn(async () => []) },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: process.env.JWT_SECRET }), ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [PartnerRegistrationController, AdminPartnerRegistrationController],
      providers: [
        PartnerRegistrationService, JwtStrategy,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const jwt = moduleRef.get(JwtService);
    const sign = (u: any) => jwt.sign({ sub: u.id, phone: u.phone, role: u.role });
    tokenA = sign(USERS.a);
    tokenB = sign(USERS.b);
    tokenAdmin = sign(USERS.admin);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    regs = {
      'PR-B': { id: 'rb', registrationId: 'PR-B', phone: USERS.b.phone, status: 'PENDING', agreedTerms: false, currentStep: 3, ...COMPLETE_DRAFT },
    };
    jest.clearAllMocks();
  });

  const post = (path: string, body: any, token?: string) => fetch(`${base}/partner-registration${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = async (r: Response) => { const b: any = await r.json(); return b.data ?? b; };

  it('requires authentication on init, save-step and submit (no token → 401)', async () => {
    expect((await post('/init', { phone: USERS.b.phone })).status).toBe(401);
    expect((await post('/save-step', { registrationId: 'PR-B', step: 6, data: { bankAccountNumber: '1' } })).status).toBe(401);
    expect((await post('/submit', { registrationId: 'PR-B' })).status).toBe(401);
    expect(prisma.partnerRegistration.findFirst).not.toHaveBeenCalled();
    expect(prisma.partnerRegistration.update).not.toHaveBeenCalled();
  });

  it('rejects malformed, forged and wrongly-signed tokens (→ 401)', async () => {
    const forged = (await import('jsonwebtoken')).sign({ sub: 'b', phone: USERS.b.phone, role: 'ADMIN' }, 'attacker-secret');
    for (const bad of ['not.a.jwt', '', forged, `${tokenA.slice(0, -4)}AAAA`]) {
      expect((await post('/init', {}, bad || undefined)).status).toBe(401);
      expect((await post('/save-step', { registrationId: 'PR-B', step: 1, data: {} }, bad || undefined)).status).toBe(401);
      expect((await post('/submit', { registrationId: 'PR-B' }, bad || undefined)).status).toBe(401);
    }
    expect(prisma.partnerRegistration.update).not.toHaveBeenCalled();
  });

  it("user A cannot initialise a registration with user B's phone", async () => {
    const r = await post('/init', { phone: USERS.b.phone }, tokenA);
    expect(r.status).toBe(403);
    expect(prisma.partnerRegistration.findFirst).not.toHaveBeenCalled();
    expect(prisma.partnerRegistration.create).not.toHaveBeenCalled();
  });

  it("init always uses the token's own phone (body phone optional, must match)", async () => {
    const res = await post('/init', { language: 'HI' }, tokenA);
    expect(res.status).toBe(201);
    const d = await json(res);
    expect(d.isNew).toBe(true);
    expect(prisma.partnerRegistration.findFirst.mock.calls[0][0].where).toEqual({ phone: USERS.a.phone });
    expect(prisma.partnerRegistration.create.mock.calls[0][0].data).toMatchObject({ phone: USERS.a.phone, language: 'HI' });

    // Matching phone in another format is accepted and resumes the same draft.
    const again = await json(await post('/init', { phone: '9876543210' }, tokenA));
    expect(again).toEqual({ registrationId: d.registrationId, isNew: false });
  });

  it("init for B's phone, from B, returns B's draft — but never to A", async () => {
    expect(await json(await post('/init', {}, tokenB))).toEqual({ registrationId: 'PR-B', isNew: false });
    const forA = await json(await post('/init', {}, tokenA));
    expect(forA.registrationId).not.toBe('PR-B');
  });

  it("user A cannot save steps to, or submit, user B's registration — it behaves as not found", async () => {
    const save = await post('/save-step', { registrationId: 'PR-B', step: 6, data: { bankAccountNumber: '999', bankIfsc: 'EVIL0000001' } }, tokenA);
    const submit = await post('/submit', { registrationId: 'PR-B' }, tokenA);
    const missingSave = await post('/save-step', { registrationId: 'PR-DOES-NOT-EXIST', step: 6, data: {} }, tokenA);
    const missingSubmit = await post('/submit', { registrationId: 'PR-DOES-NOT-EXIST' }, tokenA);

    for (const r of [save, submit, missingSave, missingSubmit]) expect(r.status).toBe(404);
    // Identical bodies: existence of someone else's id is not revealed.
    const bodies = await Promise.all([save, submit, missingSave, missingSubmit].map((r) => r.json().then((b: any) => b.message)));
    expect(new Set(bodies).size).toBe(1);
    expect(prisma.partnerRegistration.update).not.toHaveBeenCalled();
    expect(regs['PR-B'].bankAccountNumber).not.toBe('999'); // attacker's value never written
    expect(regs['PR-B'].bankIfsc).not.toBe('EVIL0000001');
    expect(regs['PR-B'].status).toBe('PENDING');
    expect(regs['PR-B'].agreedTerms).toBe(false);
  });

  it('the legitimate owner can init, continue (save steps) and submit their registration', async () => {
    const { registrationId } = await json(await post('/init', {}, tokenA));

    const s1 = await post('/save-step', { registrationId, step: 2, data: { fullName: 'Asha', city: 'Indore' } }, tokenA);
    expect(s1.status).toBe(201);
    expect(await json(s1)).toEqual({ saved: true, step: 2 });

    const s8 = await post('/save-step', { registrationId, step: 8, data: COMPLETE_DRAFT }, tokenA);
    expect(s8.status).toBe(201);

    const sub = await post('/submit', { registrationId }, tokenA);
    expect(sub.status).toBe(201);
    expect(await json(sub)).toMatchObject({ registrationId, status: 'PENDING' });
    expect(regs[registrationId]).toMatchObject({ phone: USERS.a.phone, fullName: 'Rahul', city: 'Indore', agreedTerms: true, currentStep: 8 });

    // Once submitted, further edits are refused by the existing business rule.
    expect((await post('/save-step', { registrationId, step: 3, data: { city: 'X' } }, tokenA)).status).toBe(400);
  });

  it('existing business validation still applies for the owner (e.g. missing GPS)', async () => {
    const { registrationId } = await json(await post('/init', {}, tokenA));
    await post('/save-step', { registrationId, step: 8, data: { ...COMPLETE_DRAFT, latitude: null, longitude: null } }, tokenA);
    const r = await post('/submit', { registrationId }, tokenA);
    expect(r.status).toBe(400);
    expect((await r.json() as any).message).toMatch(/Location is required/);
  });

  it('admin partner-registration endpoints still work for admins and stay closed to applicants', async () => {
    const asAdmin = await fetch(`${base}/admin/partner-registrations`, { headers: { Authorization: `Bearer ${tokenAdmin}` } });
    expect(asAdmin.status).toBe(200);
    const asApplicant = await fetch(`${base}/admin/partner-registrations`, { headers: { Authorization: `Bearer ${tokenA}` } });
    expect(asApplicant.status).toBe(403);
    const anonymous = await fetch(`${base}/admin/partner-registrations`);
    expect(anonymous.status).toBe(401);
  });
});
