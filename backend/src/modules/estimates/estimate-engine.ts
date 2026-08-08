/**
 * ESTIMATE ENGINE — Remont India
 * Reusable pricing/estimate calculator for Interior, Renovation, Architecture,
 * and any future service category. All money math lives HERE, server-side —
 * no client is ever trusted to compute a price.
 *
 * Split in two layers, same convention as resolveCommission() in
 * ../../common/index.ts:
 *   1. Pure functions (computePrice, determineEligibility) — zero I/O, fully
 *      unit-testable with plain objects, no mocking required.
 *   2. generateEstimate() — the orchestration layer, takes `prisma: any` (and
 *      a CitiesService-shaped object) exactly like resolveCommission does, so
 *      it's testable the same way (mock prisma + mock citiesService), and
 *      requires no live database connection to verify.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ServiceDeliveryType = 'DIGITAL' | 'ONSITE' | 'HYBRID';
export type PricingType = 'FIXED' | 'STARTING_FROM' | 'QUOTATION' | 'PER_SQFT';

export interface ModifierSelection {
  group: string;
  label: string;
}

export interface PriceComputationInput {
  pricingType: PricingType;
  resolvedBasePrice: number; // offerPrice ?? basePrice, already city-multiplier-adjusted
  materialCost: number;
  labourCost: number;
  perSqftRate: number; // already city-multiplier-adjusted
  sqft?: number;
  modifierMultipliers: number[]; // compounded (multiplied together) onto the work cost
  consultationFee: number;
  siteVisitFee: number;
  gstPercent: number;
  startingFromSpreadPercent: number; // e.g. 25 => high = low * 1.25, for STARTING_FROM only
}

export interface PriceComputationResult {
  workCostLow: number | null;
  workCostHigh: number | null;
  materialCost: number;
  labourCost: number;
  consultationFee: number;
  siteVisitFee: number;
  modifierMultiplierApplied: number;
  gstPercent: number;
  gstAmount: number;
  finalPayableAmount: number;
  requiresQuotation: boolean;
}

export interface EligibilityInput {
  serviceType: ServiceDeliveryType;
  cityProvided: boolean;
  cityFound: boolean;
  cityIsActive: boolean;
  // null = no city-specific override row exists for this service (defaults to
  // available, same "no data yet — don't block" convention used elsewhere in
  // this codebase, e.g. index.html's _cityAvailabilityReason).
  cityServiceOverrideActive: boolean | null;
  activeVendorCount: number;
}

export interface EligibilityResult {
  eligible: boolean;
  reason:
    | 'DIGITAL_NO_RESTRICTION'
    | 'CITY_REQUIRED'
    | 'OK'
    | 'CITY_NOT_SERVICEABLE';
  message: string | null;
}

// The exact, required response copy for a not-yet-serviceable onsite request —
// requirement #8. Never used to block the customer; the estimate is still returned.
export const CITY_NOT_SERVICEABLE_MESSAGE = 'Estimate Available, Execution Not Available Yet.';

// ─── Pure: price computation ────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computePrice(input: PriceComputationInput): PriceComputationResult {
  const consultationFee = Number(input.consultationFee) || 0;
  const siteVisitFee = Number(input.siteVisitFee) || 0;
  const gstPercent = Number(input.gstPercent) || 0;
  const modifierMultiplierApplied = input.modifierMultipliers.length
    ? input.modifierMultipliers.reduce((acc, m) => acc * (Number(m) || 1), 1)
    : 1;

  if (input.pricingType === 'QUOTATION') {
    // No computed work cost — only the upfront fees (if any) are known today;
    // the actual project cost is confirmed after consultation/site visit.
    const gstAmount = round2(((consultationFee + siteVisitFee) * gstPercent) / 100);
    return {
      workCostLow: null,
      workCostHigh: null,
      materialCost: round2(Number(input.materialCost) || 0),
      labourCost: round2(Number(input.labourCost) || 0),
      consultationFee: round2(consultationFee),
      siteVisitFee: round2(siteVisitFee),
      modifierMultiplierApplied,
      gstPercent,
      gstAmount,
      finalPayableAmount: round2(consultationFee + siteVisitFee + gstAmount),
      requiresQuotation: true,
    };
  }

  let workCost: number;
  if (input.pricingType === 'PER_SQFT') {
    const sqft = Number(input.sqft) || 0;
    workCost = Number(input.perSqftRate || 0) * sqft;
  } else {
    workCost = Number(input.resolvedBasePrice) || 0;
  }
  workCost += Number(input.materialCost) || 0;
  workCost += Number(input.labourCost) || 0;
  workCost *= modifierMultiplierApplied;

  const low = round2(workCost);
  const high =
    input.pricingType === 'STARTING_FROM'
      ? round2(workCost * (1 + (Number(input.startingFromSpreadPercent) || 0) / 100))
      : low;

  // Final payable amount is anchored to the LOW/headline number — the
  // conservative, "starting from" figure — plus fees and GST on that figure.
  // The full low–high range is still returned in workCostLow/High for
  // transparency in the breakdown.
  const gstBase = low + consultationFee + siteVisitFee;
  const gstAmount = round2((gstBase * gstPercent) / 100);

  return {
    workCostLow: low,
    workCostHigh: high,
    materialCost: round2(Number(input.materialCost) || 0),
    labourCost: round2(Number(input.labourCost) || 0),
    consultationFee: round2(consultationFee),
    siteVisitFee: round2(siteVisitFee),
    modifierMultiplierApplied,
    gstPercent,
    gstAmount,
    finalPayableAmount: round2(gstBase + gstAmount),
    requiresQuotation: false,
  };
}

// ─── Pure: booking eligibility (requirement #8 — never blocks the customer) ──

export function determineEligibility(input: EligibilityInput): EligibilityResult {
  if (input.serviceType === 'DIGITAL') {
    return { eligible: true, reason: 'DIGITAL_NO_RESTRICTION', message: null };
  }
  if (!input.cityProvided) {
    return { eligible: false, reason: 'CITY_REQUIRED', message: 'Select your city to check availability.' };
  }
  const cityOk =
    input.cityFound &&
    input.cityIsActive &&
    input.cityServiceOverrideActive !== false &&
    input.activeVendorCount > 0;

  if (!cityOk) {
    return { eligible: false, reason: 'CITY_NOT_SERVICEABLE', message: CITY_NOT_SERVICEABLE_MESSAGE };
  }
  return { eligible: true, reason: 'OK', message: null };
}

// ─── Orchestration: fetch + compute + persist ───────────────────────────────
// Takes `prisma: any` and a CitiesService-shaped object exactly like
// resolveCommission() does — same reason: fully mockable in tests, no live DB.

export interface CitiesServiceLike {
  getServicePrice(cityName: string, serviceId: string): Promise<number | null>;
  getByName(cityName: string): Promise<{ id: string; isActive: boolean; priceMultiplier: any } | null>;
  list(): Promise<Array<{ name: string; activeVendors: number }>>;
}

export interface GenerateEstimateParams {
  serviceId: string;
  city?: string;
  sqft?: number;
  modifiers?: ModifierSelection[];
  customerId?: string;
  leadId?: string;
}

export class EstimateEngineError extends Error {
  constructor(public code: 'SERVICE_NOT_FOUND' | 'SQFT_REQUIRED', message: string) {
    super(message);
  }
}

export async function generateEstimate(
  prisma: any,
  citiesService: CitiesServiceLike,
  params: GenerateEstimateParams,
) {
  const service = await prisma.service.findUnique({
    where: { id: params.serviceId },
    include: { category: true },
  });
  if (!service) throw new EstimateEngineError('SERVICE_NOT_FOUND', 'Service not found');

  if (service.pricingType === 'PER_SQFT' && !(Number(params.sqft) > 0)) {
    throw new EstimateEngineError('SQFT_REQUIRED', 'sqft is required for this service');
  }

  // ── Resolve city + eligibility ──────────────────────────────────────────
  const cityName = params.city;
  let cityRow: { id: string; isActive: boolean; priceMultiplier: any } | null = null;
  let cityServiceRow: { isActive: boolean } | null = null;
  let activeVendorCount = 0;
  const isDigital = service.serviceType === 'DIGITAL';

  // Digital services are PAN-India/worldwide by definition — skip city
  // resolution (both eligibility AND city-based pricing) entirely rather than
  // querying it and then ignoring the result. Matches the frontend's existing
  // digital/onsite rule: digital never triggers a city check at all.
  if (cityName && !isDigital) {
    cityRow = await citiesService.getByName(cityName);
    if (cityRow) {
      cityServiceRow = await prisma.cityService.findUnique({
        where: { cityId_serviceId: { cityId: cityRow.id, serviceId: service.id } },
      });
      const allCities = await citiesService.list();
      const match = allCities.find((c) => c.name === cityName);
      activeVendorCount = match ? Number(match.activeVendors) || 0 : 0;
    }
  }

  const eligibility = determineEligibility({
    serviceType: service.serviceType,
    cityProvided: !!cityName,
    cityFound: !!cityRow,
    cityIsActive: !!cityRow?.isActive,
    cityServiceOverrideActive: cityServiceRow ? cityServiceRow.isActive : null,
    activeVendorCount,
  });

  // ── Resolve price components ────────────────────────────────────────────
  const priceMultiplier = cityRow ? Number(cityRow.priceMultiplier) || 1 : 1;
  let resolvedBasePrice = Number(service.offerPrice ?? service.basePrice) || 0;
  if (cityName && !isDigital) {
    const cityPrice = await citiesService.getServicePrice(cityName, service.id);
    if (cityPrice !== null) resolvedBasePrice = cityPrice; // CityService.customPrice already wins inside this call
  }
  const resolvedSqftRate = (Number(service.perSqftRate) || 0) * priceMultiplier;

  // ── Resolve modifiers (service-specific rows override category-wide rows
  //    for the same group; both are admin-managed, never hardcoded) ────────
  const modifierMultipliers: number[] = [];
  const modifiersApplied: Array<{ group: string; label: string; multiplier: number }> = [];
  if (params.modifiers?.length) {
    const rows = await prisma.servicePriceModifier.findMany({
      where: {
        isActive: true,
        OR: [{ serviceId: service.id }, { categoryId: service.categoryId, serviceId: null }],
      },
    });
    for (const sel of params.modifiers) {
      const serviceMatch = rows.find((r: any) => r.serviceId === service.id && r.group === sel.group && r.label === sel.label);
      const categoryMatch = rows.find((r: any) => !r.serviceId && r.categoryId === service.categoryId && r.group === sel.group && r.label === sel.label);
      const match = serviceMatch || categoryMatch;
      if (match) {
        modifierMultipliers.push(Number(match.multiplier));
        modifiersApplied.push({ group: sel.group, label: sel.label, multiplier: Number(match.multiplier) });
      }
      // No match — selection is silently ignored (no multiplier, no error);
      // keeps the API forgiving of stale/unknown option values.
    }
  }

  // ── Resolve GST — service override wins, else the active SERVICE-scoped
  //    TaxConfig row, else 0. Never hardcoded (requirement #10). ───────────
  let gstPercent = Number(service.gstOverridePercent ?? NaN);
  if (Number.isNaN(gstPercent)) {
    const taxRows = await prisma.taxConfig.findMany({
      where: { isActive: true, type: 'GST', appliesTo: { has: 'SERVICE' } },
      orderBy: { createdAt: 'asc' },
    });
    gstPercent = taxRows.length ? Number(taxRows[0].rate) : 0;
  }

  // ── "starting from" spread — admin-configurable via SiteSetting, not
  //    hardcoded (requirement #10). Falls back to 25% only if unset. ───────
  const spreadSetting = await prisma.siteSetting.findUnique({ where: { key: 'estimate_starting_from_spread_pct' } });
  const startingFromSpreadPercent = spreadSetting ? parseFloat(spreadSetting.value) || 25 : 25;

  const price = computePrice({
    pricingType: service.pricingType,
    resolvedBasePrice,
    materialCost: Number(service.materialCost) || 0,
    labourCost: Number(service.labourCost) || 0,
    perSqftRate: resolvedSqftRate,
    sqft: params.sqft,
    modifierMultipliers,
    consultationFee: Number(service.consultationFee) || 0,
    siteVisitFee: Number(service.siteVisitFee) || 0,
    gstPercent,
    startingFromSpreadPercent,
  });

  const timeline = {
    minDays: service.timelineMinDays ?? null,
    maxDays: service.timelineMaxDays ?? null,
    label: formatTimeline(service.timelineMinDays, service.timelineMaxDays),
  };

  // ── Persist for audit / lead follow-up / analytics ──────────────────────
  const estimateRow = await prisma.estimate.create({
    data: {
      serviceId: service.id,
      cityId: cityRow?.id ?? null,
      customerId: params.customerId ?? null,
      leadId: params.leadId ?? null,
      inputsJson: { serviceId: params.serviceId, city: params.city ?? null, sqft: params.sqft ?? null, modifiers: params.modifiers ?? [] },
      estimatedLow: price.workCostLow,
      estimatedHigh: price.workCostHigh,
      breakdownJson: { ...price, modifiersApplied },
      gstPercent: price.gstPercent,
      gstAmount: price.gstAmount,
      finalPayableAmount: price.finalPayableAmount,
      timelineMinDays: timeline.minDays,
      timelineMaxDays: timeline.maxDays,
      bookingEligible: eligibility.eligible,
      eligibilityReason: eligibility.reason,
      eligibilityMessage: eligibility.message,
    },
  });

  return {
    estimateId: estimateRow.id,
    service: {
      id: service.id,
      name: service.name,
      categoryId: service.categoryId,
      serviceType: service.serviceType,
      pricingType: service.pricingType,
    },
    estimatedCost: price.requiresQuotation
      ? null
      : { low: price.workCostLow, high: price.workCostHigh, currency: 'INR' },
    breakdown: {
      basePrice: price.requiresQuotation ? null : resolvedBasePrice,
      materialCost: price.materialCost,
      labourCost: price.labourCost,
      modifiersApplied,
      consultationFee: price.consultationFee,
      siteVisitFee: price.siteVisitFee,
      gstPercent: price.gstPercent,
      gstAmount: price.gstAmount,
    },
    finalPayableAmount: price.finalPayableAmount,
    requiresQuotation: price.requiresQuotation,
    timeline,
    bookingEligibility: eligibility,
  };
}

function formatTimeline(minDays: number | null | undefined, maxDays: number | null | undefined): string | null {
  if (!minDays && !maxDays) return null;
  const lo = minDays ?? maxDays!;
  const hi = maxDays ?? minDays!;
  if (lo % 7 === 0 && hi % 7 === 0) {
    const loW = lo / 7, hiW = hi / 7;
    return loW === hiW ? `${loW} week${loW === 1 ? '' : 's'}` : `${loW}–${hiW} weeks`;
  }
  return lo === hi ? `${lo} days` : `${lo}–${hi} days`;
}
