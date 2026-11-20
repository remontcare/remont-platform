// Pure rules for catalog variant groups — no database access, so they are unit-tested directly.
// A variant group shows several existing Service/Product rows as one listing with options; every
// option stays its own row (own id, price, city price, stock), so nothing here touches pricing.

export const MAX_OPTION_DIMENSIONS = 3;
const MAX_OPTION_NAME = 40;
const MAX_OPTION_VALUE = 60;

export type VariantOptions = Record<string, string>;

export interface MemberInput {
  id: string;
  options: unknown;
  sortOrder?: number;
}

export interface MemberRow {
  id: string;
  name: string;
  categoryId: string;
  variantGroupId: string | null;
}

/** Trimmed, non-empty, unique (case-insensitive) option names in admin order. */
export function normalizeOptionNames(names: unknown): string[] {
  if (!Array.isArray(names)) throw new Error('optionNames must be a list');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const n = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!n) throw new Error('Option names cannot be empty');
    if (n.length > MAX_OPTION_NAME) throw new Error(`Option name "${n}" is longer than ${MAX_OPTION_NAME} characters`);
    if (seen.has(n.toLowerCase())) throw new Error(`Option name "${n}" is repeated`);
    seen.add(n.toLowerCase());
    out.push(n);
  }
  if (!out.length) throw new Error('A variant group needs at least one option (e.g. "Size")');
  if (out.length > MAX_OPTION_DIMENSIONS) throw new Error(`A variant group can have at most ${MAX_OPTION_DIMENSIONS} options`);
  return out;
}

/** The member's option values, keyed exactly by the group's option names; rejects missing/extra keys. */
export function normalizeMemberOptions(optionNames: string[], options: unknown, memberLabel: string): VariantOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error(`${memberLabel}: option values are required`);
  }
  const given = options as Record<string, unknown>;
  const byLower = new Map(Object.keys(given).map((k) => [k.trim().toLowerCase(), k]));
  const out: VariantOptions = {};
  for (const name of optionNames) {
    const key = byLower.get(name.toLowerCase());
    const value = key === undefined ? '' : String(given[key] ?? '').trim().replace(/\s+/g, ' ');
    if (!value) throw new Error(`${memberLabel}: "${name}" needs a value`);
    if (value.length > MAX_OPTION_VALUE) throw new Error(`${memberLabel}: "${name}" value is longer than ${MAX_OPTION_VALUE} characters`);
    out[name] = value;
  }
  const extra = Object.keys(given).filter((k) => !optionNames.some((n) => n.toLowerCase() === k.trim().toLowerCase()));
  if (extra.length) throw new Error(`${memberLabel}: unknown option "${extra[0]}"`);
  return out;
}

export function combinationKey(optionNames: string[], options: VariantOptions): string {
  return optionNames.map((n) => (options[n] || '').toLowerCase()).join('\u0000');
}

/**
 * Validates a full member list for a group: rows exist, all in one category, not already in a
 * different group, every option filled, and no two members with the same combination (which
 * would make a customer's choice ambiguous). Returns the cleaned assignments.
 */
export function validateMembers(
  groupId: string | null,
  optionNames: string[],
  members: MemberInput[],
  rows: MemberRow[],
): { id: string; options: VariantOptions; sortOrder: number }[] {
  if (!Array.isArray(members)) throw new Error('members must be a list');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = new Set<string>();
  const combos = new Map<string, string>();
  let categoryId: string | null = null;
  return members.map((m, i) => {
    const row = byId.get(m?.id);
    if (!row) throw new Error(`Item ${m?.id || '#' + (i + 1)} was not found`);
    if (ids.has(row.id)) throw new Error(`"${row.name}" is listed twice`);
    ids.add(row.id);
    if (row.variantGroupId && row.variantGroupId !== groupId) {
      throw new Error(`"${row.name}" already belongs to another variant group — remove it there first`);
    }
    if (categoryId === null) categoryId = row.categoryId;
    else if (row.categoryId !== categoryId) throw new Error(`"${row.name}" is in a different category — all options of one listing must share a category`);
    const options = normalizeMemberOptions(optionNames, m.options, `"${row.name}"`);
    const key = combinationKey(optionNames, options);
    const clash = combos.get(key);
    if (clash) throw new Error(`"${row.name}" and "${clash}" have the same options (${describeOptions(optionNames, options)}) — each option must be unique`);
    combos.set(key, row.name);
    const sortOrder = Number.isInteger(m.sortOrder) ? (m.sortOrder as number) : i;
    return { id: row.id, options, sortOrder };
  });
}

/**
 * The order-line snapshot of what the customer picked. Options are an ordered list (JSONB does
 * not keep object key order) carrying their names, so a later rename/edit of the catalog never
 * changes how a past order reads. Standalone rows get just their name.
 */
export function orderLineSnapshot(row: {
  name: string; variantGroupId?: string | null; variantOptions?: unknown;
  variantGroup?: { optionNames?: string[] | null } | null;
}): { itemName: string; variantGroupId: string | undefined; variantOptions: { name: string; value: string }[] | undefined } {
  const opts = row.variantOptions && typeof row.variantOptions === 'object' && !Array.isArray(row.variantOptions)
    ? (row.variantOptions as Record<string, unknown>) : null;
  // Standalone row: only the name is recorded (variant columns stay unset).
  if (!row.variantGroupId || !opts) return { itemName: row.name, variantGroupId: undefined, variantOptions: undefined };
  const names = row.variantGroup?.optionNames?.length ? row.variantGroup.optionNames : Object.keys(opts);
  const list = names
    .filter((n) => opts[n] != null && String(opts[n]).trim())
    .map((n) => ({ name: n, value: String(opts[n]).trim() }));
  return { itemName: row.name, variantGroupId: row.variantGroupId, variantOptions: list.length ? list : undefined };
}

/** Label of an order-line snapshot (orderLineSnapshot().variantOptions) — '' for older/plain lines. */
export function snapshotLabel(variantOptions: unknown): string {
  if (!Array.isArray(variantOptions)) return '';
  return variantOptions
    .filter((x: any) => x && x.name && x.value != null && String(x.value).trim())
    .map((x: any) => `${x.name}: ${String(x.value).trim()}`)
    .join(' · ');
}

/** "Size: 2BHK · Capacity: 1 Ton" — the label stored and shown on cart/order lines. */
export function describeOptions(optionNames: string[] | null | undefined, options: unknown): string {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return '';
  const o = options as Record<string, unknown>;
  const names = optionNames && optionNames.length ? optionNames : Object.keys(o);
  return names.filter((n) => o[n] != null && String(o[n]).trim()).map((n) => `${n}: ${String(o[n]).trim()}`).join(' · ');
}

// ─── Duplicate suggestions ───────────────────────────────────────────────────────────────────
// Existing catalogs hold each size as its own row, e.g. "General Pest Control (1BHK)" …
// "(5BHK)". Suggestions only PROPOSE a group for admin review — nothing is linked automatically.

const UNIT_SUFFIX = /\s*\(\s*per\s+[^)]*\)\s*$/i;

export function splitVariantName(name: string): { base: string; label: string | null } {
  const n = String(name || '').trim().replace(UNIT_SUFFIX, '').trim();
  const paren = n.match(/^(.*\S)\s*\(([^()]+)\)\s*$/);
  if (paren && paren[1].replace(/[^\p{L}\p{N}]/gu, '').length >= 3) return { base: paren[1].trim(), label: paren[2].trim() };
  const dash = n.match(/^(.*\S)\s+[-–—]\s+([^()]+)$/);
  if (dash && dash[1].replace(/[^\p{L}\p{N}]/gu, '').length >= 3) return { base: dash[1].trim(), label: dash[2].trim() };
  return { base: n, label: null };
}

export function guessOptionName(values: string[]): string {
  const all = (re: RegExp) => values.length > 0 && values.every((v) => re.test(v));
  if (all(/\b\d+\s*(bhk|rk)\b/i) || all(/\b(studio|villa|bungalow|bhk)\b/i)) return 'Size';
  if (all(/\b\d+(\.\d+)?\s*(ton|tr)\b/i)) return 'Capacity';
  if (all(/\b\d+\s*cameras?\b/i)) return 'Cameras';
  if (all(/\b\d+(\.\d+)?\s*(l|ltr|litre|liter)s?\b/i)) return 'Tank size';
  if (all(/\b\d+(\.\d+)?\s*(inch|in|")/i)) return 'Screen size';
  if (all(/\bpack of\b/i)) return 'Pack';
  if (all(/\b\d+(\.\d+)?\s*(ml|kg|g|gm)\b/i)) return 'Quantity';
  if (all(/\b(construction|essential|premium|basic|standard|deluxe)\b/i)) return 'Package';
  return 'Option';
}

export interface Suggestion {
  name: string;
  categoryId: string;
  optionNames: string[];
  members: { id: string; name: string; price: number; options: VariantOptions }[];
}

/** Rows that look like options of one listing (same category + same base name). */
export function suggestVariantGroups(
  rows: { id: string; name: string; categoryId: string; price: number; variantGroupId?: string | null }[],
): Suggestion[] {
  const buckets = new Map<string, { base: string; categoryId: string; items: { id: string; name: string; price: number; label: string }[] }>();
  for (const r of rows) {
    if (r.variantGroupId) continue;
    const { base, label } = splitVariantName(r.name);
    if (!label) continue;
    const key = `${r.categoryId}|${base.toLowerCase()}`;
    const b = buckets.get(key) || { base, categoryId: r.categoryId, items: [] };
    b.items.push({ id: r.id, name: r.name, price: r.price, label });
    buckets.set(key, b);
  }
  const out: Suggestion[] = [];
  for (const b of buckets.values()) {
    if (b.items.length < 2) continue;
    // "R22, 1.5 Ton" style labels split into several options when every label splits the same way.
    const parts = b.items.map((it) => it.label.split(/\s*,\s*/).filter(Boolean));
    const dims = parts[0].length;
    const multi = dims > 1 && dims <= MAX_OPTION_DIMENSIONS && parts.every((p) => p.length === dims);
    const optionNames = multi
      ? Array.from({ length: dims }, (_, d) => guessOptionName(parts.map((p) => p[d])))
      : [guessOptionName(b.items.map((it) => it.label))];
    // Two dimensions guessed to the same name would collide — fall back to numbered names.
    const unique = new Set(optionNames.map((n) => n.toLowerCase())).size === optionNames.length;
    const names = unique ? optionNames : optionNames.map((_, d) => `Option ${d + 1}`);
    const members = b.items
      .map((it, i) => ({
        id: it.id, name: it.name, price: it.price,
        options: Object.fromEntries(names.map((n, d) => [n, multi ? parts[i][d] : it.label])) as VariantOptions,
      }))
      .sort((a, z) => a.price - z.price);
    // Same combination twice (e.g. two rows both "(1BHK)") cannot become one listing safely.
    const combos = new Set(members.map((m) => combinationKey(names, m.options)));
    if (combos.size !== members.length) continue;
    out.push({ name: b.base, categoryId: b.categoryId, optionNames: names, members });
  }
  return out.sort((a, z) => z.members.length - a.members.length || a.name.localeCompare(z.name));
}
