import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.module';

/**
 * The partner app files bank-detail change requests (POST vendors/service/me/bank-update-request)
 * that nothing could review. Approval writes the details onto ServiceVendor; a rejected or
 * already-reviewed request never touches it.
 */
function makeService(request: any) {
  const prisma: any = {
    vendorBankUpdateRequest: {
      findUnique: jest.fn(async () => request),
      update: jest.fn((args: any) => ({ op: 'request.update', args })),
    },
    serviceVendor: { update: jest.fn((args: any) => ({ op: 'vendor.update', args })) },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (ops: any[]) => ops),
  };
  const config: any = { get: jest.fn((_k: string, def: any) => def) };
  const svc = new AdminService(prisma, config, {} as any, {} as any, {} as any, { emit: jest.fn() } as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma };
}

const PENDING = { id: 'bur-1', vendorId: 'sv-1', accountName: 'Ravi Kumar', accountNumber: '1234567890', ifsc: 'HDFC0001234', status: 'PENDING' };

describe('AdminService bank-detail change requests', () => {
  it('approve writes the requested details onto the partner and marks the request APPROVED, atomically', async () => {
    const { svc, prisma } = makeService(PENDING);

    await svc.approveBankUpdate('bur-1', 'admin-1');

    const ops = prisma.$transaction.mock.calls[0][0];
    expect(ops).toHaveLength(2);
    expect(prisma.serviceVendor.update).toHaveBeenCalledWith({
      where: { id: 'sv-1' },
      data: { bankAccountHolder: 'Ravi Kumar', bankAccountNumber: '1234567890', bankIfsc: 'HDFC0001234' },
    });
    expect(prisma.vendorBankUpdateRequest.update).toHaveBeenCalledWith({
      where: { id: 'bur-1' },
      data: expect.objectContaining({ status: 'APPROVED', reviewedBy: 'admin-1', reviewedAt: expect.any(Date) }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'VENDOR_BANK_UPDATE_APPROVED', targetId: 'bur-1' }) });
  });

  it('reject marks the request REJECTED and never touches the partner bank details', async () => {
    const { svc, prisma } = makeService(PENDING);

    await svc.rejectBankUpdate('bur-1', 'admin-1');

    expect(prisma.serviceVendor.update).not.toHaveBeenCalled();
    expect(prisma.vendorBankUpdateRequest.update).toHaveBeenCalledWith({
      where: { id: 'bur-1' },
      data: expect.objectContaining({ status: 'REJECTED', reviewedBy: 'admin-1' }),
    });
  });

  it.each(['APPROVED', 'REJECTED'])('refuses to re-review a request that is already %s', async (status) => {
    const { svc, prisma } = makeService({ ...PENDING, status });
    await expect(svc.approveBankUpdate('bur-1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.rejectBankUpdate('bur-1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.serviceVendor.update).not.toHaveBeenCalled();
  });

  it('404s for an unknown request', async () => {
    const { svc } = makeService(null);
    await expect(svc.approveBankUpdate('nope', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.rejectBankUpdate('nope', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
