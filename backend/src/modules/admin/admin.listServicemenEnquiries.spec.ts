import { AdminService } from './admin.module';

// Was filtering on status IN ('PENDING','UNDER_REVIEW') — neither is a valid VendorStatus
// value (PENDING_VERIFICATION/ACTIVE/SUSPENDED/REJECTED) — so the query always silently
// returned zero rows. Asserts the real enum value is used instead.
describe('AdminService.listServicemenEnquiries', () => {
  it('filters on the real VendorStatus.PENDING_VERIFICATION value', async () => {
    const prisma: any = { serviceVendor: { findMany: jest.fn(async () => []) } };
    const config: any = { get: jest.fn((_k: string, fallback?: any) => fallback) };
    const svc = new AdminService(prisma, config, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

    await svc.listServicemenEnquiries();

    expect(prisma.serviceVendor.findMany.mock.calls[0][0].where).toEqual({ status: 'PENDING_VERIFICATION' });
  });
});
