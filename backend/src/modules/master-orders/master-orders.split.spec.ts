import { groupCartForSplit, allocateAcrossGroups, deriveMasterProgress, resolveCheckoutPaymentOptions, SplitCartItem } from './master-orders.module';

describe('groupCartForSplit', () => {
  it('gives a single service its own group', () => {
    const items: SplitCartItem[] = [{ type: 'SERVICE', serviceId: 'svc-1', categoryId: 'cat-plumbing', quantity: 1 }];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ type: 'SERVICE', categoryId: 'cat-plumbing', services: [{ serviceId: 'svc-1', quantity: 1 }] });
  });

  // Smart Order Grouping: Same Customer + Same Address + Same Service Category + Same
  // Checkout = ONE Order. Two services from the same category (e.g. Electrical: Fan
  // Installation + Switch Board Installation) must collapse into a single group/child
  // Order carrying both — not one child order per service, and not the old
  // "combined-price, first-service-only" bug either (both services survive, each with
  // its own line item — see checkout()'s per-line pricing and the OrderServiceItem rows
  // it creates).
  it('groups two services from the SAME category into ONE group', () => {
    const items: SplitCartItem[] = [
      { type: 'SERVICE', serviceId: 'fan-install', categoryId: 'cat-electrical', quantity: 1 },
      { type: 'SERVICE', serviceId: 'switchboard-install', categoryId: 'cat-electrical', quantity: 1 },
    ];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(1);
    const g = groups[0] as any;
    expect(g.type).toBe('SERVICE');
    expect(g.categoryId).toBe('cat-electrical');
    const serviceIds = g.services.map((s: any) => s.serviceId).sort();
    expect(serviceIds).toEqual(['fan-install', 'switchboard-install']);
  });

  it('gives each DIFFERENT category its own group — Electrical + Carpenter = 2 groups', () => {
    const items: SplitCartItem[] = [
      { type: 'SERVICE', serviceId: 'fan-install', categoryId: 'cat-electrical', quantity: 1 },
      { type: 'SERVICE', serviceId: 'carpenter-svc', categoryId: 'cat-carpenter', quantity: 1 },
    ];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(2);
    const categoryIds = groups.map((g: any) => g.categoryId).sort();
    expect(categoryIds).toEqual(['cat-carpenter', 'cat-electrical']);
  });

  it('splits Electrical + Plumbing + Carpenter into 3 groups', () => {
    const items: SplitCartItem[] = [
      { type: 'SERVICE', serviceId: 'fan-install', categoryId: 'cat-electrical', quantity: 1 },
      { type: 'SERVICE', serviceId: 'tap-repair', categoryId: 'cat-plumbing', quantity: 1 },
      { type: 'SERVICE', serviceId: 'carpenter-svc', categoryId: 'cat-carpenter', quantity: 1 },
    ];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(3);
  });

  it('groups two Electrical services + two Carpenter services into exactly 2 groups', () => {
    const items: SplitCartItem[] = [
      { type: 'SERVICE', serviceId: 'fan-install', categoryId: 'cat-electrical', quantity: 1 },
      { type: 'SERVICE', serviceId: 'switchboard-install', categoryId: 'cat-electrical', quantity: 1 },
      { type: 'SERVICE', serviceId: 'carpenter-a', categoryId: 'cat-carpenter', quantity: 1 },
      { type: 'SERVICE', serviceId: 'carpenter-b', categoryId: 'cat-carpenter', quantity: 1 },
    ];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(2);
    const electricalGroup = groups.find((g: any) => g.categoryId === 'cat-electrical') as any;
    const carpenterGroup = groups.find((g: any) => g.categoryId === 'cat-carpenter') as any;
    expect(electricalGroup.services).toHaveLength(2);
    expect(carpenterGroup.services).toHaveLength(2);
  });

  it('merges duplicate entries of the same service within a category group by summing quantity', () => {
    const items: SplitCartItem[] = [
      { type: 'SERVICE', serviceId: 'svc-1', categoryId: 'cat-plumbing', quantity: 1 },
      { type: 'SERVICE', serviceId: 'svc-1', categoryId: 'cat-plumbing', quantity: 2 },
    ];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(1);
    const g = groups[0] as any;
    expect(g.services).toEqual([{ serviceId: 'svc-1', quantity: 3 }]);
  });

  it('groups products by distinct vendorId — one child order per seller', () => {
    const items: SplitCartItem[] = [
      { type: 'PRODUCT', productId: 'pvc-pipe', vendorId: 'seller-a', quantity: 1 },
      { type: 'PRODUCT', productId: 'wall-mount', vendorId: 'seller-b', quantity: 1 },
    ];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(2);
    const vendorIds = groups.map((g: any) => g.vendorId).sort();
    expect(vendorIds).toEqual(['seller-a', 'seller-b']);
  });

  it('keeps multiple products from the same seller in one group', () => {
    const items: SplitCartItem[] = [
      { type: 'PRODUCT', productId: 'pvc-pipe', vendorId: 'seller-a', quantity: 1 },
      { type: 'PRODUCT', productId: 'wall-mount', vendorId: 'seller-a', quantity: 2 },
    ];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(1);
    expect((groups[0] as any).items).toHaveLength(2);
  });

  it('buckets products with no vendor under one "unassigned" group rather than dropping them', () => {
    const items: SplitCartItem[] = [
      { type: 'PRODUCT', productId: 'demo-item', vendorId: null, quantity: 1 },
    ];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(1);
    expect((groups[0] as any).vendorId).toBeNull();
  });

  it('splits a mixed cart into the right number of category/seller groups', () => {
    const items: SplitCartItem[] = [
      { type: 'SERVICE', serviceId: 'plumbing-1', categoryId: 'cat-plumbing', quantity: 1 },
      { type: 'SERVICE', serviceId: 'electrical-1', categoryId: 'cat-electrical', quantity: 1 },
      { type: 'PRODUCT', productId: 'p1', vendorId: 'seller-a', quantity: 1 },
      { type: 'PRODUCT', productId: 'p2', vendorId: 'seller-b', quantity: 1 },
    ];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(4);
  });

  it('same category but a different address/checkout call is out of scope for this pure function — each checkout() call groups only its own items', () => {
    // The "different address ⇒ separate orders" and "different checkout ⇒ separate
    // orders" rules aren't grouping logic at all: checkout() resolves exactly one
    // address per HTTP request and groupCartForSplit only ever sees the items from that
    // one request, so two separate checkout() calls (two addresses, or the same address
    // twice) necessarily produce two separate MasterOrders/child Orders without this
    // function needing to know about either address or checkout identity.
    const checkoutA: SplitCartItem[] = [{ type: 'SERVICE', serviceId: 'fan-install', categoryId: 'cat-electrical', quantity: 1 }];
    const checkoutB: SplitCartItem[] = [{ type: 'SERVICE', serviceId: 'switchboard-install', categoryId: 'cat-electrical', quantity: 1 }];
    expect(groupCartForSplit(checkoutA)).toHaveLength(1);
    expect(groupCartForSplit(checkoutB)).toHaveLength(1);
  });
});

describe('allocateAcrossGroups', () => {
  it('allocates the full amount to a single group', () => {
    expect(allocateAcrossGroups([500], 500, 50)).toEqual([50]);
  });

  it('sums exactly to the total across multiple groups, even with rounding-prone splits', () => {
    const amounts = [333.33, 333.33, 333.34];
    const subtotal = amounts.reduce((s, a) => s + a, 0);
    const allocations = allocateAcrossGroups(amounts, subtotal, 100);
    const sum = Math.round(allocations.reduce((s, a) => s + a, 0) * 100) / 100;
    expect(sum).toBe(100);
  });

  it('splits proportionally to each group\'s share of the subtotal', () => {
    const allocations = allocateAcrossGroups([100, 300], 400, 40);
    expect(allocations[0]).toBe(10);
    expect(allocations[1]).toBe(30);
  });

  it('returns all zeros when the total to allocate is zero', () => {
    expect(allocateAcrossGroups([100, 200], 300, 0)).toEqual([0, 0]);
  });

  it('returns an empty array for an empty group list', () => {
    expect(allocateAcrossGroups([], 0, 100)).toEqual([]);
  });
});

describe('deriveMasterProgress', () => {
  it('reports PENDING_PAYMENT for an empty child list', () => {
    expect(deriveMasterProgress([])).toBe('PENDING_PAYMENT');
  });

  it('reports PENDING_PAYMENT if any child is still unpaid', () => {
    expect(deriveMasterProgress(['CONFIRMED', 'PENDING_PAYMENT'])).toBe('PENDING_PAYMENT');
  });

  it('reports IN_PROGRESS when no child has reached a terminal state yet', () => {
    expect(deriveMasterProgress(['CONFIRMED', 'VENDOR_ASSIGNED'])).toBe('IN_PROGRESS');
  });

  it('reports COMPLETED when every active child is terminal', () => {
    expect(deriveMasterProgress(['COMPLETED', 'INVOICED'])).toBe('COMPLETED');
  });

  it('reports PARTIALLY_COMPLETED when some but not all active children are terminal', () => {
    expect(deriveMasterProgress(['COMPLETED', 'IN_PROGRESS'])).toBe('PARTIALLY_COMPLETED');
  });

  it('reports CANCELLED only when every child is cancelled/refunded', () => {
    expect(deriveMasterProgress(['CANCELLED', 'REFUNDED'])).toBe('CANCELLED');
  });

  it('ignores cancelled siblings when judging whether the rest are complete', () => {
    expect(deriveMasterProgress(['CANCELLED', 'COMPLETED'])).toBe('COMPLETED');
  });

  it('ignores cancelled siblings when the rest are still in progress', () => {
    expect(deriveMasterProgress(['CANCELLED', 'CONFIRMED'])).toBe('IN_PROGRESS');
  });
});

describe('resolveCheckoutPaymentOptions — Payment Mode business rules', () => {
  it('allows both Online and COD when every service is ANY (Online + COD)', () => {
    const opts = resolveCheckoutPaymentOptions([{ name: 'Tap Repair', paymentMode: 'ANY' }]);
    expect(opts).toEqual({ online: true, cod: true, onlineBlockedBy: null, codBlockedBy: null });
  });

  it('blocks COD when any service is ONLINE_ONLY, but leaves Online available', () => {
    const opts = resolveCheckoutPaymentOptions([
      { name: 'Tap Repair', paymentMode: 'ANY' },
      { name: 'Premium AC Install', paymentMode: 'ONLINE_ONLY' },
    ]);
    expect(opts.online).toBe(true);
    expect(opts.cod).toBe(false);
    expect(opts.codBlockedBy).toBe('Premium AC Install');
  });

  it('blocks Online when any service is COD_ONLY, but leaves COD available', () => {
    const opts = resolveCheckoutPaymentOptions([
      { name: 'Tap Repair', paymentMode: 'ANY' },
      { name: 'Cash-Only Handyman Visit', paymentMode: 'COD_ONLY' },
    ]);
    expect(opts.online).toBe(false);
    expect(opts.cod).toBe(true);
    expect(opts.onlineBlockedBy).toBe('Cash-Only Handyman Visit');
  });

  it('blocks BOTH methods when the cart mixes an ONLINE_ONLY and a COD_ONLY service — no method satisfies both', () => {
    const opts = resolveCheckoutPaymentOptions([
      { name: 'Premium AC Install', paymentMode: 'ONLINE_ONLY' },
      { name: 'Cash-Only Handyman Visit', paymentMode: 'COD_ONLY' },
    ]);
    expect(opts.online).toBe(false);
    expect(opts.cod).toBe(false);
  });

  it('allows both methods for an empty service list (product-only cart)', () => {
    expect(resolveCheckoutPaymentOptions([])).toEqual({ online: true, cod: true, onlineBlockedBy: null, codBlockedBy: null });
  });
});
