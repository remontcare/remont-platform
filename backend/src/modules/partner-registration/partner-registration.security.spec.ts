import { PartnerRegistrationService } from './partner-registration.module';

/**
 * saveStep() persists an arbitrary partial payload from an unauthenticated applicant (it's a
 * public multi-step draft-save endpoint). It must strip trust fields the applicant could
 * otherwise mass-assign onto their own draft: invitedByAgencyId (grants agency membership on
 * approval — must only be set by an agency owner's own inviteAgencyMember() call),
 * agreedTerms/agreedAt (the legal-consent gate — only submit() may set these), and userId
 * (linked only once an application is actually approved).
 */
function makeService() {
  const prisma: any = {
    partnerRegistration: { findUnique: jest.fn(), update: jest.fn() },
  };
  const events: any = {};
  const service = new PartnerRegistrationService(prisma, events);
  return { service, prisma };
}

describe('PartnerRegistrationService saveStep mass-assignment protection', () => {
  it('never writes invitedByAgencyId from client-supplied step data', async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({
      registrationId: 'PR-1', agreedTerms: false, currentStep: 1,
    });
    prisma.partnerRegistration.update.mockResolvedValue({});

    await service.saveStep('PR-1', 2, { fullName: 'Attacker', invitedByAgencyId: 'someone-elses-agency-id' });

    const writeData = prisma.partnerRegistration.update.mock.calls[0][0].data;
    expect(writeData.invitedByAgencyId).toBeUndefined();
    expect(writeData.fullName).toBe('Attacker');
  });

  it('never writes agreedTerms/agreedAt/userId from client-supplied step data', async () => {
    const { service, prisma } = makeService();
    prisma.partnerRegistration.findUnique.mockResolvedValue({
      registrationId: 'PR-1', agreedTerms: false, currentStep: 1,
    });
    prisma.partnerRegistration.update.mockResolvedValue({});

    await service.saveStep('PR-1', 2, {
      agreedTerms: true, agreedAt: new Date().toISOString(), userId: 'some-other-user-id',
    });

    const writeData = prisma.partnerRegistration.update.mock.calls[0][0].data;
    expect(writeData.agreedTerms).toBeUndefined();
    expect(writeData.agreedAt).toBeUndefined();
    expect(writeData.userId).toBeUndefined();
  });
});
