import sharp from 'sharp';

// Documents now go through the shared KYC check, which includes a ClamAV scan — mocked as
// clean here (same hoisting-safe pattern as upload-security.interceptor.spec.ts).
jest.mock('clamscan', () => {
  const scanStream = jest.fn().mockResolvedValue({ isInfected: false, viruses: [] });
  const init = jest.fn().mockImplementation(async () => ({ scanStream }));
  return jest.fn().mockImplementation(() => ({ init }));
});

import { PartnerRegistrationService } from './partner-registration.module';

let realJpeg: Buffer;
beforeAll(async () => {
  realJpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer();
});

/**
 * saveStep() persists an arbitrary partial payload from the applicant (it's a
 * self-service multi-step draft-save endpoint). It must strip trust fields the applicant could
 * otherwise mass-assign onto their own draft: invitedByAgencyId (grants agency membership on
 * approval — must only be set by an agency owner's own inviteAgencyMember() call),
 * agreedTerms/agreedAt (the legal-consent gate — only submit() may set these), and userId
 * (linked only once an application is actually approved).
 */
const OWNER: any = { sub: 'owner', phone: '+919666321542' };

function makeService() {
  const prisma: any = {
    partnerRegistration: { findUnique: jest.fn(), update: jest.fn() },
  };
  const events: any = {};
  const service = new PartnerRegistrationService(prisma, events);
  return { service, prisma };
}

// A real, decodable JPEG data URL, well under the 5MB cap (magic bytes alone no longer pass —
// the image must actually decode).
function fakeJpegDataUrl(): string {
  return `data:image/jpeg;base64,${realJpeg.toString('base64')}`;
}

describe('PartnerRegistrationService saveStep mass-assignment protection', () => {
  it('never writes invitedByAgencyId from client-supplied step data', async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ phone: '+919666321542', registrationId: 'PR-1', agreedTerms: false, currentStep: 1,
    });
    prisma.partnerRegistration.update.mockResolvedValue({});

    await service.saveStep('PR-1', 2, { fullName: 'Attacker', invitedByAgencyId: 'someone-elses-agency-id' }, OWNER);

    const writeData = prisma.partnerRegistration.update.mock.calls[0][0].data;
    expect(writeData.invitedByAgencyId).toBeUndefined();
    expect(writeData.fullName).toBe('Attacker');
  });

  it('never writes agreedTerms/agreedAt/userId from client-supplied step data', async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ phone: '+919666321542', registrationId: 'PR-1', agreedTerms: false, currentStep: 1,
    });
    prisma.partnerRegistration.update.mockResolvedValue({});

    await service.saveStep('PR-1', 2, {
      agreedTerms: true, agreedAt: new Date().toISOString(), userId: 'some-other-user-id',
    }, OWNER);

    const writeData = prisma.partnerRegistration.update.mock.calls[0][0].data;
    expect(writeData.agreedTerms).toBeUndefined();
    expect(writeData.agreedAt).toBeUndefined();
    expect(writeData.userId).toBeUndefined();
  });
});

/**
 * saveStep()/adminUpdateDetails() accept a document field as a raw client-supplied base64
 * data URL — the frontend's file-type/size check is JS-only and trivially bypassed by
 * calling this public API directly. Server-side magic-byte validation is the real gate.
 */
describe('PartnerRegistrationService document upload validation', () => {
  it('rejects a document field whose content does not match a real JPG/PNG/PDF magic byte', async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ phone: '+919666321542', registrationId: 'PR-1', agreedTerms: false, currentStep: 1, status: 'PENDING' });

    const fakeExecutableDisguisedAsJpeg = `data:image/jpeg;base64,${Buffer.from('MZ\x90\x00 not actually a jpeg').toString('base64')}`;

    await expect(service.saveStep('PR-1', 5, { profilePhotoUrl: fakeExecutableDisguisedAsJpeg }, OWNER))
      .rejects.toThrow(/does not match its declared type/);
    expect(prisma.partnerRegistration.update).not.toHaveBeenCalled();
  });

  it('rejects a document field with a disallowed declared mime type', async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ phone: '+919666321542', registrationId: 'PR-1', agreedTerms: false, currentStep: 1, status: 'PENDING' });

    await expect(service.saveStep('PR-1', 5, { panCardUrl: 'data:application/x-msdownload;base64,TVo=' }, OWNER))
      .rejects.toThrow(/only JPG, PNG, WebP or PDF/);
  });

  it('rejects an oversized document', async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ phone: '+919666321542', registrationId: 'PR-1', agreedTerms: false, currentStep: 1, status: 'PENDING' });

    const oversized = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(6 * 1024 * 1024)]).toString('base64')}`;

    await expect(service.saveStep('PR-1', 5, { idProofFront: oversized }, OWNER)).rejects.toThrow(/under 5MB/);
  });

  it('accepts a document field with real magic bytes and a valid mime', async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ phone: '+919666321542', registrationId: 'PR-1', agreedTerms: false, currentStep: 1, status: 'PENDING' });
    prisma.partnerRegistration.update.mockResolvedValue({});

    await expect(service.saveStep('PR-1', 5, { profilePhotoUrl: fakeJpegDataUrl() }, OWNER)).resolves.toEqual({ saved: true, step: 5 });
  });

  it('leaves an already-uploaded placeholder ("[uploaded]") alone — getDraft()\'s own redaction round-tripping back', async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ phone: '+919666321542', registrationId: 'PR-1', agreedTerms: false, currentStep: 1, status: 'PENDING' });
    prisma.partnerRegistration.update.mockResolvedValue({});

    await expect(service.saveStep('PR-1', 5, { profilePhotoUrl: '[uploaded]' }, OWNER)).resolves.toEqual({ saved: true, step: 5 });
  });
});

/**
 * MORE_DOCS/HOLD are "admin sent this back for a fix" states — without reopening saveStep(),
 * an applicant flagged for missing/unclear documents would have no way to ever resubmit.
 */
describe('PartnerRegistrationService — resubmission after MORE_DOCS/HOLD', () => {
  it('blocks further edits once fully submitted and still PENDING', async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ phone: '+919666321542', registrationId: 'PR-1', agreedTerms: true, currentStep: 8, status: 'PENDING' });

    await expect(service.saveStep('PR-1', 5, { fullName: 'Edited' }, OWNER)).rejects.toThrow(/already submitted/);
  });

  it('allows edits when status is MORE_DOCS even though fully submitted before', async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ phone: '+919666321542', registrationId: 'PR-1', agreedTerms: true, currentStep: 8, status: 'MORE_DOCS' });
    prisma.partnerRegistration.update.mockResolvedValue({});

    await expect(service.saveStep('PR-1', 5, { panCardUrl: fakeJpegDataUrl() }, OWNER)).resolves.toEqual({ saved: true, step: 5 });
  });

  it('allows edits when status is HOLD', async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ phone: '+919666321542', registrationId: 'PR-1', agreedTerms: true, currentStep: 8, status: 'HOLD' });
    prisma.partnerRegistration.update.mockResolvedValue({});

    await expect(service.saveStep('PR-1', 3, { city: 'Indore' }, OWNER)).resolves.toEqual({ saved: true, step: 3 });
  });
});

/**
 * submit() is the one point that must prove OTP was really verified, and that GPS is present
 * and inside India — everything before it (init/save-step) is @Public() with no such check.
 */
describe('PartnerRegistrationService.submit — OTP verification + mandatory in-India GPS', () => {
  function baseRec(overrides: Record<string, unknown> = {}) {
    // A complete, not-yet-submitted draft (agreedTerms is only ever set by submit()).
    const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    return {
      id: 'row-1', registrationId: 'PR-1', fullName: 'Rahul', phone: '+919666321542',
      gender: 'MALE', dateOfBirth: '1990-04-12', city: 'Bhopal',
      categories: ['ELECTRICAL'], experienceYears: '3-5',
      idProofType: 'AADHAAR', idProofFront: IMG, profilePhotoUrl: IMG,
      bankAccountName: 'Rahul', bankAccountNumber: '50100123456789', bankIfsc: 'HDFC0001234',
      emergencyName: 'Sita', emergencyRelation: 'SPOUSE', emergencyPhone: '9876543210',
      agreedTerms: false, agreedBackground: true, agreedCommission: true, agreedStandards: true,
      latitude: 23.25, longitude: 77.41, status: 'PENDING',
      ...overrides,
    };
  }
  function makeServiceWithUser(user: any) {
    const prisma: any = {
      partnerRegistration: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    };
    const events: any = {};
    const service = new PartnerRegistrationService(prisma, events);
    return { service, prisma };
  }

  it('rejects submit when no User row exists for the phone at all (OTP never even sent)', async () => {
    const { service, prisma } = makeServiceWithUser(null);
    prisma.partnerRegistration.findUnique.mockResolvedValue(baseRec());

    await expect(service.submit('PR-1', OWNER)).rejects.toThrow(/not verified/);
    expect(prisma.partnerRegistration.update).not.toHaveBeenCalled();
  });

  it('rejects submit when the User exists but OTP was never verified (isVerified: false)', async () => {
    const { service, prisma } = makeServiceWithUser({ isVerified: false });
    prisma.partnerRegistration.findUnique.mockResolvedValue(baseRec());

    await expect(service.submit('PR-1', OWNER)).rejects.toThrow(/not verified/);
    expect(prisma.partnerRegistration.update).not.toHaveBeenCalled();
  });

  it('rejects submit when GPS was never captured', async () => {
    const { service, prisma } = makeServiceWithUser({ isVerified: true });
    prisma.partnerRegistration.findUnique.mockResolvedValue(baseRec({ latitude: null, longitude: null }));

    await expect(service.submit('PR-1', OWNER)).rejects.toThrow(/Location is required/);
  });

  it('rejects submit for a GPS location outside India', async () => {
    const { service, prisma } = makeServiceWithUser({ isVerified: true });
    // London
    prisma.partnerRegistration.findUnique.mockResolvedValue(baseRec({ latitude: 51.5074, longitude: -0.1278 }));

    await expect(service.submit('PR-1', OWNER)).rejects.toThrow(/within India/);
  });

  it('accepts submit for an OTP-verified user with a valid in-India GPS location', async () => {
    const { service, prisma } = makeServiceWithUser({ isVerified: true });
    prisma.partnerRegistration.findUnique.mockResolvedValue(baseRec());

    const result = await service.submit('PR-1', OWNER);

    expect(result.status).toBe('PENDING');
    expect(prisma.partnerRegistration.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { registrationId: 'PR-1' },
      data: expect.objectContaining({ status: 'PENDING' }),
    }));
  });
});

/**
 * adminUpdateDetails() lets an admin correct applicant-submitted data (e.g. a mistyped
 * phone/category) before deciding status — separate from adminUpdateStatus(), so editing
 * data is never itself an approval action.
 */
describe('PartnerRegistrationService.adminUpdateDetails', () => {
  function makeAdminService() {
    const prisma: any = {
      partnerRegistration: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    const events: any = {};
    const service = new PartnerRegistrationService(prisma, events);
    return { service, prisma };
  }

  it('updates applicant-editable fields', async () => {
    const { service, prisma } = makeAdminService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ id: 'reg-1' });

    await service.adminUpdateDetails('reg-1', { fullName: 'Corrected Name', city: 'Indore', categories: ['PLUMBING'] });

    expect(prisma.partnerRegistration.update).toHaveBeenCalledWith({
      where: { id: 'reg-1' },
      data: { fullName: 'Corrected Name', city: 'Indore', categories: ['PLUMBING'] },
    });
  });

  it('strips status/userId/agreedTerms/invitedByAgencyId — those are not editable through this endpoint', async () => {
    const { service, prisma } = makeAdminService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ id: 'reg-1' });

    await service.adminUpdateDetails('reg-1', {
      status: 'APPROVED', userId: 'hijack', agreedTerms: true, invitedByAgencyId: 'someone-elses-agency',
      fullName: 'Still Editable',
    });

    const writeData = prisma.partnerRegistration.update.mock.calls[0][0].data;
    expect(writeData.status).toBeUndefined();
    expect(writeData.userId).toBeUndefined();
    expect(writeData.agreedTerms).toBeUndefined();
    expect(writeData.invitedByAgencyId).toBeUndefined();
    expect(writeData.fullName).toBe('Still Editable');
  });

  it('validates a corrected document field the same way saveStep() does', async () => {
    const { service, prisma } = makeAdminService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ id: 'reg-1' });

    await expect(service.adminUpdateDetails('reg-1', { panCardUrl: 'data:image/jpeg;base64,bm90IGEgcmVhbCBqcGVn' }))
      .rejects.toThrow(/does not match its declared type/);
  });
});

/** draft exposes PAN + bank account number — it must answer only for the token's own phone. */
describe('PartnerRegistrationService.getDraft — owner only', () => {
  it("returns the draft to its owner and 'not found' to anyone else", async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({ registrationId: 'PR-1', phone: '+919666321542', bankAccountNumber: '123' });

    await expect(service.getDraft('PR-1', { sub: 'x', phone: '+911111111111' } as any)).rejects.toThrow(/not found/);
    await expect(service.getDraft('PR-1', { sub: 'o', phone: '9666321542' } as any)).resolves.toMatchObject({ registrationId: 'PR-1' });
  });
});
