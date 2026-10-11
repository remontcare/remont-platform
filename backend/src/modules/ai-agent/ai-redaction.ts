// Keeps personal data away from the AI provider and out of logs.
//
// Before a conversation is sent to the model, phone numbers, emails, OTPs, Aadhaar/PAN, IFSC
// and bank account numbers are replaced with placeholders such as ⟦PHONE_1⟧. The model can
// still pass a placeholder to a tool ("create a lead for ⟦PHONE_1⟧") — the server swaps the
// real value back in only when executing that tool, and in the reply shown to the same person
// who typed it. The provider never receives the raw value.

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  // Order matters: the longer/more specific shapes first so a bank account isn't read as a phone.
  { kind: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'PAN', re: /\b[A-Z]{5}\d{4}[A-Z]\b/gi },
  { kind: 'IFSC', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi },
  { kind: 'AADHAAR', re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g },
  { kind: 'PHONE', re: /(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g },
  { kind: 'OTP', re: /\b(?:otp|code|pin)\b\D{0,12}(\d{4,6})\b/gi },
  { kind: 'ACCOUNT', re: /\b\d{9,18}\b/g },
];

export interface RedactionMap {
  /** placeholder -> real value */
  byPlaceholder: Map<string, string>;
  /** real value -> placeholder (so the same value always gets the same placeholder) */
  byValue: Map<string, string>;
  counters: Record<string, number>;
}

export function newRedactionMap(): RedactionMap {
  return { byPlaceholder: new Map(), byValue: new Map(), counters: {} };
}

/** Replaces sensitive values in `text` with stable placeholders recorded in `map`. */
export function redactForProvider(text: string, map: RedactionMap): string {
  if (!text) return text;
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, (match: string, group?: string) => {
      // For OTP the sensitive part is the digits after the keyword, not the keyword itself.
      const value = kind === 'OTP' && typeof group === 'string' ? group : match;
      const key = value.replace(/[\s-]/g, '');
      let ph = map.byValue.get(key);
      if (!ph) {
        map.counters[kind] = (map.counters[kind] || 0) + 1;
        ph = `⟦${kind}_${map.counters[kind]}⟧`;
        map.byValue.set(key, ph);
        map.byPlaceholder.set(ph, value.trim());
      }
      return kind === 'OTP' && typeof group === 'string' ? match.replace(group, ph) : ph;
    });
  }
  return out;
}

/** Puts real values back (tool arguments, the reply to the same person). Unknown placeholders stay as-is. */
export function restoreFromProvider<T>(value: T, map: RedactionMap): T {
  if (!map.byPlaceholder.size) return value;
  const fix = (s: string) => s.replace(/⟦[A-Z]+_\d+⟧/g, (ph) => map.byPlaceholder.get(ph) ?? ph);
  const walk = (v: any): any => {
    if (typeof v === 'string') return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

/** One-way redaction for log lines — never reversible, never includes the raw value. */
export function redactForLog(value: unknown): string {
  let s: string;
  try { s = typeof value === 'string' ? value : JSON.stringify(value); } catch { s = String(value); }
  const map = newRedactionMap();
  return redactForProvider(s ?? '', map).slice(0, 500);
}
