import { computeServicePricing, allocateDiscount, inNightWindow, vendorAllowedForOrder, resolveServicePricingParams, type FrozenPricingParams } from './pricing-engine';

const line = (over: Partial<FrozenPricingParams['lines'][0]> = {}) => ({
  serviceId: 's1', name: 'Fan installation', sac: '998719', ratePercent: 18, taxRule: 'tax-svc',
  commission: { amount: 20, ruleId: 'rule-20', label: 'Category 20%', base: 100 }, ...over,
});
const params = (over: Partial<FrozenPricingParams> = {}): FrozenPricingParams => ({
  engine: 1, model: 'MARKETPLACE', lines: [line()], platformFee: { sac: '999799', ratePercent: 18, taxRule: 'tax-fee' },
  partnerGstProfile: 'UNREGISTERED_ONLY', section95: false, partnerGstApplies: false, fees: [], resolvedAt: '2026-10-17T00:00:00Z', ...over,
});

describe('pricing engine — computeServicePricing', () => {
  it('brief example: ₹150 − ₹50 discount → 20% commission on ₹100 = ₹20, partner ₹80, GST ₹3.60 on the fee, customer ₹103.60', () => {
    const r = computeServicePricing(params(), { lineAmounts: [150], discount: 50 });
    expect([r.serviceAmount, r.discount, r.discounted, r.commission, r.partnerShare]).toEqual([150, 50, 100, 20, 80]);
    expect([r.platformFeeGst, r.partnerServiceGst, r.gstAmount, r.customerTotal]).toEqual([3.6, 0, 3.6, 103.6]);
    expect([r.remontRevenue, r.remontGstLiability, r.partnerPayable]).toEqual([20, 3.6, 80]);
    expect(r.components.map((c) => [c.code, c.supplier, c.taxable, c.gst])).toEqual([['PARTNER_SHARE', 'PARTNER', 80, 0], ['PLATFORM_FEE', 'REMONT', 20, 3.6]]);
  });

  it('GST-registered partner category: ₹80 + ₹14.40 + ₹20 + ₹3.60 = ₹118; the partner receives their GST', () => {
    const r = computeServicePricing(params({ partnerGstProfile: 'REGISTERED_ONLY', partnerGstApplies: true }), { lineAmounts: [100] });
    expect([r.customerTotal, r.partnerServiceGst, r.platformFeeGst, r.partnerPayable, r.remontGstLiability]).toEqual([118, 14.4, 3.6, 94.4, 3.6]);
  });

  it('Section 9(5): Remont owes the GST on the share and keeps it; the partner is paid ₹80', () => {
    const r = computeServicePricing(params({ section95: true, partnerGstApplies: true }), { lineAmounts: [100] });
    expect([r.customerTotal, r.partnerPayable, r.remontGstLiability, r.remontRevenue]).toEqual([118, 80, 18, 20]);
  });

  it('in-house: ₹100 + ₹18 = ₹118, all Remont revenue, no commission, no partner payable', () => {
    const r = computeServicePricing(params({ model: 'IN_HOUSE', partnerGstProfile: null, lines: [line({ commission: { amount: 0, ruleId: null, label: 'In-house', base: 100 } })] }), { lineAmounts: [100] });
    expect([r.customerTotal, r.gstAmount, r.commission, r.partnerPayable, r.remontRevenue, r.remontGstLiability]).toEqual([118, 18, 0, 0, 100, 18]);
  });

  it('named fees: a Remont fee is its own line with its own rate; a partner fee joins the partner\'s share', () => {
    const fees = [
      { ruleId: 'f1', name: 'EMERGENCY', displayName: 'Emergency service fee', beneficiary: 'REMONT' as const, amount: 50, sac: '999799', ratePercent: 18, taxRule: 'tax-fee' },
      { ruleId: 'f2', name: 'NIGHT', displayName: 'Night visit charge', beneficiary: 'PARTNER' as const, amount: 30, sac: '998719', ratePercent: 18, taxRule: 'tax-svc' },
    ];
    const r = computeServicePricing(params({ fees, partnerGstProfile: 'REGISTERED_ONLY', partnerGstApplies: true }), { lineAmounts: [100] });
    expect(r.components.find((c) => c.label === 'Emergency service fee')).toEqual(expect.objectContaining({ supplier: 'REMONT', taxable: 50, gst: 9 }));
    expect(r.components.find((c) => c.label === 'Night visit charge')).toEqual(expect.objectContaining({ supplier: 'PARTNER', taxable: 30, gst: 5.4 }));
    expect([r.feesTotal, r.partnerShare, r.remontRevenue]).toEqual([80, 110, 70]);
    expect(r.customerTotal).toBe(r2(80 + 14.4 + 30 + 5.4 + 20 + 3.6 + 50 + 9));
    // the same fee for an unregistered-partner category carries no GST on the partner's part
    expect(computeServicePricing(params({ fees: [fees[1]] }), { lineAmounts: [100] }).components.find((c) => c.code === 'FEE')!.gst).toBe(0);
  });

  it('extra work after booking reuses the frozen rates and commission (no new commission on it)', () => {
    const r = computeServicePricing(params({ partnerGstProfile: 'REGISTERED_ONLY', partnerGstApplies: true }), { lineAmounts: [100], extraWork: 50 });
    expect([r.commission, r.partnerShare, r.partnerServiceGst, r.customerTotal]).toEqual([20, 130, 23.4, r2(130 + 23.4 + 20 + 3.6)]);
  });

  it('commission never exceeds the discounted value; a fully discounted booking costs nothing', () => {
    const r = computeServicePricing(params(), { lineAmounts: [100], discount: 100 });
    expect([r.commission, r.customerTotal, r.components.length]).toEqual([0, 0, 0]);
  });

  it('several services in one booking: discount split by amount to the paisa, commission per line', () => {
    expect(allocateDiscount([100, 200], 10)).toEqual([3.33, 6.67]);
    const p = params({ lines: [line({ commission: { amount: 19.33, ruleId: 'r', label: '20%', base: 96.67 } }), line({ serviceId: 's2', name: 'Switch', commission: { amount: 38.67, ruleId: 'r', label: '20%', base: 193.33 } })] });
    const r = computeServicePricing(p, { lineAmounts: [100, 200], discount: 10 });
    expect([r.discounted, r.commission, r.partnerShare]).toEqual([290, 58, 232]);
  });
});

describe('pricing engine — conditions and eligibility', () => {
  it('night window in IST, wrapping midnight', () => {
    expect(inNightWindow('2026-10-17T22:30:00+05:30', 21, 6)).toBe(true);
    expect(inNightWindow('2026-10-17T05:30:00+05:30', 21, 6)).toBe(true);
    expect(inNightWindow('2026-10-17T10:00:00+05:30', 21, 6)).toBe(false);
    expect(inNightWindow(null, 21, 6)).toBe(false);
  });

  it('who may take a booking: model, then the partner GST profile', () => {
    const order = (model: string | null, profile?: string) => ({ serviceModel: model, pricingSnapshot: profile ? { params: { partnerGstProfile: profile } } : null });
    const reg = { staffType: 'PARTNER', gstin: '23ABCDE1234F1Z5' }, unreg = { staffType: 'PARTNER', gstin: null }, bad = { staffType: 'PARTNER', gstin: '23XYZ' }, tech = { staffType: 'IN_HOUSE', gstin: null };
    expect([reg, unreg, bad, tech].map((v) => vendorAllowedForOrder(order('MARKETPLACE', 'REGISTERED_ONLY'), v))).toEqual([true, false, false, false]);
    expect([reg, unreg, bad, tech].map((v) => vendorAllowedForOrder(order('MARKETPLACE', 'UNREGISTERED_ONLY'), v))).toEqual([false, true, true, false]);
    expect([reg, unreg, tech].map((v) => vendorAllowedForOrder(order('IN_HOUSE'), v))).toEqual([false, false, true]);
    expect([reg, unreg, tech].map((v) => vendorAllowedForOrder(order(null), v))).toEqual([true, true, true]); // legacy
  });
});

describe('pricing engine — resolveServicePricingParams (configuration)', () => {
  const svc = { id: 's1', name: 'Fan installation', categoryId: 'c1', hsnSac: '998719', gstOverridePercent: null };
  const mkPrisma = (taxRows: any[], rules: any[] = []) => ({
    taxConfig: { findMany: jest.fn(async (q: any) => taxRows.filter((r) => r.appliesTo.includes(q.where.appliesTo.has) && q.where.approvalStatus.in.includes(r.approvalStatus))) },
    commissionRule: { findMany: jest.fn(async (q: any) => rules.filter((r) => r.ruleType === q.where.ruleType)) },
    siteSetting: { findUnique: jest.fn(async () => null) },
  });
  const approved = (appliesTo: string, hsnCode: string, rate = 18, approvalStatus = 'APPROVED') => ({ id: `t-${appliesTo}-${hsnCode}`, rate, hsnCode, appliesTo: [appliesTo], approvalStatus, gstApplicable: true, productCategoryId: null });
  const commission20 = { id: 'r20', ruleType: 'COMMISSION', scope: 'CATEGORY', categoryId: 'c1', serviceId: null, cityId: null, commissionType: 'PERCENTAGE', value: 20, priority: 0, stackable: false };
  const marketplace = { serviceModel: 'PARTNER_MARKETPLACE', gstSection95Status: null, partnerGstProfile: 'UNREGISTERED_ONLY' };

  it('blocks (never guesses 18%) when no approved service or platform-fee GST rule exists', async () => {
    const res = await resolveServicePricingParams(mkPrisma([], [commission20]), { lines: [{ service: svc, amount: 100 }], category: marketplace });
    expect(res.problems.join(' | ')).toMatch(/no CA-approved GST rule for service "Fan installation" \(SAC 998719\).*platform fee/);
  });

  it('a rule pending CA approval is not used', async () => {
    const res = await resolveServicePricingParams(mkPrisma([approved('SERVICE', '998719', 18, 'PENDING_CA'), approved('PLATFORM_FEE', '999799')], [commission20]), { lines: [{ service: svc, amount: 100 }], category: marketplace });
    expect(res.problems).toEqual(['no CA-approved GST rule for service "Fan installation" (SAC 998719)']);
  });

  it('with approved rules: frozen rates, commission on the discounted value, rule IDs recorded', async () => {
    const res = await resolveServicePricingParams(mkPrisma([approved('SERVICE', '998719'), approved('PLATFORM_FEE', '999799')], [commission20]), { lines: [{ service: svc, amount: 150 }], category: marketplace, discount: 50 });
    expect(res.problems).toEqual([]);
    expect(res.params!.lines[0]).toEqual(expect.objectContaining({ ratePercent: 18, taxRule: 't-SERVICE-998719', commission: expect.objectContaining({ amount: 20, ruleId: 'r20', base: 100 }) }));
    expect(res.params!.platformFee).toEqual({ sac: '999799', ratePercent: 18, taxRule: 't-PLATFORM_FEE-999799' });
  });

  it('fees: condition, model and conflicts', async () => {
    const fee = (o: any) => ({ ruleType: 'ADDITIONAL_FEE', scope: 'CATEGORY', categoryId: 'c1', serviceId: null, cityId: null, commissionType: 'FLAT', priority: 0, feeAppliesTo: 'ALL', feeBeneficiary: 'REMONT', ...o });
    const taxes = [approved('SERVICE', '998719'), approved('PLATFORM_FEE', '999799')];
    const rules = [commission20, fee({ id: 'em', feeName: 'EMERGENCY', feeDisplayName: 'Emergency fee', feeCondition: 'EMERGENCY', value: 50 }), fee({ id: 'nt', feeName: 'NIGHT', feeDisplayName: 'Night fee', feeCondition: 'NIGHT', nightStartHour: 21, nightEndHour: 6, value: 40 })];
    const base = { lines: [{ service: svc, amount: 100 }], category: marketplace };
    const day = await resolveServicePricingParams(mkPrisma(taxes, rules), { ...base, slotStart: '2026-10-17T10:00:00+05:30' });
    expect(day.params!.fees).toEqual([]);
    const both = await resolveServicePricingParams(mkPrisma(taxes, rules), { ...base, slotStart: '2026-10-17T22:00:00+05:30', emergency: true });
    expect(both.params!.fees.map((f) => [f.name, f.amount, f.ratePercent])).toEqual([['EMERGENCY', 50, 18], ['NIGHT', 40, 18]]);
    const conflict = await resolveServicePricingParams(mkPrisma(taxes, [...rules, fee({ id: 'em2', feeName: 'emergency', feeDisplayName: 'Dup', feeCondition: 'EMERGENCY', value: 70 })]), { ...base, emergency: true });
    expect(conflict.problems.join(' ')).toMatch(/fee "EMERGENCY" has conflicting rules/);
    const inHouseOnly = await resolveServicePricingParams(mkPrisma(taxes, [commission20, fee({ id: 'ih', feeName: 'VISIT', feeDisplayName: 'Visit', feeAppliesTo: 'IN_HOUSE', value: 99 })]), base);
    expect(inHouseOnly.params!.fees).toEqual([]); // marketplace booking: an in-house-only fee never applies
  });

  it('a category without a service model keeps legacy pricing (no params, no problems)', async () => {
    expect(await resolveServicePricingParams(mkPrisma([]), { lines: [{ service: svc, amount: 100 }], category: null })).toEqual({ params: null, problems: [] });
  });
});

function r2(n: number) { return Math.round((n + Number.EPSILON) * 100) / 100; }
