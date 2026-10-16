import { BadRequestException } from '@nestjs/common';
import * as common from './index';
import { isValidGstinFormat } from './billing-engine';

// ═══════════════════════════════════════════════════════════════════════════
// Service pricing engine — the ONE calculation every service booking path uses (checkout, quote,
// guest and admin bookings, extra work, invoices, the admin preview). Two layers:
//   resolveServicePricingParams(): reads the admin rules (tax, commission, fees, category model)
//     and freezes what applies — rates, amounts, rule IDs. Missing, unapproved or conflicting
//     configuration is reported, never replaced by a guessed rate.
//   computeServicePricing(): pure arithmetic from the frozen parameters and the amounts.
// Both are stored on the booking (Order.pricingSnapshot); invoices and extra-work recalculations
// reuse them, so a rule changed after booking never alters a confirmed booking.
// A booking = one category (one partner visit), possibly several services of that category.
// Products never come here (their own GST/fee resolution is unchanged).
// ═══════════════════════════════════════════════════════════════════════════

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export class PricingConfigError extends BadRequestException {
  constructor(public readonly problems: string[]) {
    super(`This service can't be booked yet — ${problems.join('; ')}. An admin must complete the configuration (Admin › Finance & Configuration).`);
  }
}

export type PartnerGstProfile = 'UNREGISTERED_ONLY' | 'REGISTERED_ONLY';

export interface FrozenLine {
  serviceId: string; name: string; sac: string | null; ratePercent: number; taxRule: string | null;
  commission: { amount: number; ruleId: string | null; label: string; base: number };
}

export interface FrozenFee {
  ruleId: string; name: string; displayName: string; beneficiary: 'REMONT' | 'PARTNER';
  amount: number; sac: string | null; ratePercent: number; taxRule: string | null;
}

export interface FrozenPricingParams {
  engine: 1;
  model: 'IN_HOUSE' | 'MARKETPLACE';
  lines: FrozenLine[];
  platformFee: { sac: string; ratePercent: number; taxRule: string | null };
  partnerGstProfile: PartnerGstProfile | null;
  /** Remont pays the GST on the partner's share as e-commerce operator (unregistered partners only). */
  section95: boolean;
  /** GST is charged on the partner's share (registered-partner category, or 9(5)). */
  partnerGstApplies: boolean;
  fees: FrozenFee[];
  resolvedAt: string;
}

export interface PricingComponent {
  code: 'SERVICE' | 'PARTNER_SHARE' | 'EXTRA_WORK' | 'PLATFORM_FEE' | 'FEE';
  label: string;
  supplier: 'REMONT' | 'PARTNER';
  sac: string | null;
  taxable: number; ratePercent: number; gst: number;
  /** GST Remont owes (its own supply, or the partner's under 9(5)). */
  remontLiable: boolean;
  ruleId?: string | null;
}

export interface ServicePricingResult {
  components: PricingComponent[];
  serviceAmount: number; discount: number; discounted: number; extraWork: number;
  commission: number;
  partnerShare: number; partnerServiceGst: number;
  platformFeeGst: number; gstAmount: number; feesTotal: number;
  customerTotal: number;
  remontRevenue: number; remontGstLiability: number;
  partnerPayable: number;
}

export interface PricingAmounts { lineAmounts: number[]; discount?: number; extraWork?: number }

/** Splits a booking-level discount across its lines by amount (exact to the paisa). */
export function allocateDiscount(lineAmounts: number[], discount: number): number[] {
  const total = lineAmounts.reduce((s, a) => s + a, 0);
  const d = r2(Math.min(Math.max(0, discount || 0), total));
  if (!(total > 0) || !(d > 0)) return lineAmounts.map(() => 0);
  let given = 0;
  return lineAmounts.map((a, i) => {
    const share = i === lineAmounts.length - 1 ? r2(d - given) : r2((a / total) * d);
    given = r2(given + share);
    return share;
  });
}

/** Pure: the price of one service booking from its frozen parameters. */
export function computeServicePricing(p: FrozenPricingParams, a: PricingAmounts): ServicePricingResult {
  const amounts = p.lines.map((_, i) => r2(Number(a.lineAmounts[i]) || 0));
  const serviceAmount = r2(amounts.reduce((s, x) => s + x, 0));
  const shares = allocateDiscount(amounts, Number(a.discount) || 0);
  const discount = r2(shares.reduce((s, x) => s + x, 0));
  const discountedLines = amounts.map((x, i) => r2(x - shares[i]));
  const discounted = r2(serviceAmount - discount);
  const extraWork = r2(Number(a.extraWork) || 0);
  const components: PricingComponent[] = [];
  const push = (c: Omit<PricingComponent, 'gst'>) => {
    if (!(c.taxable > 0)) return;
    components.push({ ...c, taxable: r2(c.taxable), gst: r2((c.taxable * c.ratePercent) / 100) });
  };
  const first = p.lines[0];
  let commission = 0;
  if (p.model === 'MARKETPLACE') {
    // Commission on the discounted value (the discount is shared by Remont and the partner).
    const commissions = p.lines.map((l, i) => r2(Math.min(l.commission.amount, discountedLines[i])));
    commission = r2(commissions.reduce((s, x) => s + x, 0));
    const partner = (rate: number) => ({ supplier: 'PARTNER' as const, ratePercent: p.partnerGstApplies ? rate : 0, remontLiable: p.section95 });
    p.lines.forEach((l, i) => push({ code: 'PARTNER_SHARE', label: l.name, sac: l.sac, taxable: discountedLines[i] - commissions[i], ...partner(l.ratePercent), ruleId: l.commission.ruleId }));
    push({ code: 'EXTRA_WORK', label: 'Additional work', sac: first?.sac ?? null, taxable: extraWork, ...partner(first?.ratePercent ?? 0) });
    for (const f of p.fees.filter((x) => x.beneficiary === 'PARTNER')) push({ code: 'FEE', label: f.displayName, sac: first?.sac ?? null, taxable: f.amount, ...partner(first?.ratePercent ?? 0), ruleId: f.ruleId });
    push({ code: 'PLATFORM_FEE', label: 'Remont Platform Fee', sac: p.platformFee.sac, taxable: commission, supplier: 'REMONT', ratePercent: p.platformFee.ratePercent, remontLiable: true, ruleId: first?.commission.ruleId ?? null });
    for (const f of p.fees.filter((x) => x.beneficiary === 'REMONT')) push({ code: 'FEE', label: f.displayName, sac: f.sac, taxable: f.amount, supplier: 'REMONT', ratePercent: f.ratePercent, remontLiable: true, ruleId: f.ruleId });
  } else {
    // In-house: every component is Remont's own supply.
    p.lines.forEach((l, i) => push({ code: 'SERVICE', label: l.name, sac: l.sac, taxable: discountedLines[i], supplier: 'REMONT', ratePercent: l.ratePercent, remontLiable: true }));
    push({ code: 'EXTRA_WORK', label: 'Additional work', sac: first?.sac ?? null, taxable: extraWork, supplier: 'REMONT', ratePercent: first?.ratePercent ?? 0, remontLiable: true });
    for (const f of p.fees) push({ code: 'FEE', label: f.displayName, sac: f.sac, taxable: f.amount, supplier: 'REMONT', ratePercent: f.ratePercent, remontLiable: true, ruleId: f.ruleId });
  }
  const sum = (xs: PricingComponent[], k: 'taxable' | 'gst') => r2(xs.reduce((s, c) => s + c[k], 0));
  const partnerLines = components.filter((c) => c.supplier === 'PARTNER');
  const remontLines = components.filter((c) => c.supplier === 'REMONT');
  const partnerShare = sum(partnerLines, 'taxable');
  const partnerServiceGst = sum(partnerLines, 'gst');
  const gstAmount = sum(components, 'gst');
  return {
    components, serviceAmount, discount, discounted, extraWork, commission,
    partnerShare, partnerServiceGst,
    platformFeeGst: p.model === 'MARKETPLACE' ? sum(remontLines, 'gst') : 0,
    gstAmount,
    feesTotal: r2(p.fees.reduce((s, f) => s + f.amount, 0)),
    customerTotal: r2(sum(components, 'taxable') + gstAmount),
    remontRevenue: sum(remontLines, 'taxable'),
    remontGstLiability: r2(components.filter((c) => c.remontLiable).reduce((s, c) => s + c.gst, 0)),
    // A registered partner receives the GST on their share (theirs to remit); under 9(5) Remont keeps it.
    partnerPayable: r2(partnerShare + (p.section95 ? 0 : partnerServiceGst)),
  };
}

/** Night window in IST, wrapping midnight (21→6 means 21:00–05:59). */
export function inNightWindow(slotStart: Date | string | null | undefined, start?: number | null, end?: number | null): boolean {
  if (!slotStart || start == null || end == null) return false;
  const istHour = new Date(new Date(slotStart).getTime() + 330 * 60_000).getUTCHours();
  return start <= end ? istHour >= start && istHour < end : istHour >= start || istHour < end;
}

/**
 * The applicable named fees for one booking. One fee per name: service-level beats category-level,
 * city-specific beats all-city, then priority; an exact tie is a conflict (reported, never guessed).
 */
export async function resolveAdditionalFees(
  prisma: any,
  i: { serviceIds: string[]; categoryId: string; cityId?: string | null; model: 'IN_HOUSE' | 'MARKETPLACE'; base: number; slotStart?: Date | string | null; emergency?: boolean },
): Promise<{ fees: Omit<FrozenFee, 'ratePercent' | 'taxRule'>[]; problems: string[] }> {
  const now = new Date();
  const rows: any[] = await prisma.commissionRule.findMany({
    where: {
      isActive: true, ruleType: 'ADDITIONAL_FEE',
      OR: [{ serviceId: { in: i.serviceIds } }, { categoryId: i.categoryId, serviceId: null }],
      AND: [
        i.cityId ? { OR: [{ cityId: null }, { cityId: i.cityId }] } : { cityId: null },
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validTo: null }, { validTo: { gte: now } }] },
      ],
    },
  });
  const problems: string[] = [];
  const byName = new Map<string, any[]>();
  for (const r of rows) {
    if (r.cityId && r.cityId !== i.cityId) continue;
    const key = String(r.feeName || '').trim().toUpperCase();
    if (!key) { problems.push(`fee rule ${r.id} has no name`); continue; }
    byName.set(key, [...(byName.get(key) || []), r]);
  }
  const score = (r: any) => (r.serviceId ? 1000 : 0) + (r.cityId ? 100 : 0) + (r.priority || 0);
  const fees: Omit<FrozenFee, 'ratePercent' | 'taxRule'>[] = [];
  for (const [name, group] of byName) {
    group.sort((a, b) => score(b) - score(a));
    if (group.length > 1 && score(group[0]) === score(group[1])) {
      problems.push(`fee "${name}" has conflicting rules at the same level and priority (${group[0].id}, ${group[1].id})`);
      continue;
    }
    const r = group[0];
    const appliesTo = r.feeAppliesTo || 'ALL';
    if (appliesTo !== 'ALL' && appliesTo !== i.model) continue;
    const cond = r.feeCondition || 'ALWAYS';
    if (!['ALWAYS', 'NIGHT', 'EMERGENCY'].includes(cond)) { problems.push(`fee "${name}" has an unknown condition ${cond}`); continue; }
    if (cond === 'NIGHT' && !inNightWindow(i.slotStart, r.nightStartHour, r.nightEndHour)) continue;
    if (cond === 'EMERGENCY' && !i.emergency) continue;
    const amount = r2(common.computeRuleAmount(r, i.base));
    if (!(amount > 0)) continue;
    fees.push({
      ruleId: r.id, name, displayName: r.feeDisplayName || name,
      beneficiary: i.model === 'MARKETPLACE' && r.feeBeneficiary === 'PARTNER' ? 'PARTNER' : 'REMONT',
      amount, sac: r.feeSac || null,
    });
  }
  return { fees, problems };
}

export interface PricingInput {
  lines: { service: { id: string; name?: string | null; categoryId: string; hsnSac?: string | null; gstOverridePercent?: any }; amount: number }[];
  category: { serviceModel?: string | null; gstSection95Status?: string | null; partnerGstProfile?: string | null } | null | undefined;
  cityId?: string | null; discount?: number; slotStart?: Date | string | null; emergency?: boolean;
}

/**
 * Freezes the rules that price one service booking. params = null for a category without a service
 * model (legacy pricing). Every problem is collected (the preview shows them all); checkout throws.
 */
export async function resolveServicePricingParams(prisma: any, i: PricingInput): Promise<{ params: FrozenPricingParams | null; problems: string[] }> {
  const model = common.orderServiceModelFor(i.category?.serviceModel);
  if (!model || !i.lines.length) return { params: null, problems: [] };
  const problems: string[] = [];
  const svcTax = await common.buildTaxRateResolver(prisma, 'SERVICE');
  const feeTax = await common.buildTaxRateResolver(prisma, 'PLATFORM_FEE');
  const feeSac = feeTax.defaultHsn || common.PLATFORM_FEE_DEFAULT_SAC;
  const amounts = i.lines.map((l) => r2(Number(l.amount) || 0));
  const shares = allocateDiscount(amounts, i.discount || 0);
  const discountedTotal = r2(amounts.reduce((s, a, k) => s + a - shares[k], 0));

  const lines: FrozenLine[] = [];
  for (const [k, l] of i.lines.entries()) {
    const name = l.service.name || 'Service';
    const sac = l.service.hsnSac || null;
    if (!svcTax.hasConfiguredRate?.(sac, l.service.gstOverridePercent)) {
      problems.push(`no CA-approved GST rule for service "${name}"${sac ? ` (SAC ${sac})` : ' (the service has no SAC)'}`);
    }
    const discounted = r2(amounts[k] - shares[k]);
    let commission = { amount: 0, ruleId: null as string | null, label: 'In-house — no commission', base: discounted };
    if (model === 'MARKETPLACE') {
      const c = await common.resolveCommission(prisma, { serviceId: l.service.id, categoryId: l.service.categoryId, cityId: i.cityId, amount: discounted });
      commission = { amount: r2(c.commissionAmount), ruleId: c.ruleId, label: c.ruleLabel, base: discounted };
    }
    lines.push({
      serviceId: l.service.id, name, sac,
      ratePercent: svcTax.rateFor(sac, l.service.gstOverridePercent),
      taxRule: svcTax.sourceFor?.(sac, l.service.gstOverridePercent) ?? null,
      commission,
    });
  }

  let partnerGstProfile: PartnerGstProfile | null = null;
  let section95 = false;
  let partnerGstApplies = false;
  if (model === 'MARKETPLACE') {
    if (lines.some((l) => l.commission.amount > 0) && !feeTax.hasConfiguredRate?.(feeSac)) problems.push(`no CA-approved GST rule for the Remont platform fee (SAC ${feeSac})`);
    partnerGstProfile = i.category?.partnerGstProfile === 'REGISTERED_ONLY' ? 'REGISTERED_ONLY' : 'UNREGISTERED_ONLY';
    section95 = partnerGstProfile === 'UNREGISTERED_ONLY' && i.category?.gstSection95Status === 'APPLICABLE';
    partnerGstApplies = partnerGstProfile === 'REGISTERED_ONLY' || section95;
  }
  const feeRes = await resolveAdditionalFees(prisma, {
    serviceIds: i.lines.map((l) => l.service.id), categoryId: i.lines[0].service.categoryId, cityId: i.cityId, model,
    base: discountedTotal, slotStart: i.slotStart, emergency: i.emergency,
  });
  problems.push(...feeRes.problems);
  const fees: FrozenFee[] = feeRes.fees.map((f) => {
    if (f.beneficiary === 'PARTNER') return { ...f, sac: lines[0].sac, ratePercent: partnerGstApplies ? lines[0].ratePercent : 0, taxRule: lines[0].taxRule };
    if (model === 'IN_HOUSE' && !f.sac) return { ...f, sac: lines[0].sac, ratePercent: lines[0].ratePercent, taxRule: lines[0].taxRule }; // part of Remont's own service
    const fsac = f.sac || feeSac;
    if (!feeTax.hasConfiguredRate?.(fsac)) problems.push(`no CA-approved GST rule for fee "${f.displayName}" (SAC ${fsac})`);
    return { ...f, sac: fsac, ratePercent: feeTax.rateFor(fsac, null), taxRule: feeTax.sourceFor?.(fsac, null) ?? null };
  });
  const params: FrozenPricingParams = {
    engine: 1, model, lines,
    platformFee: { sac: feeSac, ratePercent: feeTax.rateFor(feeSac, null), taxRule: feeTax.sourceFor?.(feeSac, null) ?? null },
    partnerGstProfile, section95, partnerGstApplies, fees,
    resolvedAt: new Date().toISOString(),
  };
  return { params, problems };
}

/** What gets stored on the booking (Order.pricingSnapshot). */
export function pricingSnapshot(params: FrozenPricingParams, amounts: PricingAmounts) {
  const a = { lineAmounts: amounts.lineAmounts.map((x) => r2(Number(x) || 0)), discount: r2(amounts.discount || 0), extraWork: r2(amounts.extraWork || 0) };
  return { params, amounts: a, result: computeServicePricing(params, a), computedAt: new Date().toISOString() };
}

/**
 * Prices one booking for checkout: the snapshot to store, or null for legacy pricing. Missing,
 * unapproved or conflicting configuration blocks the booking (PricingConfigError lists it all).
 */
export async function priceServiceBookingSnapshot(prisma: any, i: PricingInput) {
  const { params, problems } = await resolveServicePricingParams(prisma, i);
  if (problems.length) throw new PricingConfigError(problems);
  if (!params) return null;
  return pricingSnapshot(params, { lineAmounts: i.lines.map((l) => l.amount), discount: i.discount });
}

/** Order columns derived from a snapshot (kept in sync with it everywhere it is written). */
export function orderFieldsFromSnapshot(snap: ReturnType<typeof pricingSnapshot>) {
  const res = snap.result;
  return {
    serviceModel: snap.params.model,
    gstAmount: res.gstAmount, platformFeeGst: res.platformFeeGst, partnerServiceGst: res.partnerServiceGst,
    remontCommission: res.commission, vendorPayout: res.partnerShare,
    pricingSnapshot: snap as any,
  };
}

/**
 * Who may take a booking: in-house jobs only Remont's technicians; marketplace jobs only external
 * partners whose GST registration matches the category's partner GST profile (frozen at checkout).
 * Bookings without a model (legacy): anyone, as before.
 */
export function vendorAllowedForOrder(
  order: { serviceModel?: string | null; pricingSnapshot?: any },
  vendor: { staffType?: string | null; gstin?: string | null },
): boolean {
  if (!common.staffAllowedForModel(order.serviceModel, vendor.staffType)) return false;
  if (order.serviceModel !== 'MARKETPLACE') return true;
  const profile = order.pricingSnapshot?.params?.partnerGstProfile;
  if (!profile) return true;
  const registered = !!vendor.gstin && isValidGstinFormat(String(vendor.gstin));
  return profile === 'REGISTERED_ONLY' ? registered : !registered;
}
