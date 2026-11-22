/**
 * Service discovery — ONE resolver behind website search, voice search, the /services/<slug>
 * category pages, REMI's search_services tool and the customer app.
 *
 * A query in English, Hindi (Devanagari) or Hinglish ("Mujhe plumber chahiye", "AC servicing
 * karwani hai", "ghar mein paani leak ho raha hai") is resolved against the REAL catalogue that
 * is passed in (active categories + active services from the DB). The vocabulary below only
 * says what a word MEANS ("badhai" ≈ carpentry); which category that is, its id, slug, name,
 * services and prices always come from the catalogue — nothing is invented and no category
 * name is hard-coded. A concept with no matching active category simply resolves to nothing.
 *
 * Pure (no DB, no Nest) so it is tested directly against a snapshot of the real catalogue.
 */

export interface DiscoveryCategory {
  id: string;
  key: string;
  slug?: string | null;
  name: string;
  /** Active services in the category (only the count matters here). */
  serviceCount: number;
}
export interface DiscoveryService {
  id: string;
  name: string;
  categoryId: string;
  /** Sub-category name, e.g. "Bathroom Renovation" — matched like the service name. */
  subCategoryName?: string | null;
  isPopular?: boolean;
}
export interface CategoryMatch {
  id: string;
  key: string;
  slug: string;
  name: string;
  score: number;
  confidence: number;
  serviceCount: number;
  url: string;
}
export interface ServiceMatch { id: string; categoryId: string; score: number }
export interface DiscoveryResult {
  query: string;
  /** Tokens after normalisation (Devanagari → Latin, fillers removed) — for debugging/analytics. */
  normalized: string[];
  /** The category to open, or null when nothing matched or the query is ambiguous. */
  best: CategoryMatch | null;
  /** True when two or more categories fit about equally well — show `categories` as choices. */
  ambiguous: boolean;
  /** Ranked matches (at most 5), best first. */
  categories: CategoryMatch[];
  /** Matching services across the catalogue, best first (at most 20). */
  services: ServiceMatch[];
  confidence: number;
}

// ─── Language normalisation ─────────────────────────────────────────────────────────────

// Devanagari words customers actually type/speak → the Latin form the vocabulary uses.
const DEVANAGARI_RAW: Record<string, string> = {
  'प्लंबर': 'plumber', 'प्लम्बर': 'plumber', 'प्लंबिंग': 'plumbing', 'नल': 'nal', 'टोंटी': 'tonti', 'पाइप': 'pipe',
  'पानी': 'paani', 'लीक': 'leak', 'लीकेज': 'leakage', 'रिसाव': 'leak', 'टपक': 'tapak', 'टंकी': 'tanki', 'नाली': 'nali',
  'ड्रेन': 'drain', 'बाथरूम': 'bathroom', 'शौचालय': 'toilet', 'टॉयलेट': 'toilet', 'किचन': 'kitchen', 'रसोई': 'kitchen',
  'इलेक्ट्रीशियन': 'electrician', 'इलेक्ट्रिशियन': 'electrician', 'बिजली': 'bijli', 'वायरिंग': 'wiring', 'स्विच': 'switch',
  'पंखा': 'pankha', 'लाइट': 'light',
  'एसी': 'ac', 'ए.सी.': 'ac', 'कूलिंग': 'cooling', 'ठंडा': 'thanda', 'ठंडक': 'thandak', 'गैस': 'gas',
  'सर्विस': 'service', 'सर्विसिंग': 'servicing', 'रिपेयर': 'repair', 'मरम्मत': 'repair', 'ठीक': 'theek',
  'कारपेंटर': 'carpenter', 'बढ़ई': 'badhai', 'बढई': 'badhai', 'फर्नीचर': 'furniture', 'दरवाजा': 'darwaza', 'दरवाज़ा': 'darwaza',
  'खिड़की': 'khidki', 'खिडकी': 'khidki', 'अलमारी': 'almari',
  'सफाई': 'safai', 'सफ़ाई': 'safai', 'साफ': 'saaf', 'क्लीनिंग': 'cleaning', 'डीप': 'deep',
  'पेंटर': 'painter', 'पेंट': 'paint', 'रंग': 'rang', 'पुताई': 'putai',
  'दीमक': 'deemak', 'कॉकरोच': 'cockroach', 'कीड़े': 'keede', 'कीड़ा': 'keeda', 'मच्छर': 'machhar', 'खटमल': 'khatmal',
  'चूहे': 'chuhe', 'चूहा': 'chuha',
  'सीलन': 'seelan', 'नमी': 'nami', 'वॉटरप्रूफिंग': 'waterproofing', 'छत': 'chhat',
  'रिनोवेशन': 'renovation', 'नवीनीकरण': 'renovation',
  'निर्माण': 'construction', 'ठेकेदार': 'thekedar', 'मिस्त्री': 'mistri', 'मकान': 'makan', 'घर': 'ghar',
  'इंटीरियर': 'interior', 'फ्रिज': 'fridge', 'गीजर': 'geyser', 'गीज़र': 'geyser', 'मशीन': 'machine', 'वाशिंग': 'washing',
  'कैमरा': 'camera', 'सोलर': 'solar', 'टाइल': 'tile', 'टाइल्स': 'tiles',
  'मुझे': 'mujhe', 'चाहिए': 'chahiye', 'चाहिये': 'chahiye', 'करवाना': 'karwana', 'करवानी': 'karwani', 'कराना': 'karana',
  'है': 'hai', 'हैं': 'hai', 'में': 'mein', 'का': 'ka', 'की': 'ki', 'के': 'ke', 'को': 'ko', 'हो': 'ho', 'रहा': 'raha', 'रही': 'rahi',
  'मेरा': 'mera', 'मेरी': 'meri', 'मेरे': 'mere', 'नहीं': 'nahi', 'नही': 'nahi', 'कर': 'kar', 'से': 'se', 'एक': 'ek',
};

// Keys in NFC so they match normalised input (ढ़ / ड़ decompose under NFC).
const DEVANAGARI: Record<string, string> = Object.fromEntries(Object.entries(DEVANAGARI_RAW).map(([k, v]) => [k.normalize('NFC'), v]));

// Words that carry no meaning for WHAT is needed (English + Hindi/Hinglish fillers).
const STOP = new Set((
  'i im me my mine we us our need needs needed want wants wanted looking look for a an the to of in on at is are am be was ' +
  'please pls plz kindly can could you u get book booking hire call find some any this that it and or with from by near nearby ' +
  'me my mujhe mujhko muje mjhe humein hamein hame hume humko hamko apko aapko chahiye chahie chaiye chaye chahiyee chaahiye ' +
  'karwana karwani karwane karvana karvani karana karani karne karna karni kara karao karwao karwa karva kar kr karo ' +
  'hai hain h he hy ho hoga hogi raha rahi rahe rha rhi rhe ka ki ke ko se mein me mai main par pe ek koi kuch bhi ' +
  'mera meri mere apna apni apne wala wali wale vala vali vale abhi aaj kal jaldi urgent urgently asap today tomorrow ' +
  'ghar home house flat my ka hamara hamari hamare ji bhai sir madam hello hi hey ok okay yes no nahi na'
).split(/\s+/).filter(Boolean));

// Words that describe the KIND of work but not the trade — used to rank services inside a
// category ("AC servicing" → the servicing rows), never to pick the category itself.
const GENERIC = new Set((
  'service services servicing repair repairs repairing fix fixing fitting install installation installing ' +
  'replace replacement work works kaam kam theek thik technician mechanic expert experts professional pro ' +
  'karigar banda aadmi person man guy visit check checkup inspection new naya nayi naye old purana'
).split(/\s+/));

/** All words of the query (Devanagari → Latin), fillers kept — phrases like "ghar banana" need them. */
export function queryWords(raw: string): string[] {
  let s = String(raw || '').normalize('NFC').toLowerCase().slice(0, 200);
  // Devanagari words → Latin (whole words only).
  s = s.replace(/[ऀ-ॿ.]+/g, (w) => DEVANAGARI[w] ?? DEVANAGARI[w.replace(/\.$/, '')] ?? w);
  s = s.replace(/\ba\.?\s?c\.?(?=\s|$)/g, 'ac'); // "a.c", "a c" → ac
  s = s.replace(/[^a-z0-9ऀ-ॿ]+/g, ' ');
  return s.split(' ').filter(Boolean);
}
export function normalizeQuery(raw: string): string[] {
  return queryWords(raw).filter((t) => !STOP.has(t));
}

// ─── Vocabulary: what words mean ────────────────────────────────────────────────────────
// `cat` = stems that identify the category in the CATALOGUE (matched against each active
// category's key, slug and name); `terms` = what customers say. Weight 3 = unambiguous trade
// word, 2 = strong hint, 1 = weak hint (e.g. "leak" fits plumbing AND waterproofing).
interface Concept { id: string; cat: string[]; terms: Array<[string, number]> }
const T = (w: number, list: string): Array<[string, number]> => list.split(',').map((x) => [x.trim(), w] as [string, number]).filter((x) => x[0]);

const CONCEPTS: Concept[] = [
  { id: 'plumbing', cat: ['plumb'], terms: [
    ...T(3, 'plumber,plumbing,plumbers,nalsaz'),
    ...T(2, 'tap,taps,faucet,nal,nalka,tonti,toti,pipe,pipes,pipeline,drain,drainage,nali,blockage,blocked,block,clog,clogged,choke,choked,jam,toilet,flush,commode,washbasin,basin,sink,shower,tanki,water tank,motor,mixer,overflow,sump'),
    ...T(1, 'leak,leaking,leakage,tapak,tapakna,tapak raha,paani,pani,water,bathroom,geyser'),
  ] },
  { id: 'waterproofing', cat: ['waterproof'], terms: [
    ...T(3, 'waterproofing,waterproof,water proofing,seepage,seelan,silan,dampness'),
    ...T(2, 'damp,nami,roof leak,terrace leak,chhat tapak,chhat se paani,wall leak,deewar,crack'),
    ...T(1, 'leak,leaking,leakage,tapak,paani,pani,water,chhat,roof,terrace'),
  ] },
  { id: 'electrical', cat: ['electric'], terms: [
    ...T(3, 'electrician,electrical,electric,bijli,bijliwala,electrition,lineman'),
    ...T(2, 'wiring,wire,switch,switchboard,socket,mcb,fuse,short circuit,tripping,earthing,light,lights,tubelight,bulb,fan,pankha,ceiling fan,exhaust,doorbell,inverter,current,shock,power cut,no power,chandelier,meter'),
  ] },
  { id: 'ac', cat: ['ac', 'aircon', 'airconditioner'], terms: [
    ...T(3, 'ac,aircon,air conditioner,airconditioner,air conditioning,split ac,window ac,cassette,ductable'),
    ...T(2, 'cooling,thanda,thandak,gas filling,gas refill,gas charging,jet service,jet spray,compressor,thandi hawa'),
  ] },
  { id: 'appliance', cat: ['appliance'], terms: [
    ...T(3, 'appliance,appliances,washing machine,fridge,refrigerator,microwave,geyser,water heater,ro,water purifier,purifier,television,tv,home theater,chimney,dishwasher'),
    ...T(1, 'machine,washing'),
  ] },
  { id: 'cleaning', cat: ['clean'], terms: [
    ...T(3, 'cleaning,clean,cleaner,deep cleaning,deep clean,safai,saaf,sanitization,sanitize,housekeeping,jhadu pocha'),
    ...T(1, 'deep,sofa,carpet,mattress,dust'),
  ] },
  { id: 'pest', cat: ['pest'], terms: [
    ...T(3, 'pest,pests,pest control,cockroach,cockroaches,termite,termites,deemak,dimak,bedbug,bedbugs,bed bug,khatmal,fumigation,keede,keeda,keet'),
    ...T(2, 'mosquito,machhar,rat,rats,rodent,chuha,chuhe,lizard,chipkali,ant,ants,cheenti,fly,flies,bird,kabootar'),
  ] },
  { id: 'painting', cat: ['paint'], terms: [
    ...T(3, 'painting,painter,paint,rang,rangai,putai,whitewash,distemper,emulsion,texture'),
    ...T(2, 'putty,polish,wall colour,wall color,colour,color'),
  ] },
  { id: 'carpentry', cat: ['carpent', 'woodwork'], terms: [
    ...T(3, 'carpenter,carpentry,badhai,barhai,carpainter,woodwork,wood work'),
    ...T(2, 'furniture,door,doors,darwaza,darwaja,window,khidki,cupboard,almari,almirah,wardrobe,bed,drawer,hinge,kabza,cabinet,table,chair,lock,latch,plywood,laminate'),
  ] },
  { id: 'interior', cat: ['interior'], terms: [
    ...T(3, 'interior,interiors,interior design,interior designer,home decor,decor'),
  ] },
  { id: 'renovation', cat: ['renovat'], terms: [
    ...T(3, 'renovation,renovate,renovating,remodel,remodeling,remodelling,makeover,revamp,nawinikaran'),
    ...T(1, 'upgrade,retiling,tiling,flooring,tile,tiles'),
  ] },
  { id: 'construction', cat: ['construct', 'civil'], terms: [
    ...T(3, 'construction,constructions,contractor,thekedar,civil work,building construction,makan banana,ghar banana,ghar banwana,makan banwana,new house'),
    ...T(2, 'mistri,raj mistri,mason,plaster,brickwork,slab,foundation,boundary wall,compound wall,naksha,structural'),
  ] },
  { id: 'false-ceiling', cat: ['ceiling'], terms: [...T(3, 'false ceiling,pop ceiling,gypsum ceiling,pop work,pop')] },
  { id: 'fabrication', cat: ['fabricat', 'weld'], terms: [...T(3, 'fabrication,welding,welder,grill,grills,railing,shed,gate')] },
  { id: 'aluminium', cat: ['alumin'], terms: [...T(3, 'aluminium,aluminum,aluminium window,section window')] },
  { id: 'glass', cat: ['glass', 'glazing'], terms: [...T(3, 'glass,glazing,mirror,sheesha,kaanch,kanch')] },
  { id: 'cctv', cat: ['cctv'], terms: [...T(3, 'cctv,camera,cameras,security camera,surveillance,dvr,nvr')] },
  { id: 'solar', cat: ['solar'], terms: [...T(3, 'solar,solar panel,solar panels,solar plant')] },
  { id: 'modular-kitchen', cat: ['modular'], terms: [...T(3, 'modular kitchen,modular')] },
  { id: 'architecture', cat: ['architect'], terms: [...T(3, 'architect,architecture,architectural,building plan,house plan,floor plan')] },
];

// ─── Matching helpers ──────────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
/** Typo tolerance scaled to word length: none under 5 letters ("pest" ≠ "best"), 1 up to 7, 2 above. */
function fuzzyEq(a: string, b: string): boolean {
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  if (len < 5) return false;
  return levenshtein(a, b, len >= 8 ? 2 : 1) <= (len >= 8 ? 2 : 1);
}
const SUFFIXES = ['ician', 'ation', 'ings', 'ical', 'ions', 'ing', 'ers', 'ion', 'age', 'er', 'ed', 'es', 'ic', 'al', 'e', 's'];
function stem(w: string): string {
  for (const x of SUFFIXES) if (w.length - x.length >= 3 && w.endsWith(x)) return w.slice(0, -x.length);
  return w;
}
/** Same word family: "servicing"~"service", "plumber"~"plumbing", "electrician"~"electrical" — but not "contractor"~"control". */
function stemEq(a: string, b: string): boolean {
  if (a === b) return true;
  const ra = stem(a), rb = stem(b);
  if (ra === rb) return true;
  return Math.min(ra.length, rb.length) >= 4 && (ra.startsWith(rb) || rb.startsWith(ra));
}

/** How well a vocabulary term (one or more words) occurs in the query tokens: 1 exact, 0.7 typo, 0. */
function termHit(term: string, tokens: string[], all: string[]): number {
  const words = term.split(' ');
  if (words.length === 1) {
    if (tokens.includes(term)) return 1;
    return tokens.some((t) => fuzzyEq(t, term)) ? 0.7 : 0;
  }
  tokens = all;
  for (let i = 0; i + words.length <= tokens.length; i++) {
    let exact = true, ok = true;
    for (let k = 0; k < words.length; k++) {
      if (tokens[i + k] === words[k]) continue;
      exact = false;
      if (!fuzzyEq(tokens[i + k], words[k])) { ok = false; break; }
    }
    if (ok) return exact ? 1 : 0.7;
  }
  return 0;
}

export function wordsOf(text: string): string[] {
  return String(text || '').toLowerCase().normalize('NFC').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1);
}
function catText(c: DiscoveryCategory): string[] {
  return Array.from(new Set([...wordsOf(c.key), ...wordsOf(c.slug || ''), ...wordsOf(c.name)]));
}
function catMatchesStem(c: DiscoveryCategory, stem: string): boolean {
  return catText(c).some((w) => (stem.length <= 3 ? w === stem : w.startsWith(stem)));
}
export function categoryUrlSlug(c: { key: string; slug?: string | null }): string {
  return (c.slug || c.key).toLowerCase().replace(/_/g, '-');
}

/** A runner-up scoring at least this share of the winner makes the query ambiguous (show choices). */
export const AMBIGUITY_RATIO = 0.85;

// ─── The resolver ──────────────────────────────────────────────────────────────────────

export function discover(query: string, categories: DiscoveryCategory[], services: DiscoveryService[]): DiscoveryResult {
  const all = queryWords(query);
  const tokens = all.filter((t) => !STOP.has(t));
  const meaningful = tokens.filter((t) => !GENERIC.has(t));
  const empty: DiscoveryResult = { query, normalized: tokens, best: null, ambiguous: false, categories: [], services: [], confidence: 0 };
  if (!tokens.length) return empty;

  const score = new Map<string, number>();
  const add = (id: string, v: number) => score.set(id, (score.get(id) || 0) + v);

  // 1. Meaning: vocabulary concepts → the real categories whose key/slug/name carry the stem.
  //    The strongest term counts fully, further terms of the same concept add a little.
  for (const concept of CONCEPTS) {
    const hits = concept.terms.map(([term, w]) => termHit(term, tokens, all) * w).filter((v) => v > 0).sort((a, b) => b - a);
    if (!hits.length) continue;
    const v = hits[0] + hits.slice(1).reduce((s, x) => s + x * 0.25, 0);
    for (const c of categories) if (concept.cat.some((stem) => catMatchesStem(c, stem))) add(c.id, v);
  }

  // 2. Direct: a query word that IS the category's own word ("waterproofing", "renovation").
  for (const c of categories) {
    const words = catText(c).filter((w) => !GENERIC.has(w));
    const n = meaningful.filter((t) => words.includes(t) || (t.length > 2 && words.some((w) => w.length > 2 && (stemEq(t, w) || fuzzyEq(t, w))))).length;
    if (n) add(c.id, 2 * n);
  }

  // 3. Catalogue: services/sub-categories whose own name matches ("tile", "bathroom renovation").
  const svcScores: ServiceMatch[] = [];
  const perCat = new Map<string, number>();
  for (const s of services) {
    const own = wordsOf(s.name), sub = wordsOf(s.subCategoryName || '');
    let v = 0;
    for (const t of tokens) {
      const generic = GENERIC.has(t);
      const w = generic ? 0.6 : 1.5;
      if (own.some((x) => x === t)) v += w;
      else if (own.some((x) => stemEq(t, x) || fuzzyEq(t, x))) v += w * 0.8;
      else if (sub.some((x) => x === t || stemEq(t, x))) v += w * 0.6;
    }
    if (v > 0) {
      svcScores.push({ id: s.id, categoryId: s.categoryId, score: v + (s.isPopular ? 0.1 : 0) });
      const inName = meaningful.filter((t) => own.some((x) => x === t || stemEq(t, x) || fuzzyEq(t, x)) || sub.some((x) => x === t || stemEq(t, x))).length;
      // A service whose name carries EVERY meaningful word ("AC deep cleaning") is decisive.
      const boost = inName ? Math.min(2.5, v * 0.6) + (inName === meaningful.length && inName >= 2 ? 2 : 0) : 0;
      if (boost) perCat.set(s.categoryId, Math.max(perCat.get(s.categoryId) || 0, boost));
    }
  }
  for (const [catId, v] of perCat) add(catId, v);

  // A category with no active service yet ranks lower than one that can actually be booked, but
  // is still offered when it is what was asked for ("false ceiling"). Same-name duplicates collapse.
  const byId = new Map(categories.map((c) => [c.id, c]));
  let ranked = Array.from(score.entries()).map(([id, v]) => ({ c: byId.get(id)!, v: byId.get(id)!.serviceCount > 0 ? v : v * 0.6 }))
    .filter((r) => r.v >= 1)
    .sort((a, b) => b.v - a.v || b.c.serviceCount - a.c.serviceCount);
  const seenName = new Set<string>();
  ranked = ranked.filter((r) => { const n = r.c.name.toLowerCase(); if (seenName.has(n)) return false; seenName.add(n); return true; });
  if (!ranked.length) return empty;

  const top = ranked[0].v;
  const total = ranked.slice(0, 3).reduce((s, r) => s + r.v, 0);
  const matches: CategoryMatch[] = ranked.slice(0, 5).map((r) => ({
    id: r.c.id, key: r.c.key, slug: categoryUrlSlug(r.c), name: r.c.name, score: Math.round(r.v * 100) / 100,
    confidence: Math.round(Math.min(1, r.v / 3) * (r.v / total) * 100) / 100,
    serviceCount: r.c.serviceCount, url: `/services/${categoryUrlSlug(r.c)}`,
  }));
  // Ambiguous: a second category is nearly as good ("paani leak" → Plumbing or Waterproofing).
  const ambiguous = ranked.length > 1 && ranked[1].v >= top * AMBIGUITY_RATIO;
  const best = ambiguous ? null : matches[0];

  const bestCat = best ? best.id : null;
  const servicesOut = svcScores
    .filter((s) => (bestCat ? s.categoryId === bestCat : matches.some((m) => m.id === s.categoryId)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((s) => ({ ...s, score: Math.round(s.score * 100) / 100 }));

  return { query, normalized: tokens, best, ambiguous, categories: matches, services: servicesOut, confidence: best ? best.confidence : 0 };
}

/**
 * /services/<slug> → category. Exact slug or key first (any case, - or _), then the same
 * discovery as search ("plumber", "electrician", "ac-repair", "cleaning"). Returns the match
 * and how it was found; null when nothing fits (the page shows "not found", never a wrong one).
 */
export function resolveCategorySlug(
  slugParam: string, categories: DiscoveryCategory[], services: DiscoveryService[],
): { category: DiscoveryCategory; matchedBy: 'slug' | 'key' | 'alias' } | null {
  const raw = decodeURIComponentSafe(String(slugParam || '')).trim().toLowerCase().slice(0, 100);
  if (!raw) return null;
  const flat = (x: string) => x.toLowerCase().replace(/[_\s]+/g, '-');
  const bySlug = categories.filter((c) => c.slug && flat(c.slug) === flat(raw));
  const pick = (list: DiscoveryCategory[]) => list.sort((a, b) => b.serviceCount - a.serviceCount)[0];
  if (bySlug.length) return { category: pick(bySlug), matchedBy: 'slug' };
  const byKey = categories.filter((c) => flat(c.key) === flat(raw));
  if (byKey.length) return { category: pick(byKey), matchedBy: 'key' };
  const r = discover(raw.replace(/[-_]+/g, ' '), categories, services);
  const hit = r.best || (r.categories[0] && r.categories[0].score >= 2 ? r.categories[0] : null);
  if (!hit) return null;
  const category = categories.find((c) => c.id === hit.id);
  return category ? { category, matchedBy: 'alias' } : null;
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
