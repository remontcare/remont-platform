import { haversineKm, isValidIndiaCoords, LOCATION_STALE_AFTER_MS } from '../../common';

// What the partner's incoming-job call announces: where, when, how much and how far — built
// from the order's own confirmed slot (never the time the ring happens to fire) and the
// partner's latest valid GPS fix. Area + city only: no street, house number or customer data.

const IST = 'Asia/Kolkata';

export interface JobRingOrderInput {
  totalAmount?: unknown;
  slotStart?: Date | string | null;
  address?: { area?: string | null; city?: string | null; latitude?: number | null; longitude?: number | null } | null;
}
export interface JobRingVendorLocation {
  latitude?: number | null;
  longitude?: number | null;
  updatedAt?: Date | string | null;
}

export interface JobRingDetails {
  location: string | null;
  date: string | null;
  time: string | null;
  amount: string | null;
  distanceKm: number | null;
  /** "3.4 km" or null — never a guessed value. */
  distance: string | null;
  /** The announced sentence: one short sentence per detail so a voice pauses between them. */
  spoken: string;
}

export function buildJobRingDetails(order: JobRingOrderInput | null | undefined, vendor: JobRingVendorLocation | null | undefined, now: Date = new Date()): JobRingDetails {
  const area = (order?.address?.area || '').trim();
  const city = (order?.address?.city || '').trim();
  const location = [area, city].filter((s, i, a) => s && a.indexOf(s) === i).join(', ') || null;

  const slot = order?.slotStart ? new Date(order.slotStart) : null;
  const hasSlot = !!slot && !Number.isNaN(slot.getTime());
  const date = hasSlot ? slot!.toLocaleDateString('en-IN', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'long' }) : null;
  const time = hasSlot ? slot!.toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase() : null;

  const amountNum = Number(order?.totalAmount ?? 0);
  const amount = Number.isFinite(amountNum) && amountNum > 0 ? `₹${amountNum.toLocaleString('en-IN')}` : null;

  const distanceKm = distanceBetween(vendor, order?.address, now);
  const distance = distanceKm == null ? null : `${distanceKm} km`;

  const spoken = [
    `Location: ${location ?? 'not available'}.`,
    hasSlot ? `Date: ${date}.` : 'Date and time: to be confirmed.',
    ...(hasSlot ? [`Time: ${time}.`] : []),
    `Amount: ${amount ?? 'to be confirmed'}.`,
    distance ? `Distance: ${distance} away.` : 'Distance unavailable.',
  ].join(' ');

  return { location, date, time, amount, distanceKm, distance, spoken };
}

/**
 * Straight-line km from the partner's latest GPS fix to the job, to one decimal. Null — never
 * 0 or a default — when either point is missing, (0,0)/outside India, or the partner's fix is
 * older than LOCATION_STALE_AFTER_MS (the same staleness rule dispatch uses).
 */
export function distanceBetween(
  vendor: JobRingVendorLocation | null | undefined,
  address: JobRingOrderInput['address'],
  now: Date = new Date(),
): number | null {
  const vLat = vendor?.latitude, vLng = vendor?.longitude;
  const aLat = address?.latitude, aLng = address?.longitude;
  if (!isValidIndiaCoords(vLat, vLng) || !isValidIndiaCoords(aLat, aLng)) return null;
  const at = vendor?.updatedAt ? new Date(vendor.updatedAt) : null;
  if (!at || Number.isNaN(at.getTime()) || now.getTime() - at.getTime() > LOCATION_STALE_AFTER_MS) return null;
  return Math.round(haversineKm(vLat!, vLng!, aLat!, aLng!) * 10) / 10;
}
