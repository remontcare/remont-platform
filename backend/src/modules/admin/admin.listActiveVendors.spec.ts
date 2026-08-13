import { AdminService } from './admin.module';
import { NOT_FROZEN_MEMBER_FILTER } from '../../common';

/**
 * Regression coverage for the same production incident as
 * orders/orders.dispatch-memberstatus.spec.ts: this endpoint backs the admin "live vendors,
 * assign directly" list, and a bare `memberStatus: { not: 'FROZEN' }` silently excludes every
 * non-agency vendor (memberStatus: null) — not just frozen ones — because NULL <> 'FROZEN' is
 * UNKNOWN under SQL's three-valued logic. Fixed via the shared NOT_FROZEN_MEMBER_FILTER.
 */
function makeService() {
  const prisma: any = { serviceVendor: { findMany: jest.fn().mockResolvedValue([]) } };
  const config: any = { get: jest.fn((_key: string, def: any) => def) };
  const payments: any = {};
  const settlements: any = {};
  const cities: any = {};
  const events: any = {};
  const ledger: any = {};
  const svc = new AdminService(prisma, config, payments, settlements, cities, events, ledger);
  return { svc, prisma };
}

describe('AdminService.listActiveVendors', () => {
  it('uses the null-safe NOT_FROZEN_MEMBER_FILTER, not a bare memberStatus:{not:FROZEN}', async () => {
    const { svc, prisma } = makeService();

    await svc.listActiveVendors('ELECTRICAL');

    expect(prisma.serviceVendor.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isOnline: true, status: 'ACTIVE', ...NOT_FROZEN_MEMBER_FILTER }),
    }));
  });

  it('returns an online, active, skill-matching, non-agency (memberStatus: null) vendor', async () => {
    const { svc, prisma } = makeService();
    prisma.serviceVendor.findMany.mockResolvedValue([
      { id: 'vendor-1', fullName: 'Rahul', memberStatus: null, isOnline: true, status: 'ACTIVE', skills: ['ELECTRICAL'] },
    ]);

    const result = await svc.listActiveVendors('ELECTRICAL');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('vendor-1');
  });
});
