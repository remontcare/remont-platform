/**
 * Allow-list HTML sanitiser for policy section content.
 *
 * Policy sections are rich text written by admins and rendered on the public
 * site with innerHTML, so everything is sanitised on WRITE and again on READ
 * (defence in depth — a row edited directly in the DB still can't inject
 * script). No dependency: the allowed vocabulary is tiny (headings, lists,
 * emphasis, links, simple tables), so a strict tokenizer is enough.
 *
 *  - Unknown tags are dropped but their text is kept.
 *  - script/style/iframe/object/embed/svg/math/template/noscript/textarea/select
 *    are dropped WITH their content.
 *  - Every attribute is dropped except href/title on <a> and colspan/rowspan on
 *    table cells. No style, no class, no on* handlers.
 *  - href must be http(s), mailto, tel, a site-relative path or a #fragment —
 *    javascript:, data:, vbscript: (including entity-encoded or whitespace-split
 *    variants) are removed.
 *  - Comments, doctype, CDATA and processing instructions are removed.
 *  - Stray "<" / ">" in text are escaped.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'small',
  'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'blockquote', 'code',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);
const VOID_TAGS = new Set(['br', 'hr']);
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'svg', 'math', 'template', 'noscript', 'textarea', 'select', 'title', 'head', 'xmp', 'noembed', 'noframes',
]);
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
};

export const MAX_SECTION_HTML = 100_000;

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 0))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(parseInt(d, 10) || 0))
    .replace(/&colon;?/gi, ':')
    .replace(/&tab;?/gi, '\t')
    .replace(/&newline;?/gi, '\n')
    .replace(/&quot;?/gi, '"')
    .replace(/&apos;?/gi, "'")
    .replace(/&lt;?/gi, '<')
    .replace(/&gt;?/gi, '>')
    .replace(/&amp;?/gi, '&');
}

/** Returns a safe href or null. */
export function safeHref(raw: string): string | null {
  // Decode twice (double-encoding) and strip whitespace/control chars browsers ignore inside a scheme.
  const decoded = decodeEntities(decodeEntities(raw)).replace(/[\u0000- \u007f-\u009f]/g, '');
  if (!decoded) return null;
  const lower = decoded.toLowerCase();
  if (/^(https?:|mailto:|tel:)/.test(lower)) return decoded;
  if (lower.startsWith('//')) return null; // protocol-relative → arbitrary host, disallow
  if (lower.startsWith('/') || lower.startsWith('#')) return decoded;
  // Anything else with a scheme (javascript:, data:, vbscript:, …) is rejected.
  if (/^[a-z][a-z0-9+.-]*:/.test(lower)) return null;
  // Plain relative path like "privacy" — allow, it can't carry a scheme.
  return /^[a-z0-9._~\-/?=&%]+$/i.test(decoded) ? decoded : null;
}

function parseAttrs(src: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']);
  return out;
}

export function sanitizeHtml(input: string): string {
  let html = String(input ?? '');
  if (html.length > MAX_SECTION_HTML) html = html.slice(0, MAX_SECTION_HTML);
  // Comments / doctype / CDATA / processing instructions.
  html = html.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<![\s\S]*?(>|$)/g, '').replace(/<\?[\s\S]*?(>|$)/g, '');

  const tokenRe = /<[^>]*>?/g;
  let out = '';
  let last = 0;
  let dropUntil: string | null = null;
  let m: RegExpExecArray | null;

  const emitText = (t: string) => {
    if (dropUntil) return;
    out += t.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  while ((m = tokenRe.exec(html))) {
    emitText(html.slice(last, m.index));
    last = m.index + m[0].length;
    const tok = m[0];
    // Like browsers, a tag name must follow "<" (or "</") immediately — "a < b" is text.
    const tm = /^<(\/)?([a-zA-Z][a-zA-Z0-9]*)(\s[\s\S]*?)?\/?\s*>$/.exec(tok);
    if (!tm || (tm[3] || '').includes('<')) {
      // Text, or a malformed/nested tag like "<scr<script>" (dropped entirely).
      if (!/^<\/?[a-zA-Z!?]/.test(tok)) emitText(tok);
      continue;
    }
    const closing = !!tm[1];
    const name = tm[2].toLowerCase();

    if (dropUntil) {
      if (closing && name === dropUntil) dropUntil = null;
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing) dropUntil = name;
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;

    if (closing) {
      if (!VOID_TAGS.has(name)) out += `</${name}>`;
      continue;
    }
    const allowed = ALLOWED_ATTRS[name] || [];
    let attrs = '';
    for (const [k, v] of parseAttrs(tm[3] || '')) {
      if (!allowed.includes(k)) continue;
      if (k === 'href') {
        const href = safeHref(v);
        if (!href) continue;
        attrs += ` href="${escapeHtml(href)}"`;
        if (/^https?:/i.test(href)) attrs += ' rel="noopener noreferrer nofollow" target="_blank"';
      } else if (k === 'colspan' || k === 'rowspan') {
        const n = parseInt(v, 10);
        if (n > 0 && n < 50) attrs += ` ${k}="${n}"`;
      } else {
        attrs += ` ${k}="${escapeHtml(decodeEntities(v))}"`;
      }
    }
    out += `<${name}${attrs}>`;
  }
  emitText(html.slice(last));
  return out.trim();
}

/** Plain-text field (titles, names): strip tags entirely and collapse whitespace. */
export function sanitizeText(input: string, max = 200): string {
  return String(input ?? '')
    .replace(/<[^>]*>?/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ─── Policy variables ────────────────────────────────────────────────────────

/** {{VARIABLE}} → SiteSetting key (group "legal"). Edited in Settings → Legal Information. */
export const LEGAL_VARIABLE_SETTINGS: Record<string, { key: string; label: string }> = {
  COMPANY_NAME: { key: 'legal_company_name', label: 'Company / brand name' },
  COMPANY_LEGAL_NAME: { key: 'legal_company_legal_name', label: 'Registered legal entity name' },
  COMPANY_ADDRESS: { key: 'legal_company_address', label: 'Registered address' },
  SUPPORT_EMAIL: { key: 'legal_support_email', label: 'Support email' },
  SUPPORT_PHONE: { key: 'legal_support_phone', label: 'Support phone' },
  GRIEVANCE_EMAIL: { key: 'legal_grievance_email', label: 'Grievance email' },
  GRIEVANCE_OFFICER: { key: 'legal_grievance_officer', label: 'Grievance Officer name & designation' },
  WEBSITE_URL: { key: 'legal_website_url', label: 'Website URL' },
  PRIVACY_EMAIL: { key: 'legal_privacy_email', label: 'Privacy / data-request email' },
  GSTIN: { key: 'legal_gstin', label: 'GSTIN (leave empty until verified)' },
};
/**
 * Business facts a policy must not go live without. If an ACTIVE section of a
 * draft uses one of these and it is not set in Legal Information, publishing is
 * refused outright (no override) — rather than printing "[… not set]" on a
 * public legal page. Other gaps (unset optional variables, [[placeholders]])
 * only need the admin's explicit confirmation.
 */
export const CRITICAL_VARIABLES = [
  'COMPANY_LEGAL_NAME', 'COMPANY_ADDRESS', 'SUPPORT_EMAIL', 'PRIVACY_EMAIL',
  'GRIEVANCE_OFFICER', 'GRIEVANCE_EMAIL', 'GSTIN',
];
/** Computed per render, not stored. */
export const COMPUTED_VARIABLES = ['CURRENT_DATE', 'LAST_UPDATED', 'POLICY_VERSION'];
export const ALL_VARIABLES = [...Object.keys(LEGAL_VARIABLE_SETTINGS), ...COMPUTED_VARIABLES];

/** Marker used in default templates for business facts only the admin can supply. */
export const PLACEHOLDER_RE = /\[\[[^\]]{1,300}\]\]/g;

export function formatPolicyDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

/**
 * Substitute {{VARIABLES}} into already-sanitised HTML. Values are HTML-escaped
 * (they are admin-entered settings, but still never trusted as markup). A
 * variable with no value renders as a visible "[… not set]" marker and is
 * reported in `missing`, so an admin sees the gap rather than a blank.
 */
export function renderVariables(
  html: string,
  values: Record<string, string>,
): { html: string; missing: string[] } {
  const missing = new Set<string>();
  const out = html.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (whole, name: string) => {
    if (!ALL_VARIABLES.includes(name)) return whole;
    const v = (values[name] || '').trim();
    if (!v) {
      missing.add(name);
      return `[${name.replace(/_/g, ' ').toLowerCase()} not set]`;
    }
    return escapeHtml(v);
  });
  return { html: out, missing: [...missing] };
}

/** Unfilled [[…]] placeholders and unset variables — shown to the admin before publishing. */
export function findUnresolved(html: string, values: Record<string, string>): { placeholders: string[]; missingVariables: string[] } {
  const placeholders = [...new Set((html.match(PLACEHOLDER_RE) || []).map((p) => p.slice(2, -2).trim()))];
  return { placeholders, missingVariables: renderVariables(html, values).missing };
}
