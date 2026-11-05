import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SellerRegistrationService } from './seller-registration.module';

function makeService(rec: any) {
  const prisma: any = {
    sellerRegistration: { findUnique: jest.fn().mockResolvedValue(rec), update: jest.fn().mockResolvedValue({}) },
    sellerRegistrationPickup: { deleteMany: jest.fn(), createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  };
  return { prisma, service: new SellerRegistrationService(prisma, {} as any) };
}
const owner: any = { sub: 'u1', phone: '+919876543210', role: 'CUSTOMER' };
const stranger: any = { sub: 'u2', phone: '+911111111111', role: 'CUSTOMER' };
const draft = { id: 'r1', registrationId: 'SR-1', phone: '+919876543210', agreedTerms: false, status: 'PENDING', currentStep: 1, pickupLocations: [] };

describe('SellerRegistrationService ownership + allowlist', () => {
  it('getDraft (PAN/Aadhaar/bank) is owner-only', async () => {
    const { service } = makeService(draft);
    await expect(service.getDraft('SR-1', stranger)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getDraft('SR-1', owner)).resolves.toMatchObject({ registrationId: 'SR-1' });
  });

  it('saveStep cannot rewrite phone, adminNotes or status', async () => {
    const { service, prisma } = makeService(draft);
    await service.saveStep('SR-1', 2, { businessName: 'Shop', phone: '+910000000000', adminNotes: 'ok', status: 'APPROVED' }, owner);
    expect(prisma.sellerRegistration.update.mock.calls[0][0].data).toEqual({ businessName: 'Shop', currentStep: 2 });
  });

  it('saveStep keeps an already-stored document when the draft placeholder is echoed back', async () => {
    const { service, prisma } = makeService(draft);
    await service.saveStep('SR-1', 5, { panCardUrl: '[uploaded]' }, owner);
    expect(prisma.sellerRegistration.update.mock.calls[0][0].data.panCardUrl).toBeUndefined();
  });

  it('saveStep rejects a document that is not a real JPG/PNG/WebP/PDF', async () => {
    const { service, prisma } = makeService(draft);
    const exe = `data:application/pdf;base64,${Buffer.from('MZ\x90\x00', 'binary').toString('base64')}`;
    await expect(service.saveStep('SR-1', 5, { gstCertificateUrl: exe }, owner)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.sellerRegistration.update).not.toHaveBeenCalled();
  });

  it('a MORE_INFO application can only be amended by its logged-in owner', async () => {
    const moreInfo = { ...draft, agreedTerms: true, status: 'MORE_INFO' };
    const { service } = makeService(moreInfo);
    await expect(service.saveStep('SR-1', 1, { bankAccountNumber: '999' }, null)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.saveStep('SR-1', 1, { bankAccountNumber: '999' }, stranger)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.savePickupLocations('SR-1', [{ name: 'x' }], null)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.saveStep('SR-1', 1, { bankAccountNumber: '999' }, owner)).resolves.toMatchObject({ saved: true });
  });

  it('an unsubmitted draft cannot be edited, given pickups or submitted by someone else', async () => {
    const { service, prisma } = makeService(draft);
    await expect(service.saveStep('SR-1', 6, { bankAccountNumber: '999' }, stranger)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.savePickupLocations('SR-1', [{ name: 'x' }], stranger)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.submit('SR-1', stranger)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getPickupLocations('SR-1', stranger)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.sellerRegistration.update).not.toHaveBeenCalled();
  });

  it('init resumes a MORE_INFO application instead of creating a new blank draft', async () => {
    const { service, prisma } = makeService(null);
    prisma.sellerRegistration.findFirst = jest.fn().mockResolvedValue({ ...draft, agreedTerms: true, status: 'MORE_INFO', adminNotes: 'Re-upload PAN' });
    prisma.sellerRegistration.create = jest.fn();
    await expect(service.initRegistration('+919876543210')).resolves.toEqual({ registrationId: 'SR-1', isNew: false, status: 'MORE_INFO', adminNotes: 'Re-upload PAN' });
    expect(prisma.sellerRegistration.create).not.toHaveBeenCalled();
  });

  it('init treats a HOLD application as already submitted', async () => {
    const { service, prisma } = makeService(null);
    prisma.sellerRegistration.findFirst = jest.fn().mockResolvedValue({ ...draft, agreedTerms: true, status: 'HOLD' });
    prisma.sellerRegistration.create = jest.fn();
    await expect(service.initRegistration('+919876543210')).resolves.toMatchObject({ alreadySubmitted: true, status: 'HOLD' });
    expect(prisma.sellerRegistration.create).not.toHaveBeenCalled();
  });

  it('pickup locations must be pinned on the map', async () => {
    const { service, prisma } = makeService(draft);
    const loc = { name: 'Main', address: '12 MG Road', city: 'Indore', state: 'MP', pincode: '452001' };
    await expect(service.savePickupLocations('SR-1', [loc], owner)).rejects.toThrow('pin the location on the map');
    await expect(service.savePickupLocations('SR-1', [{ ...loc, latitude: null, longitude: null }], owner)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.savePickupLocations('SR-1', [{ ...loc, address: ' ', latitude: 22.7, longitude: 75.8 }], owner)).rejects.toThrow('address is required');
    expect(prisma.sellerRegistrationPickup.deleteMany).not.toHaveBeenCalled();
    await expect(service.savePickupLocations('SR-1', [{ ...loc, latitude: 22.7196, longitude: 75.8577 }], owner)).resolves.toEqual({ saved: true, count: 1 });
  });

  it('submit requires the GST certificate, PAN card and owner photo', async () => {
    const complete = { ...draft, businessName: 'Shop', ownerName: 'A', bankAccountNumber: '123456', bankIfsc: 'HDFC0001234', pickupLocations: [{ id: 'pk' }],
      gstCertificateUrl: 'data:x', panCardUrl: 'data:x', ownerPhotoUrl: 'data:x' };
    for (const [k, msg] of [['gstCertificateUrl', 'GST certificate'], ['panCardUrl', 'PAN card'], ['ownerPhotoUrl', 'Owner photo']]) {
      const { service } = makeService({ ...complete, [k]: null });
      await expect(service.submit('SR-1', owner)).rejects.toThrow(msg);
    }
    const { service, prisma } = makeService(complete);
    prisma.user = { findUnique: jest.fn().mockResolvedValue(null) };
    prisma.legalPolicy = { findMany: jest.fn().mockResolvedValue([]) };
    await expect(service.submit('SR-1', owner)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('submit cannot reset an already-decided application', async () => {
    const { service } = makeService({ ...draft, agreedTerms: true, status: 'APPROVED' });
    await expect(service.submit('SR-1', owner)).rejects.toBeInstanceOf(BadRequestException);
  });
});
