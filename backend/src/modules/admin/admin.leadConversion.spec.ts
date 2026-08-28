import { AdminService } from './admin.module';

function makeService() {
  const prisma: any = {
    service: { findUnique: jest.fn(async () => ({ id: 'svc-1', categoryId: 'cat-1', basePrice: 1000, durationMinutes: 60 })) },
    city: { findUnique: jest.fn(async () => ({ id: 'city-1', name: 'Bhopal', state: 'Madhya Pradesh', latitude: 23.25, longitude: 77.41 })) },
    user: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async (args: any) => ({ id: 'user-1', ...args.data })),
    },
    address: { create: jest.fn(async (args: any) => ({ id: 'addr-1', ...args.data })) },
    order: {
      count: jest.fn(async () => 0),
      create: jest.fn(async (args: any) => ({ id: 'order-1', ...args.data })),
    },
    commissionRule: { findMany: jest.fn(async () => []) },
    siteSetting: { findUnique: jest.fn(async () => null) },
  };
  const cities: any = { getServicePrice: jest.fn(async () => null) };
  const crm: any = { markConverted: jest.fn(async () => ({})) };
  const config: any = { get: jest.fn((_key: string, fallback?: any) => fallback) };
  const svc = new AdminService(prisma, config, {} as any, {} as any, cities, {} as any, {} as any, {} as any, crm, {} as any, {} as any);
  return { svc, prisma, crm };
}

const baseOrderInput = {
  serviceId: 'svc-1', cityId: 'city-1', slotDate: '2026-09-01', slotTime: '10:00',
  guestName: 'Test Customer', guestPhone: '9999999999', fullAddress: '123 Test Street',
};

describe('AdminService.adminCreateOrder — Convert to Order (admin Leads console)', () => {
  it('links the order to the lead and marks it converted when leadId is provided', async () => {
    const { svc, prisma, crm } = makeService();
    const order = await svc.adminCreateOrder({ ...baseOrderInput, leadId: 'lead-1' });
    expect(prisma.order.create.mock.calls[0][0].data.leadId).toBe('lead-1');
    expect(crm.markConverted).toHaveBeenCalledWith('lead-1', order.id);
  });

  it('never calls markConverted for an ordinary order with no leadId', async () => {
    const { svc, prisma, crm } = makeService();
    await svc.adminCreateOrder(baseOrderInput);
    expect(prisma.order.create.mock.calls[0][0].data.leadId).toBeUndefined();
    expect(crm.markConverted).not.toHaveBeenCalled();
  });
});
