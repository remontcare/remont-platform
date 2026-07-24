import { groupCartForSplit, allocateAcrossGroups, deriveMasterProgress, SplitCartItem } from './master-orders.module';

describe('groupCartForSplit', () => {
  it('gives a single service its own group', () => {
    const items: SplitCartItem[] = [{ type: 'SERVICE', serviceId: 'svc-1', quantity: 1 }];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ type: 'SERVICE', serviceId: 'svc-1', quantity: 1 });
  });

  it('gives each distinct service its own group — the fix for the old "combined-price, first-service-only" bug', () => {
    const items: SplitCartItem[] = [
      { type: 'SERVICE', serviceId: 'tap-repair', quantity: 1 },
      { type: 'SERVICE', serviceId: 'angle-valve', quantity: 1 },
    ];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(2);
    const serviceIds = groups.map((g: any) => g.serviceId).sort();
    expect(serviceIds).toEqual(['angle-valve', 'tap-repair']);
  });

  it('merges duplicate entries of the same service by summing quantity', () => {
    const items: SplitCartItem[] = [
      { type: 'SERVICE', serviceId: 'svc-1', quantity: 1 },
      { type: 'SERVICE', serviceId: 'svc-1', quantity: 2 },
    ];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(1);
    expect((groups[0] as any).quantity).toBe(3);
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
      { type: 'SERVICE', serviceId: 'plumbing-1', quantity: 1 },
      { type: 'SERVICE', serviceId: 'electrical-1', quantity: 1 },
      { type: 'PRODUCT', productId: 'p1', vendorId: 'seller-a', quantity: 1 },
      { type: 'PRODUCT', productId: 'p2', vendorId: 'seller-b', quantity: 1 },
    ];
    const groups = groupCartForSplit(items);
    expect(groups).toHaveLength(4);
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
