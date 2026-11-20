import { BadRequestException, ConflictException } from '@nestjs/common';
import { PartnerRegistrationService } from './partner-registration.module';

/**
 * Partner onboarding defects (2026-10 audit):
 *  1. approval saved APPROVED before activating, and swallowed activation errors
 *     (e.g. duplicate User.email) — approved application, no vendor behind it;
 *  2. a MORE_DOCS/HOLD application could not be resumed — init created a fresh empty draft;
 *  3. unsubmitted drafts (agreedTerms=false, status defaults to PENDING) counted as applications.
 *
 * The fake below is a small in-memory Prisma: unique User.email/phone raise P2002 like Postgres,
 * and $transaction rolls every table back when its callback throws — so "nothing partial was
 * written" is checked against the stored state, not just against which mocks were called.
 */

type Row = Record<string, any>;

function p2002(field: string) {
  return Object.assign(new Error(`Unique constraint failed on the fields: (\`${field}\`)`), { code: 'P2002' });
}

function makeDb(seed: { registrations?: Row[]; users?: Row[]; vendors?: Row[] } = {}) {
  const db = {
    registrations: (seed.registrations ?? []).map((r) => ({ ...r })),
    users: (seed.users ?? []).map((u) => ({ ...u })),
    vendors: (seed.vendors ?? []).map((v) => ({ ...v })),
    documents: [] as Row[],
    audit: [] as Row[],
  };
  // The deciding admin — kept apart from db.users so user-count assertions stay about applicants.
  const admins: Row[] = [ADMIN_USER];
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'in' in v ? v.in.includes(row[k]) : row[k] === v));
  const assertUserUnique = (u: Row) => {
    if (u.email && db.users.some((o) => o.id !== u.id && o.email === u.email)) throw p2002('email');
    if (db.users.some((o) => o.id !== u.id && o.phone === u.phone)) throw p2002('phone');
  };

  const prisma: any = {
    partnerRegistration: {
      findUnique: jest.fn(async ({ where }) => db.registrations.find((r) => matches(r, where)) ?? null),
      findFirst: jest.fn(async ({ where }) =>
        db.registrations.filter((r) => matches(r, where)).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null),
      findMany: jest.fn(async ({ where }) => db.registrations.filter((r) => matches(r, where))),
      count: jest.fn(async ({ where }) => db.registrations.filter((r) => matches(r, where)).length),
      create: jest.fn(async ({ data }) => {
        const row = { id: id('reg'), status: 'PENDING', agreedTerms: false, createdAt: Date.now() + seq, ...data };
        db.registrations.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = db.registrations.find((r) => matches(r, where));
        if (!row) throw new Error('Record to update not found');
        Object.assign(row, data);
        return { ...row };
      }),
    },
    user: {
      findUnique: jest.fn(async ({ where }) => admins.find((u) => matches(u, where)) ?? db.users.find((u) => matches(u, where)) ?? null),
      findFirst: jest.fn(async ({ where }) => db.users.find((u) => matches(u, where)) ?? null),
      create: jest.fn(async ({ data }) => {
        const row = { id: id('user'), ...data };
        assertUserUnique(row);
        db.users.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = db.users.find((u) => matches(u, where))!;
        assertUserUnique({ ...row, ...data });
        Object.assign(row, data);
        return { ...row };
      }),
    },
    serviceVendor: {
      findUnique: jest.fn(async ({ where }) => db.vendors.find((v) => matches(v, where)) ?? null),
      upsert: jest.fn(async ({ where, create, update }) => {
        const row = db.vendors.find((v) => matches(v, where));
        if (row) { Object.assign(row, update); return { id: row.id }; }
        const created = { id: id('sv'), ...create };
        db.vendors.push(created);
        return { id: created.id };
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }) => { const row = { id: id('audit'), createdAt: new Date(), ...data }; db.audit.push(row); return row; }),
      findMany: jest.fn(async ({ where }) => db.audit.filter((a) => matches(a, { targetType: where.targetType, targetId: where.targetId })).map((a) => ({ ...a, actor: admins.find((u) => u.id === a.actorId) ?? db.users.find((u) => u.id === a.actorId) ?? null }))),
    },
    vendorDocument: {
      deleteMany: jest.fn(async ({ where }) => { db.documents = db.documents.filter((d) => !matches(d, where)); }),
      create: jest.fn(async ({ data }) => { db.documents.push({ id: id('doc'), ...data }); }),
    },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: any) => Promise<any>) => {
    const snapshot = JSON.parse(JSON.stringify({ ...db }));
    try {
      return await fn(prisma);
    } catch (e) {
      Object.assign(db, snapshot);
      throw e;
    }
  });

  const events: any = { emit: jest.fn() };
  return { service: new PartnerRegistrationService(prisma, events), prisma, db, events };
}

const PHONE = '+919666321542';
const ADMIN_USER = { id: 'admin-1', role: 'ADMIN', name: 'Priya Admin', email: 'priya@remontindia.com', phone: '+919000000001' };
const ADMIN: any = { sub: 'admin-1', role: 'ADMIN', phone: '+919000000001' };
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD';
const VERIFIED = (key: string) => ({ status: 'VERIFIED', byUserId: 'admin-1', byName: 'Priya Admin', at: '2026-10-09T10:00:00.000Z', key });

function submittedRegistration(extra: Row = {}): Row {
  return {
    id: 'reg-1', registrationId: 'PR-20261005-AAAAAAAAAA', phone: PHONE, status: 'PENDING', agreedTerms: true,
    fullName: 'Ravi Kumar', email: 'ravi@example.com', city: 'Indore', categories: ['ELECTRICAL'],
    language: 'EN', latitude: 22.7, longitude: 75.8, currentStep: 8, createdAt: 1,
    idProofType: 'AADHAAR', idProofFront: IMG, profilePhotoUrl: IMG,
    gender: 'MALE', dateOfBirth: '1990-04-12', experienceYears: '3-5',
    bankAccountName: 'Ravi Kumar', bankAccountNumber: '50100123456789', bankIfsc: 'HDFC0001234',
    emergencyName: 'Sita', emergencyRelation: 'SPOUSE', emergencyPhone: '9876543210',
    agreedBackground: true, agreedCommission: true, agreedStandards: true,
    documentReview: { idProofFront: VERIFIED('idProofFront'), profilePhotoUrl: VERIFIED('profilePhotoUrl') },
    ...extra,
  };
}

const applicant = () => ({ id: 'user-applicant', phone: PHONE, role: 'CUSTOMER', isVerified: true, name: 'Partner', email: null });

describe('Fix 1 — approval is atomic with partner activation', () => {
  it('rejects approval with a clear conflict when the email belongs to another account, and writes nothing', async () => {
    const { service, db } = makeDb({
      registrations: [submittedRegistration()],
      users: [applicant(), { id: 'user-other', phone: '+919000000099', role: 'CUSTOMER', email: 'ravi@example.com' }],
    });

    const err = await service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/ravi@example\.com is already used by another account/);
    expect(db.registrations[0].status).toBe('PENDING');
    expect(db.registrations[0].userId).toBeUndefined();
    expect(db.vendors).toHaveLength(0);
    expect(db.documents).toHaveLength(0);
    expect(db.users.find((u) => u.id === 'user-applicant')!.role).toBe('CUSTOMER');
  });

  it('rolls everything back (status included) when activation fails mid-way, and reports it', async () => {
    const { service, db, prisma } = makeDb({ registrations: [submittedRegistration()], users: [applicant()] });
    // Fail after the status, user and registration link have already been written in the tx.
    prisma.vendorDocument.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN)).rejects.toThrow(/application was not approved/);

    expect(db.registrations[0].status).toBe('PENDING');
    expect(db.registrations[0].userId).toBeUndefined();
    expect(db.vendors).toHaveLength(0);
    expect(db.documents).toHaveLength(0);
    expect(db.users[0].role).toBe('CUSTOMER');
  });

  it('maps a P2002 that slips past the pre-check (race) to the same conflict error, with rollback', async () => {
    const { service, db, prisma } = makeDb({ registrations: [submittedRegistration()], users: [applicant()] });
    const realFindUser = prisma.user.findUnique.getMockImplementation();
    prisma.user.findUnique.mockImplementationOnce(realFindUser).mockResolvedValueOnce(null); // admin identity, then: pre-check sees no holder…
    db.users.push({ id: 'user-late', phone: '+919000000098', email: 'ravi@example.com' }); // …then one appears

    await expect(service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN)).rejects.toBeInstanceOf(ConflictException);
    expect(db.registrations[0].status).toBe('PENDING');
    expect(db.vendors).toHaveLength(0);
  });

  it('still approves normally: APPROVED, role upgraded, vendor + documents created, userId linked', async () => {
    const { service, db } = makeDb({ registrations: [submittedRegistration()], users: [applicant()] });

    const out = await service.adminUpdateStatus('reg-1', 'APPROVED', 'ok', ADMIN);

    expect(out.status).toBe('APPROVED');
    expect(db.registrations[0]).toMatchObject({ status: 'APPROVED', adminNotes: 'ok', userId: 'user-applicant' });
    expect(db.users[0]).toMatchObject({ role: 'SERVICE_VENDOR', email: 'ravi@example.com', name: 'Ravi Kumar' });
    expect(db.vendors).toHaveLength(1);
    expect(db.vendors[0]).toMatchObject({ userId: 'user-applicant', status: 'ACTIVE', baseCity: 'Indore' });
    expect(db.documents.map((d) => d.type).sort()).toEqual(['AADHAAR_FRONT', 'PHOTO']);
  });

  it('allows the applicant\'s own email (already on their own User) — not a conflict', async () => {
    const { service, db } = makeDb({ registrations: [submittedRegistration()], users: [{ ...applicant(), email: 'ravi@example.com' }] });
    await service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN);
    expect(db.registrations[0].status).toBe('APPROVED');
  });

  it('creates the User when the phone has none (no OTP user yet)', async () => {
    const { service, db } = makeDb({ registrations: [submittedRegistration()] });
    await service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN);
    expect(db.users).toHaveLength(1);
    expect(db.users[0]).toMatchObject({ phone: PHONE, role: 'SERVICE_VENDOR', isVerified: true });
    expect(db.vendors).toHaveLength(1);
  });

  it('emits member.approved for an agency-invited member only after the approval committed', async () => {
    const { service, events } = makeDb({
      registrations: [submittedRegistration({ invitedByAgencyId: 'sv-owner' })],
      users: [applicant()],
      vendors: [{ id: 'sv-owner', userId: 'user-owner' }],
    });
    await service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN);
    expect(events.emit).toHaveBeenCalledWith('member.approved', expect.objectContaining({ agencyOwnerUserId: 'user-owner' }));
  });

  it('does not emit member.approved when activation fails', async () => {
    const { service, events } = makeDb({
      registrations: [submittedRegistration({ invitedByAgencyId: 'sv-owner' })],
      users: [applicant(), { id: 'user-other', phone: '+919000000099', email: 'ravi@example.com' }],
      vendors: [{ id: 'sv-owner', userId: 'user-owner' }],
    });
    await expect(service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN)).rejects.toBeInstanceOf(ConflictException);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refuses to approve a draft the applicant never submitted', async () => {
    const { service, db } = makeDb({ registrations: [submittedRegistration({ agreedTerms: false, currentStep: 3 })] });
    await expect(service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.registrations[0].status).toBe('PENDING');
    expect(db.vendors).toHaveLength(0);
  });

  it('leaves non-approval status changes as they were (MORE_DOCS saves directly, no activation)', async () => {
    const { service, db, prisma } = makeDb({ registrations: [submittedRegistration()] });
    await service.adminUpdateStatus('reg-1', 'MORE_DOCS', 'PAN unreadable', ADMIN);
    expect(db.registrations[0]).toMatchObject({ status: 'MORE_DOCS', adminNotes: 'PAN unreadable' });
    // No activation of any kind — only the status change and its audit record.
    expect(prisma.serviceVendor.upsert).not.toHaveBeenCalled();
    expect(db.vendors).toHaveLength(0);
    expect(db.audit).toEqual([expect.objectContaining({ action: 'PARTNER_REGISTRATION_RETURNED_FOR_CORRECTION', actorId: 'admin-1' })]);
  });
});

describe('Fix 2 — a MORE_DOCS/HOLD application is resumed, not replaced', () => {
  for (const status of ['MORE_DOCS', 'HOLD']) {
    it(`returns the same ${status} registration with isNew=false and creates nothing`, async () => {
      const { service, db } = makeDb({ registrations: [submittedRegistration({ status, adminNotes: 'Upload clearer PAN' })] });

      const out = await service.initRegistration(PHONE, 'HI');

      expect(out).toMatchObject({
        registrationId: 'PR-20261005-AAAAAAAAAA', isNew: false, reopened: true, status, adminNotes: 'Upload clearer PAN',
      });
      expect(db.registrations).toHaveLength(1);
      // existing data untouched
      expect(db.registrations[0]).toMatchObject({ fullName: 'Ravi Kumar', city: 'Indore', agreedTerms: true, status });
    });
  }

  it('lets the resumed applicant edit and resubmit the same record, keeping documents already on file', async () => {
    const { service, db } = makeDb({ registrations: [submittedRegistration({ status: 'MORE_DOCS' })] });
    const owner: any = { sub: 'user-applicant', phone: PHONE };

    // The form echoes getDraft()'s '[uploaded]' marker for documents it did not replace.
    await service.saveStep('PR-20261005-AAAAAAAAAA', 5, { city: 'Bhopal', idProofFront: '[uploaded]', profilePhotoUrl: '[uploaded]' }, owner);

    expect(db.registrations[0].city).toBe('Bhopal');
    expect(db.registrations[0].idProofFront).toBe(IMG);
    expect(db.registrations[0].profilePhotoUrl).toBe(IMG);
  });

  it('getDraft() returns the saved answers to the owner, with documents masked', async () => {
    const { service } = makeDb({ registrations: [submittedRegistration({ status: 'HOLD' })] });
    const draft: any = await service.getDraft('PR-20261005-AAAAAAAAAA', { sub: 'u', phone: PHONE, role: 'CUSTOMER' } as any);
    expect(draft).toMatchObject({ fullName: 'Ravi Kumar', city: 'Indore', idProofFront: '[uploaded]', panCardUrl: null });
  });

  it('still reports a submitted PENDING application as alreadySubmitted and an APPROVED one as alreadyApproved', async () => {
    const pending = makeDb({ registrations: [submittedRegistration()] });
    expect(await pending.service.initRegistration(PHONE, 'EN')).toMatchObject({ alreadySubmitted: true });
    const approved = makeDb({ registrations: [submittedRegistration({ status: 'APPROVED' })] });
    expect(await approved.service.initRegistration(PHONE, 'EN')).toMatchObject({ alreadyApproved: true });
  });

  it('a REJECTED applicant still starts a fresh application (unchanged)', async () => {
    const { service, db } = makeDb({ registrations: [submittedRegistration({ status: 'REJECTED' })] });
    const out = await service.initRegistration(PHONE, 'EN');
    expect(out).toMatchObject({ isNew: true });
    expect(db.registrations).toHaveLength(2);
  });
});

describe('normal new registration still works', () => {
  it('creates one draft for a new phone and resumes it (no duplicate) on the next init', async () => {
    const { service, db } = makeDb();
    const first = await service.initRegistration(PHONE, 'EN');
    expect(first).toMatchObject({ isNew: true });
    expect(first.registrationId).toMatch(/^PR-\d{8}-[0-9A-F]{10}$/);
    expect(db.registrations[0]).toMatchObject({ phone: PHONE, agreedTerms: false, currentStep: 1 });

    const again = await service.initRegistration(PHONE, 'HI');
    expect(again).toEqual({ registrationId: first.registrationId, isNew: false });
    expect(db.registrations).toHaveLength(1);
  });
});

describe('Fix 3 — drafts are not applications', () => {
  it('adminList returns and counts only submitted applications (agreedTerms=true)', async () => {
    const { service, prisma } = makeDb({
      registrations: [
        submittedRegistration({ id: 'r1', registrationId: 'PR-1' }),
        submittedRegistration({ id: 'r2', registrationId: 'PR-2', agreedTerms: false }),
        submittedRegistration({ id: 'r3', registrationId: 'PR-3', status: 'MORE_DOCS' }),
      ],
    });

    const all = await service.adminList();
    expect(all.total).toBe(2);
    expect(all.items.map((r: any) => r.registrationId).sort()).toEqual(['PR-1', 'PR-3']);

    const pending = await service.adminList('PENDING');
    expect(pending.total).toBe(1);
    expect(pending.items.map((r: any) => r.registrationId)).toEqual(['PR-1']);
    expect(prisma.partnerRegistration.findMany.mock.calls[1][0].where).toMatchObject({ agreedTerms: true, status: 'PENDING' });
  });
});
