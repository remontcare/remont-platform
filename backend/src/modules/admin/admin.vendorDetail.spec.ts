import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.module';

function makeService() {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn(), update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })) },
    vendorDocument: { findUnique: jest.fn(), update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })) },
    vendorCityUpdateRequest: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })) },
    withdrawalRequest: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn() },
  };
  prisma.$transaction = jest.fn(async (arg: any) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg(prisma);
  });
  const config: any = { get: jest.fn((_key: string, def: any) => def) };
  const payments: any = {};
  const settlements: any = {};
  const cities: any = {};
  const events: any = { emit: jest.fn() };
  const ledger: any = {
    ledgerForVendor: jest.fn().mockResolvedValue([]),
    availableBalance: jest.fn().mockResolvedValue(0),
  };
  const svc = new AdminService(prisma, config, payments, settlements, cities, events, ledger, {} as any, {} as any);
  return { svc, prisma, ledger, events };
}

describe('AdminService.getVendorDetail', () => {
  it('404s when the vendor does not exist', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue(null);
    await expect(svc.getVendorDetail('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('assembles profile, ledger, balance and withdrawals for an existing vendor', async () => {
    const { svc, prisma, ledger } = makeService();
    prisma.serviceVendor.findUnique.mockResolvedValue({ id: 'vendor-1', fullName: 'Ramesh', documents: [], cityUpdateRequests: [], bankUpdateRequests: [] });
    ledger.ledgerForVendor.mockResolvedValue([{ id: 'l-1' }]);
    ledger.availableBalance.mockResolvedValue(1234);
    prisma.withdrawalRequest.findMany.mockResolvedValue([{ id: 'w-1' }]);

    const result = await svc.getVendorDetail('vendor-1');

    expect(result.fullName).toBe('Ramesh');
    expect(result.ledger).toEqual([{ id: 'l-1' }]);
    expect(result.availableBalance).toBe(1234);
    expect(result.withdrawals).toEqual([{ id: 'w-1' }]);
  });
});

describe('AdminService document verify/reject', () => {
  it('verifyVendorDocument 404s on a missing document', async () => {
    const { svc, prisma } = makeService();
    prisma.vendorDocument.findUnique.mockResolvedValue(null);
    await expect(svc.verifyVendorDocument('doc-missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('verifyVendorDocument sets verified:true and notifies the vendor', async () => {
    const { svc, prisma, events } = makeService();
    prisma.vendorDocument.findUnique.mockResolvedValue({ id: 'doc-1', vendorId: 'vendor-1', type: 'AADHAAR_FRONT', verified: false });
    prisma.serviceVendor.findUnique.mockResolvedValue({ userId: 'vendor-user-1' });

    const result = await svc.verifyVendorDocument('doc-1');

    expect(prisma.vendorDocument.update).toHaveBeenCalledWith({ where: { id: 'doc-1' }, data: { verified: true } });
    expect(result.verified).toBe(true);
    expect(events.emit).toHaveBeenCalledWith('vendor.document.verified', { userId: 'vendor-user-1', docType: 'AADHAAR_FRONT' });
  });

  it('rejectVendorDocument sets verified:false and notifies the vendor', async () => {
    const { svc, prisma, events } = makeService();
    prisma.vendorDocument.findUnique.mockResolvedValue({ id: 'doc-1', vendorId: 'vendor-1', type: 'PAN', verified: true });
    prisma.serviceVendor.findUnique.mockResolvedValue({ userId: 'vendor-user-1' });

    const result = await svc.rejectVendorDocument('doc-1');

    expect(prisma.vendorDocument.update).toHaveBeenCalledWith({ where: { id: 'doc-1' }, data: { verified: false } });
    expect(result.verified).toBe(false);
    expect(events.emit).toHaveBeenCalledWith('vendor.document.rejected', { userId: 'vendor-user-1', docType: 'PAN' });
  });
});

describe('AdminService city-update-request approve/reject', () => {
  it('approveCityUpdate 404s on a missing request', async () => {
    const { svc, prisma } = makeService();
    prisma.vendorCityUpdateRequest.findUnique.mockResolvedValue(null);
    await expect(svc.approveCityUpdate('req-missing', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('approveCityUpdate rejects a request that was already reviewed', async () => {
    const { svc, prisma } = makeService();
    prisma.vendorCityUpdateRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'APPROVED', vendorId: 'vendor-1', requestedCity: 'Indore' });
    await expect(svc.approveCityUpdate('req-1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('approveCityUpdate applies the requested city to ServiceVendor.baseCity, marks the request APPROVED, and notifies the vendor', async () => {
    const { svc, prisma, events } = makeService();
    prisma.vendorCityUpdateRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'PENDING', vendorId: 'vendor-1', requestedCity: 'Indore' });
    prisma.serviceVendor.findUnique.mockResolvedValue({ userId: 'vendor-user-1' });

    await svc.approveCityUpdate('req-1', 'admin-1');

    expect(prisma.serviceVendor.update).toHaveBeenCalledWith({ where: { id: 'vendor-1' }, data: { baseCity: 'Indore' } });
    expect(prisma.vendorCityUpdateRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'req-1' },
      data: expect.objectContaining({ status: 'APPROVED', reviewedBy: 'admin-1' }),
    }));
    expect(events.emit).toHaveBeenCalledWith('vendor.cityUpdate.approved', { userId: 'vendor-user-1', city: 'Indore' });
  });

  it('rejectCityUpdate rejects a request that was already reviewed', async () => {
    const { svc, prisma } = makeService();
    prisma.vendorCityUpdateRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'REJECTED', vendorId: 'vendor-1' });
    await expect(svc.rejectCityUpdate('req-1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejectCityUpdate marks the request REJECTED without touching ServiceVendor.baseCity, and notifies the vendor', async () => {
    const { svc, prisma, events } = makeService();
    prisma.vendorCityUpdateRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'PENDING', vendorId: 'vendor-1', requestedCity: 'Indore' });
    prisma.serviceVendor.findUnique.mockResolvedValue({ userId: 'vendor-user-1' });

    await svc.rejectCityUpdate('req-1', 'admin-1');

    expect(prisma.serviceVendor.update).not.toHaveBeenCalled();
    expect(prisma.vendorCityUpdateRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'req-1' },
      data: expect.objectContaining({ status: 'REJECTED', reviewedBy: 'admin-1' }),
    }));
    expect(events.emit).toHaveBeenCalledWith('vendor.cityUpdate.rejected', { userId: 'vendor-user-1', city: 'Indore' });
  });
});
