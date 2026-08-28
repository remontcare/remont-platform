import { SupportPolicyEngine } from './support.module';

function makePrisma(overrides: Record<string, string> = {}) {
  return {
    siteSetting: {
      findUnique: jest.fn(async ({ where: { key } }: any) =>
        overrides[key] !== undefined ? { key, value: overrides[key] } : null),
    },
  } as any;
}

const baseOrder = { status: 'CONFIRMED', vendorId: null, dispatchAttempts: 0, createdAt: new Date(), completedAt: null };
const noWarranty = { days: 0, percent: 0 };

describe('SupportPolicyEngine.getPolicyConfig', () => {
  it('falls back to hardcoded defaults when no SiteSetting rows exist', async () => {
    const engine = new SupportPolicyEngine(makePrisma());
    const cfg = await engine.getPolicyConfig();
    expect(cfg).toEqual({ visitCharge: 200, diagnosisCharge: 150, slaMin: 60, returnWindowDays: 7 });
  });

  it('admin-configured SiteSetting values override the defaults', async () => {
    const engine = new SupportPolicyEngine(makePrisma({ support_visit_charge: '350' }));
    const cfg = await engine.getPolicyConfig();
    expect(cfg.visitCharge).toBe(350);
  });
});

describe('SupportPolicyEngine.deriveServiceStage', () => {
  const engine = new SupportPolicyEngine(makePrisma());
  it.each([
    [{ status: 'CONFIRMED', vendorId: null }, 'NOT_ASSIGNED'],
    [{ status: 'VENDOR_ASSIGNED', vendorId: 'v1' }, 'ASSIGNED'],
    [{ status: 'VENDOR_EN_ROUTE', vendorId: 'v1' }, 'EN_ROUTE'],
    [{ status: 'STARTED', vendorId: 'v1' }, 'STARTED'],
    [{ status: 'IN_PROGRESS', vendorId: 'v1' }, 'STARTED'],
    [{ status: 'COMPLETED', vendorId: 'v1' }, 'COMPLETED'],
    [{ status: 'CANCELLED', vendorId: 'v1' }, 'CLOSED'],
    [{ status: 'CANCELLED', vendorId: null }, 'CLOSED'],
  ] as const)('%j -> %s', (order, stage) => {
    expect(engine.deriveServiceStage(order)).toBe(stage);
  });

  // Phase 6 fix: a PRODUCT order's Order.vendorId is ALWAYS null (product attribution is
  // OrderItem.vendorId, never Order.vendorId) — before the fix, every one of these fell into
  // the same "NOT_ASSIGNED" bucket as CONFIRMED above, forever, regardless of real delivery
  // state. These pin down the new product-aware branch.
  it.each([
    [{ status: 'CONFIRMED', vendorId: null, type: 'PRODUCT', productFulfillmentStage: null }, 'NOT_ASSIGNED'],
    [{ status: 'CONFIRMED', vendorId: null, type: 'PRODUCT', productFulfillmentStage: 'AWAITING_SELLER' }, 'NOT_ASSIGNED'],
    [{ status: 'CONFIRMED', vendorId: null, type: 'PRODUCT', productFulfillmentStage: 'SELLER_ACCEPTED' }, 'ASSIGNED'],
    [{ status: 'CONFIRMED', vendorId: null, type: 'PRODUCT', productFulfillmentStage: 'PROCESSING' }, 'ASSIGNED'],
    [{ status: 'CONFIRMED', vendorId: null, type: 'PRODUCT', productFulfillmentStage: 'READY_FOR_PICKUP' }, 'EN_ROUTE'],
    [{ status: 'CONFIRMED', vendorId: null, type: 'PRODUCT', productFulfillmentStage: 'HANDED_TO_LOGISTICS' }, 'EN_ROUTE'],
    [{ status: 'CONFIRMED', vendorId: null, type: 'PRODUCT', productFulfillmentStage: 'SELLER_REJECTED' }, 'CLOSED'],
    // The critical fix: a delivered product order now correctly reaches COMPLETED, unlocking
    // RETURN_PRODUCT/WARRANTY_CLAIM in getIssueOptions() — pre-fix this was unreachable.
    [{ status: 'COMPLETED', vendorId: null, type: 'PRODUCT', productFulfillmentStage: 'HANDED_TO_LOGISTICS' }, 'COMPLETED'],
    [{ status: 'CANCELLED', vendorId: null, type: 'PRODUCT', productFulfillmentStage: 'AWAITING_SELLER' }, 'CLOSED'],
  ] as const)('%j -> %s', (order, stage) => {
    expect(engine.deriveServiceStage(order)).toBe(stage);
  });
});

describe('SupportPolicyEngine.getIssueOptions — Phase 6 product policy gating', () => {
  const engine = new SupportPolicyEngine(makePrisma());

  it('offers RETURN_PRODUCT and WARRANTY_CLAIM for a completed, returnable, warrantied product', () => {
    const opts = engine.getIssueOptions('PRODUCT', 'COMPLETED', { returnable: true, replaceable: true, warrantyAvailable: true });
    expect(opts).toContain('RETURN_PRODUCT');
    expect(opts).toContain('WARRANTY_CLAIM');
  });

  it('hides RETURN_PRODUCT for a non-returnable product, and hides WARRANTY_CLAIM when unavailable', () => {
    const opts = engine.getIssueOptions('PRODUCT', 'COMPLETED', { returnable: false, replaceable: false, warrantyAvailable: false });
    expect(opts).not.toContain('RETURN_PRODUCT');
    expect(opts).not.toContain('WARRANTY_CLAIM');
  });

  it('defaults to returnable when no productPolicy is passed (backward compatible)', () => {
    const opts = engine.getIssueOptions('PRODUCT', 'COMPLETED');
    expect(opts).toContain('RETURN_PRODUCT');
  });
});

describe('SupportPolicyEngine.recommend — product flows', () => {
  const engine = new SupportPolicyEngine(makePrisma());
  const policy = { visitCharge: 200, diagnosisCharge: 150, slaMin: 60, returnWindowDays: 7 };

  // Phase 5 — was an instant FULL_REFUND before real return-pickup logistics existed. Now
  // schedules a physical pickup instead; the refund only fires once the seller's inspection
  // accepts the returned item (see ReturnsService.finalize()).
  it('WRONG_PRODUCT within the return window auto-resolves a return pickup (not an instant refund)', () => {
    const rec = engine.recommend({
      itemType: 'PRODUCT', issueType: 'WRONG_PRODUCT',
      order: { ...baseOrder, createdAt: new Date(Date.now() - 2 * 86_400_000) },
      amountBasis: 999, policy, warranty: noWarranty,
    });
    expect(rec).toMatchObject({ routeType: 'AUTO_RESOLUTION', resolutionType: 'RETURN_PICKUP_INITIATED', amount: 999 });
  });

  it('DAMAGED_PRODUCT past the return window routes to a support case with no auto refund', () => {
    const rec = engine.recommend({
      itemType: 'PRODUCT', issueType: 'DAMAGED_PRODUCT',
      order: { ...baseOrder, createdAt: new Date(Date.now() - 30 * 86_400_000) },
      amountBasis: 999, policy, warranty: noWarranty,
    });
    expect(rec.routeType).toBe('SUPPORT_CASE');
    expect(rec.resolutionType).toBe('NO_REFUND');
  });

  it('CANCEL_PRODUCT before shipment (still CONFIRMED) auto-resolves a full refund', () => {
    const rec = engine.recommend({
      itemType: 'PRODUCT', issueType: 'CANCEL_PRODUCT',
      order: { ...baseOrder, status: 'CONFIRMED' },
      amountBasis: 500, policy, warranty: noWarranty,
    });
    expect(rec).toMatchObject({ routeType: 'AUTO_RESOLUTION', resolutionType: 'FULL_REFUND', amount: 500 });
  });

  it('CANCEL_PRODUCT once already in progress does not auto-resolve', () => {
    const rec = engine.recommend({
      itemType: 'PRODUCT', issueType: 'CANCEL_PRODUCT',
      order: { ...baseOrder, status: 'IN_PROGRESS' },
      amountBasis: 500, policy, warranty: noWarranty,
    });
    expect(rec.routeType).toBe('SUPPORT_CASE');
    expect(rec.resolutionType).toBeNull();
  });

  it('DELIVERED_LATE never auto-resolves — no promised-delivery-date field exists to quantify it', () => {
    const rec = engine.recommend({
      itemType: 'PRODUCT', issueType: 'DELIVERED_LATE',
      order: baseOrder, amountBasis: 500, policy, warranty: noWarranty,
    });
    expect(rec.routeType).toBe('SUPPORT_CASE');
    expect(rec.resolutionType).toBeNull();
  });

  // Phase 6 — a non-returnable, non-replaceable product must never auto-resolve into a
  // physical pickup, even within the return window.
  it('WRONG_PRODUCT is blocked for a non-returnable, non-replaceable product', () => {
    const rec = engine.recommend({
      itemType: 'PRODUCT', issueType: 'WRONG_PRODUCT',
      order: { ...baseOrder, createdAt: new Date(Date.now() - 2 * 86_400_000) },
      amountBasis: 999, policy, warranty: noWarranty,
      productPolicy: { returnable: false, replaceable: false, warrantyAvailable: false },
    });
    expect(rec.routeType).toBe('SUPPORT_CASE');
    expect(rec.resolutionType).not.toBe('RETURN_PICKUP_INITIATED');
  });

  it('RETURN_PRODUCT points the customer at Warranty when return/replacement are disabled but warranty is available', () => {
    const rec = engine.recommend({
      itemType: 'PRODUCT', issueType: 'RETURN_PRODUCT',
      order: { ...baseOrder, createdAt: new Date(Date.now() - 2 * 86_400_000) },
      amountBasis: 999, policy, warranty: noWarranty,
      productPolicy: { returnable: false, replaceable: false, warrantyAvailable: true },
    });
    expect(rec.reasonForCustomer).toMatch(/warranty/i);
  });

  it('WARRANTY_CLAIM auto-resolves by opening a warranty case, never moving money directly', () => {
    const rec = engine.recommend({
      itemType: 'PRODUCT', issueType: 'WARRANTY_CLAIM',
      order: baseOrder, amountBasis: 999, policy, warranty: noWarranty,
      productPolicy: { returnable: true, replaceable: true, warrantyAvailable: true },
    });
    expect(rec).toMatchObject({ routeType: 'AUTO_RESOLUTION', resolutionType: 'WARRANTY_CLAIM_OPENED', amount: null });
  });
});

describe('SupportPolicyEngine.recommend — service flows', () => {
  const engine = new SupportPolicyEngine(makePrisma());
  const policy = { visitCharge: 200, diagnosisCharge: 150, slaMin: 60, returnWindowDays: 7 };

  it('PARTNER_NOT_ASSIGNED within the SLA window is informational only, no refund', () => {
    const rec = engine.recommend({
      itemType: 'SERVICE', issueType: 'PARTNER_NOT_ASSIGNED',
      order: { ...baseOrder, createdAt: new Date(), dispatchAttempts: 0 },
      amountBasis: 1500, policy, warranty: noWarranty,
    });
    expect(rec).toMatchObject({ routeType: 'AUTO_RESOLUTION', resolutionType: 'NO_REFUND', amount: null });
  });

  it('PARTNER_NOT_ASSIGNED past the SLA window routes to a support case recommending a full refund', () => {
    const rec = engine.recommend({
      itemType: 'SERVICE', issueType: 'PARTNER_NOT_ASSIGNED',
      order: { ...baseOrder, createdAt: new Date(Date.now() - 90 * 60_000), dispatchAttempts: 1 },
      amountBasis: 1500, policy, warranty: noWarranty,
    });
    expect(rec).toMatchObject({ routeType: 'SUPPORT_CASE', resolutionType: 'FULL_REFUND', amount: 1500 });
  });

  it('PARTNER_ON_THE_WAY cancellation deducts exactly the visit charge (worked example from the spec)', () => {
    const rec = engine.recommend({
      itemType: 'SERVICE', issueType: 'PARTNER_ON_THE_WAY',
      order: baseOrder, amountBasis: 1500, policy, warranty: noWarranty,
    });
    expect(rec).toMatchObject({ routeType: 'AUTO_RESOLUTION', resolutionType: 'REFUND_MINUS_VISIT', amount: 1300 });
  });

  it('PARTNER_ARRIVED cancellation deducts both visit and diagnosis charges', () => {
    const rec = engine.recommend({
      itemType: 'SERVICE', issueType: 'PARTNER_ARRIVED',
      order: baseOrder, amountBasis: 1500, policy, warranty: noWarranty,
    });
    expect(rec).toMatchObject({ routeType: 'AUTO_RESOLUTION', resolutionType: 'REFUND_MINUS_DIAGNOSIS', amount: 1150 });
  });

  it('a refund never goes negative even if charges exceed the service amount', () => {
    const rec = engine.recommend({
      itemType: 'SERVICE', issueType: 'PARTNER_ARRIVED',
      order: baseOrder, amountBasis: 100, policy, warranty: noWarranty,
    });
    expect(rec.amount).toBe(0);
  });

  it('PARTNER_DID_NOT_ARRIVE always routes to a support case — no GPS-arrival evidence to auto-decide from', () => {
    const rec = engine.recommend({
      itemType: 'SERVICE', issueType: 'PARTNER_DID_NOT_ARRIVE',
      order: baseOrder, amountBasis: 1500, policy, warranty: noWarranty,
    });
    expect(rec.routeType).toBe('SUPPORT_CASE');
  });

  it('SERVICE_COMPLETED_ISSUE_NOT_FIXED within the warranty window routes to a dispute recommending free rework, never an automatic refund', () => {
    const rec = engine.recommend({
      itemType: 'SERVICE', issueType: 'SERVICE_COMPLETED_ISSUE_NOT_FIXED',
      order: { ...baseOrder, status: 'COMPLETED', completedAt: new Date(Date.now() - 2 * 86_400_000) },
      amountBasis: 1500, policy, warranty: { days: 7, percent: 15 },
    });
    expect(rec).toMatchObject({ routeType: 'DISPUTE', resolutionType: 'FREE_REWORK' });
  });

  it('SERVICE_COMPLETED_ISSUE_NOT_FIXED past the warranty window requires a new paid service, not a refund', () => {
    const rec = engine.recommend({
      itemType: 'SERVICE', issueType: 'SERVICE_COMPLETED_ISSUE_NOT_FIXED',
      order: { ...baseOrder, status: 'COMPLETED', completedAt: new Date(Date.now() - 30 * 86_400_000) },
      amountBasis: 1500, policy, warranty: { days: 7, percent: 15 },
    });
    expect(rec).toMatchObject({ routeType: 'SUPPORT_CASE', resolutionType: 'NEW_SERVICE_REQUIRED' });
  });
});
