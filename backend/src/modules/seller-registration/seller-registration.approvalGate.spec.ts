import { BadRequestException } from '@nestjs/common';
import { SellerRegistrationService, sellerApprovalBlockers } from './seller-registration.module';

/**
 * An admin could approve any seller row, including a draft the applicant never submitted
 * (status defaults to PENDING at init) — creating a live seller account from an incomplete
 * application. Approval now needs a submitted, complete application, like partner approval.
 */
const complete = {
  id: 'r1', registrationId: 'SR-1', phone: '+919876543210', businessName: 'Shop', ownerName: 'Owner',
  bankAccountNumber: '123456789', bankIfsc: 'HDFC0000001', gstCertificateUrl: 'https://x/g.pdf',
  panCardUrl: 'https://x/p.pdf', ownerPhotoUrl: 'https://x/o.jpg', pickupLocations: [{ id: 'p1' }],
  agreedTerms: true, status: 'PENDING',
};

function makeService(rec: any) {
  const prisma: any = {
    sellerRegistration: { findUnique: jest.fn().mockResolvedValue(rec), update: jest.fn(async (a: any) => ({ ...rec, ...a.data })) },
  };
  const service = new SellerRegistrationService(prisma, { sendCustom: jest.fn() } as any);
  const activate = jest.spyOn(service as any, '_activateSeller').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'notify').mockResolvedValue(undefined);
  return { service, prisma, activate };
}

describe('Seller approval gate', () => {
  it('refuses to approve an application that was never submitted', async () => {
    const { service, prisma, activate } = makeService({ ...complete, agreedTerms: false });
    await expect(service.adminUpdateStatus('r1', 'APPROVED')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.sellerRegistration.update).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it.each([['APPROVED'], ['MORE_INFO'], ['REJECTED']])('refuses to approve from %s', async (from) => {
    const { service, activate } = makeService({ ...complete, status: from });
    await expect(service.adminUpdateStatus('r1', 'APPROVED')).rejects.toBeInstanceOf(BadRequestException);
    expect(activate).not.toHaveBeenCalled();
  });

  it('refuses to approve when a required document is missing', async () => {
    const { service, activate } = makeService({ ...complete, panCardUrl: null });
    await expect(service.adminUpdateStatus('r1', 'APPROVED')).rejects.toThrow(/PAN card/);
    expect(activate).not.toHaveBeenCalled();
  });

  it('approves a submitted, complete application and activates the seller', async () => {
    const { service, activate } = makeService(complete);
    await expect(service.adminUpdateStatus('r1', 'APPROVED')).resolves.toMatchObject({ status: 'APPROVED' });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('other review actions are unchanged for drafts', async () => {
    const { service } = makeService({ ...complete, agreedTerms: false });
    await expect(service.adminUpdateStatus('r1', 'HOLD', 'call back')).resolves.toMatchObject({ status: 'HOLD' });
  });

  it('lists every missing item', () => {
    expect(sellerApprovalBlockers({})).toEqual(['business name', 'owner name', 'phone number', 'a pickup location', 'bank account details', 'GST certificate', 'PAN card', 'owner photo']);
    expect(sellerApprovalBlockers(complete)).toEqual([]);
  });
});
