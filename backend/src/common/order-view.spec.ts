import { of, lastValueFrom } from 'rxjs';
import { OrderViewInterceptor, partnerCodeOf, shapeOrderView } from './order-view';

const order = () => ({
  id: 'o1', orderNumber: 'RM-1', customerId: 'cust-1', vendorId: 'cmvendor00000000k3j9x2qa',
  photosBefore: ['https://cdn/b.jpg'], photosAfter: ['https://cdn/a.jpg'],
  vendor: { id: 'cmvendor00000000k3j9x2qa', fullName: 'Ravi', user: { name: 'Ravi', phone: '9' } },
  createdAt: new Date('2026-01-01'),
});

function run(user: any, data: any) {
  const ctx: any = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ user }) }) };
  return lastValueFrom(new OrderViewInterceptor().intercept(ctx, { handle: () => of(data) }));
}

describe('partnerCodeOf', () => {
  it('is stable, readable and derived from the vendor id tail', () => {
    expect(partnerCodeOf('cmvendor00000000k3j9x2qa')).toBe('RP-K3J9-X2QA');
    expect(partnerCodeOf('cmvendor00000000k3j9x2qa')).toBe(partnerCodeOf('cmvendor00000000k3j9x2qa'));
    expect(partnerCodeOf('v-1')).toBe('RP-0000-00V1');
  });
});

describe('OrderViewInterceptor — job evidence + partner code', () => {
  it('hides before/after photos from the customer, wrapped or listed', async () => {
    const res: any = await run({ sub: 'cust-1', role: 'CUSTOMER' }, { childOrders: [order()], ...order() });
    expect(res.photosBefore).toBeUndefined();
    expect(res.photosAfter).toBeUndefined();
    expect(res.childOrders[0].photosAfter).toBeUndefined();
    expect(res.createdAt).toBeInstanceOf(Date);
  });

  it('hides them on public (unauthenticated) tracking and from sellers', async () => {
    expect(((await run(undefined, order())) as any).photosAfter).toBeUndefined();
    expect(((await run({ sub: 's', role: 'PRODUCT_VENDOR' }, order())) as any).photosAfter).toBeUndefined();
  });

  it('keeps them for Remont team and the service partner', async () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN', 'CRM_AGENT', 'SERVICE_VENDOR']) {
      const res: any = await run({ sub: 'staff', role }, [order()]);
      expect(res[0].photosBefore).toEqual(['https://cdn/b.jpg']);
      expect(res[0].photosAfter).toEqual(['https://cdn/a.jpg']);
    }
  });

  it("treats a partner's own customer booking as the customer's view", async () => {
    const res: any = await run({ sub: 'cust-1', role: 'SERVICE_VENDOR' }, order());
    expect(res.photosAfter).toBeUndefined();
  });

  it("adds the assigned partner's code to every order row", async () => {
    const res: any = await run({ sub: 'cust-1', role: 'CUSTOMER' }, [order()]);
    expect(res[0].vendor.partnerCode).toBe('RP-K3J9-X2QA');
  });

  it('never labels a non-order vendor (e.g. a product seller) as a partner', () => {
    const product: any = { id: 'p1', vendor: { id: 'seller-1', businessName: 'Shop' } };
    shapeOrderView(product, { canSeeEvidence: false });
    expect(product.vendor.partnerCode).toBeUndefined();
  });
});
