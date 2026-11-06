import { CatalogRelationType } from '@prisma/client';

/**
 * "You may also need" for a customer's open order — products and services related to what
 * they just bought (Mixer repair → mixers + plumbing material; a split AC → AC installation,
 * stabilizer, MCB), shown until the order's invoice is issued.
 *
 * Two sources, in this order:
 *  1. CURATED — admin-defined CatalogRelation edges (Admin → Recommendations). Always first.
 *  2. AUTO    — a fallback for anything with no curated edges, built only from REAL catalog
 *     rows: the service category ↔ product category bridge below plus name-word overlap.
 *     It never invents an item, a price or a claim; it only picks among active, in-stock,
 *     city-available rows that already exist.
 */

// Service category (ServiceCategory.slug or key) ↔ product category (ProductCategory.key).
// Matching is case-insensitive. A category missing here simply gets no AUTO suggestions.
export const SERVICE_TO_PRODUCT_CATEGORIES: Record<string, string[]> = {
  plumbing: ['plumbing'],
  'ac-service-repair': ['ac-hvac'],
  electrical: ['electrical'],
  'carpentry-woodwork': ['tools', 'furniture'],
  'painting-services': ['paint'],
  construction: ['construction', 'flooring'],
  renovation: ['construction', 'flooring', 'paint'],
  waterproofing: ['construction'],
  'appliance-repair': ['kitchen'],
  'interior-design': ['furniture'],
};

// Accessories a product normally needs, by the bought product's category. Only products
// whose NAME matches are suggested (so buying an AC suggests a stabilizer or an MCB — never a
// second AC or a random fan).
export const PRODUCT_ACCESSORIES: Record<string, { categories: string[]; match: RegExp }> = {
  'ac-hvac': { categories: ['ac-hvac', 'electrical'], match: /stabili[sz]er|\bstand\b|bracket|copper pipe|\bmcb\b|distribution board/i },
};

// \b keeps "Uninstallation" / "Reinstall" out — a just-bought product needs installing, not removing.
const INSTALL_RE = /\b(install|fitting|set ?up|mounting)/i;
const STOP = new Set(['and', 'the', 'for', 'with', 'per', 'of', 'in', 'to', 'service', 'services', 'repair', 'replacement', 'installation', 'install', 'new', 'pack', 'set', 'full', 'star']);

export function nameTokens(name: string): Set<string> {
  return new Set(
    String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOP.has(t)),
  );
}

function overlap(a: Set<string>, b: Set<string>) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export interface Anchor { kind: 'PRODUCT' | 'SERVICE'; id: string; name: string; categoryKey: string }
export interface Candidate { kind: 'PRODUCT' | 'SERVICE'; id: string; name: string; categoryKey: string; price: number }
export interface Scored { kind: 'PRODUCT' | 'SERVICE'; id: string; relationType: CatalogRelationType; score: number; forName: string }

/** Product categories the AUTO source may draw from for these anchors. */
export function autoProductCategories(anchors: Anchor[]): string[] {
  const out = new Set<string>();
  for (const a of anchors) {
    const k = a.categoryKey.toLowerCase();
    if (a.kind === 'SERVICE') (SERVICE_TO_PRODUCT_CATEGORIES[k] || []).forEach((c) => out.add(c));
    else (PRODUCT_ACCESSORIES[k]?.categories || []).forEach((c) => out.add(c));
  }
  return [...out];
}

/** Service categories the AUTO source may draw from (services that go with bought products). */
export function autoServiceCategories(anchors: Anchor[]): string[] {
  const out = new Set<string>();
  for (const a of anchors) {
    if (a.kind !== 'PRODUCT') continue;
    const k = a.categoryKey.toLowerCase();
    for (const [svcCat, prodCats] of Object.entries(SERVICE_TO_PRODUCT_CATEGORIES)) if (prodCats.includes(k)) out.add(svcCat);
  }
  return [...out];
}

/**
 * Rank AUTO candidates for the anchors. Rules:
 *  - service bought  → products in its bridged category; name-overlapping ones first
 *    (Mixer repair → mixers), then at most `fillPerService` other materials, cheapest first.
 *  - product bought  → installation services in its bridged category that share a name
 *    word with it (Split AC → Split AC Installation first), and accessories matching PRODUCT_ACCESSORIES.
 */
export function scoreAuto(anchors: Anchor[], candidates: Candidate[], fillPerService = 3): Scored[] {
  const best = new Map<string, Scored>();
  const put = (c: Candidate, relationType: CatalogRelationType, score: number, forName: string) => {
    const key = `${c.kind}:${c.id}`;
    const prev = best.get(key);
    if (!prev || prev.score < score) best.set(key, { kind: c.kind, id: c.id, relationType, score, forName });
  };

  for (const a of anchors) {
    const at = nameTokens(a.name);
    const ak = a.categoryKey.toLowerCase();
    if (a.kind === 'SERVICE') {
      const cats = SERVICE_TO_PRODUCT_CATEGORIES[ak] || [];
      const pool = candidates.filter((c) => c.kind === 'PRODUCT' && cats.includes(c.categoryKey.toLowerCase()));
      const fill: Candidate[] = [];
      for (const c of pool) {
        const o = overlap(at, nameTokens(c.name));
        if (o > 0) put(c, CatalogRelationType.RECOMMENDED, 100 + o * 10, a.name);
        else fill.push(c);
      }
      fill.sort((x, y) => x.price - y.price).slice(0, fillPerService).forEach((c, i) => put(c, CatalogRelationType.RELATED, 50 - i, a.name));
    } else {
      const svcCats = Object.entries(SERVICE_TO_PRODUCT_CATEGORIES).filter(([, p]) => p.includes(ak)).map(([s]) => s);
      for (const c of candidates) {
        if (c.kind !== 'SERVICE' || !svcCats.includes(c.categoryKey.toLowerCase())) continue;
        // Only installation services: a brand-new product doesn't need gas filling or repair.
        const o = overlap(at, nameTokens(c.name));
        if (o === 0 || !INSTALL_RE.test(c.name)) continue;
        put(c, CatalogRelationType.INSTALLATION_SERVICE, 200 + o * 10, a.name);
      }
      const acc = PRODUCT_ACCESSORIES[ak];
      if (acc) {
        for (const c of candidates) {
          if (c.kind === 'PRODUCT' && acc.categories.includes(c.categoryKey.toLowerCase()) && acc.match.test(c.name)) {
            put(c, CatalogRelationType.RECOMMENDED, 150, a.name);
          }
        }
      }
    }
  }
  return [...best.values()].sort((x, y) => y.score - x.score);
}

// Orders past these points get no suggestions: not bought yet, ended, or already invoiced.
export const NO_SUGGESTION_STATUSES = ['PENDING_PAYMENT', 'CANCELLED', 'REFUNDED', 'INVOICED', 'CLOSED'] as const;
