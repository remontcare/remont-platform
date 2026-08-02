import { SellerRegistrationService } from './seller-registration.module';

/**
 * Same mass-assignment concern as PartnerRegistrationService.saveStep: this is a public,
 * unauthenticated draft-save endpoint, so it must not let the applicant write agreedTerms/
 * agreedAt (the legal-consent gate — only submit() may set these) or userId (linked only once
 * an application is actually approved) onto their own draft.
 */
function makeService() {
  const prisma: any = {
    sellerRegistration: { findUnique: jest.fn(), update: jest.fn() },
  };
  const wa: any = {};
  const service = new SellerRegistrationService(prisma, wa);
  return { service, prisma };
}

describe('SellerRegistrationService saveStep mass-assignment protection', () => {
  it('never writes agreedTerms/agreedAt/userId from client-supplied step data', async () => {
    const { service, prisma } = makeService();
    prisma.sellerRegistration.findUnique.mockResolvedValue({
      registrationId: 'SR-1', agreedTerms: false, status: 'PENDING', currentStep: 1,
    });
    prisma.sellerRegistration.update.mockResolvedValue({});

    await service.saveStep('SR-1', 2, {
      businessName: 'Attacker Store', agreedTerms: true, agreedAt: new Date().toISOString(), userId: 'some-other-user-id',
    });

    const writeData = prisma.sellerRegistration.update.mock.calls[0][0].data;
    expect(writeData.agreedTerms).toBeUndefined();
    expect(writeData.agreedAt).toBeUndefined();
    expect(writeData.userId).toBeUndefined();
    expect(writeData.businessName).toBe('Attacker Store');
  });
});
