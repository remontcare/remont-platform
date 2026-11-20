import { ForbiddenException } from '@nestjs/common';
import { AdminService } from './admin.module';

/**
 * C-11 — DELETE /admin/orders/all hard-deletes Invoice rows (a financial record that must
 * never be destroyed once real GST invoices exist). No frontend call site references this
 * route at all — it's a dev/seed-reset utility that leaked onto the production admin API
 * surface. Now hard-gated to non-production, with an audit log for the allowed (dev) case.
 */
function makeService() {
  const prisma: any = {
    review: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    invoice: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    order: { deleteMany: jest.fn(async () => ({ count: 3 })) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  const config: any = { get: jest.fn((_key: string, def: any) => def) };
  const svc = new AdminService(prisma, config, {} as any, {} as any, {} as any, { emit: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, prisma };
}

describe('AdminService.deleteAllOrders', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = originalEnv; });

  it('is disabled in production — never deletes orders/invoices', async () => {
    process.env.NODE_ENV = 'production';
    const { svc, prisma } = makeService();
    await expect(svc.deleteAllOrders('admin-1', 'SUPER_ADMIN' as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.invoice.deleteMany).not.toHaveBeenCalled();
    expect(prisma.order.deleteMany).not.toHaveBeenCalled();
  });

  it('is allowed outside production, and logs an audit entry for who ran it', async () => {
    process.env.NODE_ENV = 'development';
    const { svc, prisma } = makeService();
    const result = await svc.deleteAllOrders('admin-1', 'SUPER_ADMIN' as any);
    expect(result).toEqual({ deleted: 3 });
    expect(prisma.invoice.deleteMany).toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: 'admin-1', action: 'DELETE_ALL_ORDERS_DEV_ONLY' }),
    }));
  });
});
