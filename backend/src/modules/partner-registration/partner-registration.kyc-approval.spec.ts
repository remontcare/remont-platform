import { BadRequestException, ForbiddenException } from '@nestjs/common';

// Document content/virus-scan checks have their own spec (uploads/kyc-document.spec.ts) and need
// a ClamAV daemon; here only that scan is stubbed — everything else is the real service logic.
jest.mock('../uploads/kyc-document', () => ({ ...jest.requireActual('../uploads/kyc-document'), assertSafeKycDocument: jest.fn(async () => undefined) }));

import { PartnerRegistrationService } from './partner-registration.module';
import { assessRegistration, isStoredDocument } from './registration-requirements';

/**
 * Partner/vendor registration must be complete to be submitted, every required KYC document
 * must be verified by an admin before approval, and every decision records the authenticated
 * admin — never one supplied by the browser — in an append-only history.
 */
type Row = Record<string, any>;
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PHONE = '+919666321542';
const OWNER: any = { sub: 'user-applicant', phone: PHONE, role: 'CUSTOMER' };
const ADMIN: any = { sub: 'admin-1', role: 'ADMIN', phone: '+919000000001' };
const ADMIN_USER = { id: 'admin-1', role: 'ADMIN', name: 'Priya Admin', email: 'priya@remontindia.com', phone: '+919000000001' };

const COMPLETE = {
  fullName: 'Ravi Kumar', gender: 'MALE', dateOfBirth: '1990-04-12', city: 'Indore',
  categories: ['ELECTRICAL'], experienceYears: '3-5',
  idProofType: 'AADHAAR', idProofFront: IMG, profilePhotoUrl: IMG,
  bankAccountName: 'Ravi Kumar', bankAccountNumber: '50100123456789', bankIfsc: 'HDFC0001234',
  emergencyName: 'Sita', emergencyRelation: 'SPOUSE', emergencyPhone: '9876543210',
  agreedBackground: true, agreedCommission: true, agreedStandards: true,
  latitude: 22.72, longitude: 75.86,
};

function makeDb(registrations: Row[]) {
  const db = { registrations: registrations.map((r) => ({ ...r })), users: [{ id: 'user-applicant', phone: PHONE, role: 'CUSTOMER', isVerified: true, name: 'Ravi' }, ADMIN_USER] as Row[], vendors: [] as Row[], documents: [] as Row[], audit: [] as Row[] };
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'in' in v ? v.in.includes(row[k]) : row[k] === v));
  const prisma: any = {
    partnerRegistration: {
      findUnique: jest.fn(async ({ where }) => db.registrations.find((r) => matches(r, where)) ?? null),
      findMany: jest.fn(async ({ where }) => db.registrations.filter((r) => matches(r, where))),
      update: jest.fn(async ({ where, data }) => { const r = db.registrations.find((x) => matches(x, where))!; Object.assign(r, data); return { ...r }; }),
    },
    user: {
      findUnique: jest.fn(async ({ where }) => db.users.find((u) => matches(u, where)) ?? null),
      findFirst: jest.fn(async ({ where }) => db.users.find((u) => matches(u, where)) ?? null),
      create: jest.fn(async ({ data }) => { const u = { id: id('user'), ...data }; db.users.push(u); return u; }),
      update: jest.fn(async ({ where, data }) => { const u = db.users.find((x) => matches(x, where))!; Object.assign(u, data); return { ...u }; }),
    },
    serviceVendor: {
      findUnique: jest.fn(async ({ where }) => db.vendors.find((v) => matches(v, where)) ?? null),
      upsert: jest.fn(async ({ where, create }) => { const v = db.vendors.find((x) => matches(x, where)) ?? (db.vendors.push({ id: id('sv'), ...create }), db.vendors[db.vendors.length - 1]); return { id: v.id }; }),
    },
    vendorDocument: { deleteMany: jest.fn(async () => undefined), create: jest.fn(async ({ data }) => { db.documents.push(data); }) },
    auditLog: {
      create: jest.fn(async ({ data }) => { const a = { id: id('audit'), createdAt: new Date(Date.now() + seq), ...data }; db.audit.push(a); return a; }),
      findMany: jest.fn(async ({ where }) => db.audit
        .filter((a) => a.targetType === where.targetType && where.targetId.in.includes(a.targetId))
        .map((a) => ({ ...a, actor: db.users.find((u) => u.id === a.actorId) ?? null }))),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => {
    const snapshot = JSON.parse(JSON.stringify(db));
    try { return await fn(prisma); } catch (e) { Object.assign(db, snapshot); throw e; }
  });
  return { service: new PartnerRegistrationService(prisma, { emit: jest.fn() } as any), db, prisma };
}

const draft = (extra: Row = {}) => ({ id: 'reg-1', registrationId: 'PR-1', phone: PHONE, status: 'PENDING', agreedTerms: false, currentStep: 2, createdAt: 1, ...extra });
const submitted = (extra: Row = {}) => draft({ ...COMPLETE, agreedTerms: true, currentStep: 8, ...extra });

describe('Registration cannot be submitted incomplete', () => {
  it('a mobile-number-only registration is refused and stays an unsubmitted draft', async () => {
    const { service, db } = makeDb([draft()]);
    const err = await service.submit('PR-1', OWNER).catch((e) => e);
    // GPS is the first check (existing message), then the full checklist.
    expect(err).toBeInstanceOf(BadRequestException);
    expect(db.registrations[0]).toMatchObject({ agreedTerms: false, status: 'PENDING', currentStep: 2 });
    const { service: s2, db: db2 } = makeDb([draft({ latitude: 22.7, longitude: 75.8 })]);
    const err2 = await s2.submit('PR-1', OWNER).catch((e) => e);
    expect(err2.getResponse()).toMatchObject({
      missingFields: expect.arrayContaining(['Full name', 'Gender', 'Date of birth', 'City', 'Valid bank account number', 'Valid IFSC code', 'Emergency contact name']),
      missingDocuments: ['ID proof (front)', 'Profile photo'],
    });
    expect(err2.message).toMatch(/incomplete/);
    expect(db2.registrations[0].agreedTerms).toBe(false);
  });

  it.each([
    ['bank details', { bankAccountNumber: '' }, 'Valid bank account number'],
    ['IFSC format', { bankIfsc: 'HDFC123' }, 'Valid IFSC code'],
    ['date of birth', { dateOfBirth: '' }, 'Date of birth'],
    ['emergency phone', { emergencyPhone: '12345' }, 'Valid emergency contact number'],
    ['service category', { categories: [] }, 'At least one service category'],
    ['experience', { experienceYears: null }, 'Experience'],
    ['agreements', { agreedStandards: false }, 'All partner agreements'],
  ])('missing %s blocks submission', async (_l, override, label) => {
    const { service, db } = makeDb([draft({ ...COMPLETE, ...override })]);
    const err = await service.submit('PR-1', OWNER).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().missingFields).toContain(label);
    expect(db.registrations[0].agreedTerms).toBe(false);
  });

  it.each([
    ['not uploaded', null],
    ['a filename', 'aadhaar_front.jpg'],
    ['the [uploaded] marker', '[uploaded]'],
    ['a fake data URL type', 'data:text/html;base64,PGgxPmhpPC9oMT4AAAAAAAAAAAAAAAA='],
    ['a client-side flag', true],
  ])('a required document that is %s does not count as uploaded', async (_l, value) => {
    const { service, db } = makeDb([draft({ ...COMPLETE, idProofFront: value })]);
    const err = await service.submit('PR-1', OWNER).catch((e) => e);
    expect(err.getResponse().missingDocuments).toEqual(['ID proof (front)']);
    expect(db.registrations[0].agreedTerms).toBe(false);
  });

  it('isStoredDocument accepts only real stored files', () => {
    expect(isStoredDocument(IMG)).toBe(true);
    expect(isStoredDocument('https://res.cloudinary.com/remont/image/upload/v1/kyc.jpg')).toBe(true);
    for (const v of ['photo.png', '[uploaded]', 'data:image/png;base64,', 'http://evil/x.png', 'javascript:alert(1)', 1, {}]) expect(isStoredDocument(v)).toBe(false);
  });

  it('API bypass: save-step cannot submit, set status or self-verify documents', async () => {
    const { service, db } = makeDb([draft({ ...COMPLETE })]);
    await service.saveStep('PR-1', 8, {
      agreedTerms: true, status: 'APPROVED', adminNotes: 'looks fine',
      documentReview: { idProofFront: { status: 'VERIFIED', byUserId: 'me' }, profilePhotoUrl: { status: 'VERIFIED', byUserId: 'me' } },
    }, OWNER);
    expect(db.registrations[0]).toMatchObject({ agreedTerms: false, status: 'PENDING' });
    expect(db.registrations[0].documentReview).toBeUndefined();
    expect(db.registrations[0].adminNotes).toBeUndefined();
  });

  it('a complete application submits, enters review (PENDING) and the submission is audited', async () => {
    const { service, db } = makeDb([draft({ ...COMPLETE })]);
    await expect(service.submit('PR-1', OWNER)).resolves.toMatchObject({ status: 'PENDING' });
    expect(db.registrations[0]).toMatchObject({ agreedTerms: true, status: 'PENDING', currentStep: 8 });
    expect(db.audit).toEqual([expect.objectContaining({ action: 'PARTNER_REGISTRATION_SUBMITTED', actorId: 'user-applicant', targetId: 'reg-1' })]);
  });

  it('a submitted application cannot be submitted again until admin returns it', async () => {
    const { service } = makeDb([submitted()]);
    await expect(service.submit('PR-1', OWNER)).rejects.toThrow(/already submitted/);
  });
});

describe('Admin approval requires full verification', () => {
  it('an incomplete application cannot be approved (e.g. a legacy submission without bank details)', async () => {
    const { service, db } = makeDb([submitted({ bankAccountNumber: null, bankIfsc: null })]);
    const err = await service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().approvalBlockers).toEqual(expect.arrayContaining(['Missing: Valid bank account number', 'Missing: Valid IFSC code']));
    expect(db.registrations[0].status).toBe('PENDING');
    expect(db.vendors).toHaveLength(0);
  });

  it('approval without verified documents is rejected', async () => {
    const { service, db } = makeDb([submitted()]);
    const err = await service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN).catch((e) => e);
    expect(err.getResponse().approvalBlockers).toEqual(['Not yet verified: ID proof (front)', 'Not yet verified: Profile photo']);
    expect(db.vendors).toHaveLength(0);
    expect(db.audit).toHaveLength(0);
  });

  it('a rejected mandatory document blocks approval; a verified one lets it through', async () => {
    const { service, db } = makeDb([submitted()]);
    await service.adminReviewDocument('reg-1', 'idProofFront', 'REJECTED', 'Blurry photo', ADMIN);
    await service.adminReviewDocument('reg-1', 'profilePhotoUrl', 'VERIFIED', undefined, ADMIN);
    await expect(service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN)).rejects.toThrow(/Rejected document: ID proof \(front\)/);
    await service.adminReviewDocument('reg-1', 'idProofFront', 'VERIFIED', undefined, ADMIN);
    await expect(service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN)).resolves.toMatchObject({ status: 'APPROVED' });
    expect(db.vendors).toHaveLength(1);
  });

  it('document review validates its input and needs an admin identity', async () => {
    const { service } = makeDb([submitted()]);
    await expect(service.adminReviewDocument('reg-1', 'idProofFront', 'REJECTED', '  ', ADMIN)).rejects.toThrow(/reason/);
    await expect(service.adminReviewDocument('reg-1', 'notADoc', 'VERIFIED', undefined, ADMIN)).rejects.toThrow(/Unknown document/);
    await expect(service.adminReviewDocument('reg-1', 'panCardUrl', 'VERIFIED', undefined, ADMIN)).rejects.toThrow(/not been uploaded/);
    await expect(service.adminReviewDocument('reg-1', 'idProofFront', 'VERIFIED', undefined, OWNER)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an application returned for correction must be resubmitted before approval', async () => {
    const { service } = makeDb([submitted({ status: 'MORE_DOCS' })]);
    await expect(service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN)).rejects.toThrow(/correct and resubmit/);
  });

  it('rejecting or returning needs a reason; a draft cannot be decided at all', async () => {
    const { service } = makeDb([submitted()]);
    await expect(service.adminUpdateStatus('reg-1', 'REJECTED', '', ADMIN)).rejects.toThrow(/reason/);
    await expect(service.adminUpdateStatus('reg-1', 'MORE_DOCS', undefined, ADMIN)).rejects.toThrow(/correct or upload/);
    const { service: s2 } = makeDb([draft()]);
    await expect(s2.adminUpdateStatus('reg-1', 'REJECTED', 'spam', ADMIN)).rejects.toThrow(/not been submitted/);
  });

  it('a non-admin token cannot decide, whatever the body says', async () => {
    const { service } = makeDb([submitted()]);
    await expect(service.adminUpdateStatus('reg-1', 'REJECTED', 'x', OWNER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.adminUpdateStatus('reg-1', 'REJECTED', 'x', undefined as any)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Approval audit trail', () => {
  async function verifiedAndApproved() {
    const ctx = makeDb([submitted()]);
    await ctx.service.adminReviewDocument('reg-1', 'idProofFront', 'VERIFIED', undefined, ADMIN);
    await ctx.service.adminReviewDocument('reg-1', 'profilePhotoUrl', 'VERIFIED', undefined, ADMIN);
    await ctx.service.adminUpdateStatus('reg-1', 'APPROVED', 'All good', ADMIN);
    return ctx;
  }

  it('records the authenticated admin, action, timestamp, reason and before/after status', async () => {
    const { db } = await verifiedAndApproved();
    const approval = db.audit.find((a) => a.action === 'PARTNER_REGISTRATION_APPROVED')!;
    expect(approval).toMatchObject({
      actorId: 'admin-1', actorRole: 'ADMIN', targetType: 'PartnerRegistration', targetId: 'reg-1',
      metadata: { registrationId: 'PR-1', fromStatus: 'PENDING', toStatus: 'APPROVED', reason: 'All good', adminName: 'Priya Admin', adminEmail: 'priya@remontindia.com' },
    });
    expect(approval.createdAt).toBeInstanceOf(Date);
    expect(db.registrations[0].documentReview.idProofFront).toMatchObject({ status: 'VERIFIED', byUserId: 'admin-1', byName: 'Priya Admin' });
  });

  it('the vendor record shows who approved it, and the full history survives later changes', async () => {
    const { service, db } = makeDb([submitted()]);
    await service.adminUpdateStatus('reg-1', 'MORE_DOCS', 'Re-upload ID', ADMIN);
    // applicant replaces the ID → its review (if any) is cleared → resubmits
    await service.saveStep('PR-1', 5, { idProofFront: IMG }, OWNER);
    await service.submit('PR-1', OWNER);
    await service.adminReviewDocument('reg-1', 'idProofFront', 'VERIFIED', undefined, ADMIN);
    await service.adminReviewDocument('reg-1', 'profilePhotoUrl', 'VERIFIED', undefined, ADMIN);
    await service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN);
    db.registrations[0].userId = db.users.find((u) => u.phone === PHONE)!.id;

    const out = await service.historyForVendor(db.vendors[0].id);
    expect(out.approvedBy).toMatchObject({ id: 'admin-1', name: 'Priya Admin', email: 'priya@remontindia.com' });
    expect(out.history.map((h) => h.action)).toEqual([
      'PARTNER_REGISTRATION_RETURNED_FOR_CORRECTION', 'PARTNER_REGISTRATION_RESUBMITTED',
      'PARTNER_DOCUMENT_VERIFIED', 'PARTNER_DOCUMENT_VERIFIED', 'PARTNER_REGISTRATION_APPROVED',
    ]);
    expect(out.history[0].details).toMatchObject({ fromStatus: 'PENDING', toStatus: 'MORE_DOCS', reason: 'Re-upload ID' });
    expect(out.history[1].details).toMatchObject({ fromStatus: 'MORE_DOCS', toStatus: 'PENDING' });
  });

  it('replacing a document clears its earlier verification', async () => {
    const { service, db } = makeDb([submitted({ status: 'MORE_DOCS' })]);
    db.registrations[0].documentReview = { idProofFront: { status: 'VERIFIED', byUserId: 'admin-1', at: 'x' }, profilePhotoUrl: { status: 'VERIFIED', byUserId: 'admin-1', at: 'x' } };
    await service.saveStep('PR-1', 5, { idProofFront: IMG }, OWNER);
    expect(db.registrations[0].documentReview).toEqual({ profilePhotoUrl: expect.objectContaining({ status: 'VERIFIED' }) });
  });

  it('a failed activation leaves no approval record behind', async () => {
    const { service, db, prisma } = makeDb([submitted()]);
    await service.adminReviewDocument('reg-1', 'idProofFront', 'VERIFIED', undefined, ADMIN);
    await service.adminReviewDocument('reg-1', 'profilePhotoUrl', 'VERIFIED', undefined, ADMIN);
    prisma.vendorDocument.create.mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.adminUpdateStatus('reg-1', 'APPROVED', undefined, ADMIN)).rejects.toThrow(/not approved/);
    expect(db.audit.some((a) => a.action === 'PARTNER_REGISTRATION_APPROVED')).toBe(false);
    expect(db.registrations[0].status).toBe('PENDING');
  });

  it('admin detail exposes the checklist and the decision history', async () => {
    const { service } = await verifiedAndApproved();
    const detail = await service.adminDetail('reg-1');
    expect(detail.assessment).toMatchObject({ complete: true, readyForApproval: true });
    expect(detail.decisionHistory.at(-1)).toMatchObject({ action: 'PARTNER_REGISTRATION_APPROVED', actor: { name: 'Priya Admin' } });
  });
});

describe('Existing valid partners stay compatible', () => {
  it('assessRegistration accepts a complete legacy record with hosted document URLs', () => {
    const a = assessRegistration({ ...COMPLETE, agreedTerms: true, idProofFront: 'https://cdn.remontindia.com/kyc/a.jpg', profilePhotoUrl: 'https://cdn.remontindia.com/kyc/b.jpg' });
    expect(a.complete).toBe(true);
    expect(a.approvalBlockers).toEqual(['Not yet verified: ID proof (front)', 'Not yet verified: Profile photo']);
  });
});
