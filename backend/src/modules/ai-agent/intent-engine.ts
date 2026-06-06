import { Language } from '@prisma/client';

/**
 * REMONT INDIA — RULE-BASED INTENT ENGINE
 *
 * Multilingual (English / Hindi / Hinglish) keyword routing for AI chat.
 * Designed to be swappable for OpenAI/Anthropic LLM later — just replace
 * `detectIntent` to call an external API while keeping the same interface.
 */

export type Intent =
  | 'AC' | 'PLUMBING' | 'ELECTRICAL' | 'APPLIANCE'
  | 'INTERIOR' | 'RENOVATION' | 'CONSTRUCTION' | 'CLEANING'
  | 'AMC' | 'CORPORATE' | 'PRICING' | 'TRACK_ORDER'
  | 'GREETING' | 'UNKNOWN';

const KEYWORDS: Record<Intent, string[]> = {
  AC: [
    'ac', 'air conditioner', 'cooling', 'thanda', 'thandi', 'thandaa',
    'gas refill', 'split ac', 'window ac', 'inverter', 'cool nahi', 'cooling nahi',
    'cold nahi', 'compressor', 'condenser', 'remote', 'temperature',
  ],
  PLUMBING: [
    'plumbing', 'plumber', 'tap', 'nal', 'leak', 'leakage', 'tapakti', 'tapak',
    'pipe', 'paani', 'water', 'tank', 'toilet', 'wc', 'flush', 'basin',
    'sink', 'drainage', 'drain', 'choked', 'jam', 'overflow', 'shower',
  ],
  ELECTRICAL: [
    'electric', 'electrical', 'electrician', 'wiring', 'switch', 'socket',
    'bulb', 'light', 'fan', 'mcb', 'short circuit', 'spark', 'shock',
    'bijli', 'current', 'fuse', 'inverter', 'ups', 'meter',
  ],
  APPLIANCE: [
    'appliance', 'fridge', 'refrigerator', 'tv', 'television', 'washing machine',
    'kapde dhone', 'microwave', 'oven', 'water purifier', 'ro', 'geyser',
    'water heater', 'chimney', 'mixer', 'grinder',
  ],
  INTERIOR: [
    'interior', 'design', 'designer', 'modular kitchen', 'kitchen design',
    'wardrobe', 'almari', 'furniture', 'sofa', 'curtain', 'wallpaper',
    'false ceiling', 'pop', 'paneling',
  ],
  RENOVATION: [
    'renovation', 'renovate', 'remodel', 'paint', 'painting', 'putty',
    'wall paint', 'flooring', 'tile', 'marble', 'kitchen renovation',
    'bathroom renovation', 'home renovation', 'naveen', 'naya',
  ],
  CONSTRUCTION: [
    'construction', 'construct', 'build', 'building', 'naya ghar', 'new home',
    'site visit', 'civil work', 'structure', 'masonry', 'mistry',
    'foundation', 'beam', 'column', 'slab',
  ],
  CLEANING: [
    'cleaning', 'clean', 'deep clean', 'safai', 'saaf', 'dust', 'dhool',
    'bathroom clean', 'kitchen clean', 'sofa clean', 'carpet', 'tiles clean',
    'shower clean', 'jharu', 'pochha',
  ],
  AMC: [
    'amc', 'annual', 'maintenance', 'contract', 'subscription', 'yearly plan',
    'salana', 'plan', 'rakhrakhao',
  ],
  CORPORATE: [
    'corporate', 'office', 'business', 'company', 'b2b', 'facility',
    'workplace', 'enterprise', 'commercial',
  ],
  PRICING: [
    'price', 'cost', 'rate', 'kitna', 'kitne ka', 'paisa', 'rupee',
    'rs', '₹', 'charges', 'fee', 'kharcha',
  ],
  TRACK_ORDER: [
    'track', 'status', 'where', 'kahan hai', 'kab aayega', 'eta',
    'order number', 'booking', 'pending',
  ],
  GREETING: [
    'hi', 'hello', 'hey', 'namaste', 'namaskar', 'good morning',
    'good evening', 'hii', 'helo',
  ],
  UNKNOWN: [],
};

const HINDI_REGEX = /[\u0900-\u097F]/;
const HINGLISH_HINTS = [
  'hai', 'hain', 'nahi', 'kya', 'kaise', 'kab', 'kahan', 'mein', 'main',
  'aap', 'tum', 'mera', 'mujhe', 'humein', 'wala', 'wali', 'thoda', 'jaldi',
  'abhi', 'baad', 'pehle',
];

export function detectLanguage(text: string): Language {
  if (HINDI_REGEX.test(text)) return Language.HI;
  const lower = text.toLowerCase();
  const hits = HINGLISH_HINTS.filter((h) => new RegExp(`\\b${h}\\b`).test(lower));
  if (hits.length >= 2) return Language.MIXED;
  return Language.EN;
}

/** Main intent detection — swap this function for LLM calls later */
export function detectIntent(text: string): { intent: Intent; confidence: number } {
  const lower = text.toLowerCase();
  let best: { intent: Intent; score: number } = { intent: 'UNKNOWN', score: 0 };

  for (const [intent, keywords] of Object.entries(KEYWORDS)) {
    if (intent === 'UNKNOWN') continue;
    let score = 0;
    for (const kw of keywords) {
      // Exact word match scores higher than partial
      if (new RegExp(`\\b${kw}\\b`).test(lower)) score += 2;
      else if (lower.includes(kw)) score += 1;
    }
    if (score > best.score) best = { intent: intent as Intent, score };
  }
  return {
    intent: best.intent,
    confidence: Math.min(best.score / 4, 1.0),
  };
}

const REPLIES: Record<Intent, Record<Language, string>> = {
  AC: {
    [Language.EN]: '❄️ AC issue, got it. I can dispatch a verified AC technician today. Could you share your area and a preferred time slot?',
    [Language.HI]: '❄️ AC ki problem samajh gayi. Aaj hi expert technician bhej deti hun. Aap ka area aur time slot bataiye?',
    [Language.MIXED]: '❄️ AC issue samjha! Today main expert bhej dungi. Area aur time slot share karo.',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  PLUMBING: {
    [Language.EN]: '🚿 Plumbing problem noted. We have plumbers nearby. Could you describe the issue (leak / no water / drainage) and your address?',
    [Language.HI]: '🚿 Plumbing samasya samajh gayi. Aas-paas mein plumber available hain. Problem ki detail aur address?',
    [Language.MIXED]: '🚿 Plumbing issue noted. Aapke aas-paas plumber hain. Problem detail and address bata do.',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  ELECTRICAL: {
    [Language.EN]: '⚡ Electrical issue, understood. Safety first — please switch off the main if there is sparking. Your area and time slot?',
    [Language.HI]: '⚡ Electrical problem samjhi. Spark ya aag dikhe toh main switch band karein. Area aur time?',
    [Language.MIXED]: '⚡ Electrical samjha! Spark ho raha hai toh main switch band kar do. Area + slot?',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  APPLIANCE: {
    [Language.EN]: '🔧 Appliance repair, got it. Which brand and model? Could you describe the issue and share your address?',
    [Language.HI]: '🔧 Appliance repair samajh gayi. Brand aur model batayein. Problem kya hai aur address?',
    [Language.MIXED]: '🔧 Appliance repair noted! Brand-model batao, problem detail aur address share karo.',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  INTERIOR: {
    [Language.EN]: '🛋️ Interior design — exciting! Our premium designers offer free consultations. Could you share your city, room size, and budget range?',
    [Language.HI]: '🛋️ Interior design ka kaam! Free consultation milegi. City, room size aur budget bataiye?',
    [Language.MIXED]: '🛋️ Interior design — wow! Free site visit milta hai. City, room size aur budget batao.',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  RENOVATION: {
    [Language.EN]: '🔨 Renovation project — happy to help. We offer a free site visit. Share your city and what you want renovated (kitchen / bathroom / full home)?',
    [Language.HI]: '🔨 Renovation ka project! Free site visit denge. City aur kya renovate karna hai (kitchen/bathroom/full home)?',
    [Language.MIXED]: '🔨 Renovation project — free site visit available! City aur kya renovate karna hai batao.',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  CONSTRUCTION: {
    [Language.EN]: '🏗️ Construction — a big project! We provide end-to-end project management. Could you share your city and the scope (new build / extension)?',
    [Language.HI]: '🏗️ Construction — bada project! End-to-end management karte hain. City aur scope (naya/extension)?',
    [Language.MIXED]: '🏗️ Construction project — end-to-end management! City aur scope batao (naya banana hai ya extension).',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  CLEANING: {
    [Language.EN]: '🧹 Deep cleaning, got it. What type (home / sofa / bathroom / kitchen)? Share your address and preferred slot.',
    [Language.HI]: '🧹 Cleaning samajh gayi. Kis cheez ki (ghar/sofa/bathroom/kitchen)? Address aur time?',
    [Language.MIXED]: '🧹 Cleaning noted! Type bata do (home/sofa/bathroom/kitchen), address aur slot share karo.',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  AMC: {
    [Language.EN]: '📅 AMC plans — great choice! We have Home Essentials (₹6,999/yr), Home Complete (₹12,999/yr), and Corporate plans. Which fits you?',
    [Language.HI]: '📅 AMC plans — accha choice! Home Essentials (₹6,999/yr), Home Complete (₹12,999/yr), aur Corporate plan hain. Kaunsa chahiye?',
    [Language.MIXED]: '📅 AMC plans available! Home Essentials, Home Complete, Corporate — kaunsa suitable hai bata do.',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  CORPORATE: {
    [Language.EN]: '🏢 Corporate services — perfect. We offer dedicated B2B portals, AMC plans, and SLA-backed support. Share your company name and contact?',
    [Language.HI]: '🏢 Corporate services. B2B portal, AMC plans, SLA support available. Company name aur contact bataiye?',
    [Language.MIXED]: '🏢 Corporate services — B2B portal + AMC + SLA support! Company name aur contact share karo.',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  PRICING: {
    [Language.EN]: '💰 Pricing varies by service and city. Could you tell me what service you need? I will give exact pricing.',
    [Language.HI]: '💰 Pricing service aur city pe depend karti hai. Kaun si service chahiye? Exact price bata dungi.',
    [Language.MIXED]: '💰 Pricing depends on service + city. Kya service chahiye batao, exact price bata dungi.',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  TRACK_ORDER: {
    [Language.EN]: '📍 Sure! Could you share your order number (starts with REM-) or registered phone number?',
    [Language.HI]: '📍 Zaroor! Order number (REM- se start) ya registered phone number share karein.',
    [Language.MIXED]: '📍 Order track karna hai? Order number (REM-xxxx) ya phone number share karo.',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  GREETING: {
    [Language.EN]: 'Namaste! 👋 I am Remi, your Remont assistant. Tell me your problem — I will book the right expert instantly.',
    [Language.HI]: 'Namaste! 👋 Main Remi hun, Remont ki assistant. Aapki problem bataiye — best expert turant book kar dungi.',
    [Language.MIXED]: 'Namaste! 👋 Main Remi — Remont assistant. Problem batao, best expert turant book kar dungi.',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  UNKNOWN: {
    [Language.EN]: 'Could you tell me a bit more? I can help with AC, plumbing, electrical, cleaning, interior design, renovation, construction, AMC, and corporate services.',
    [Language.HI]: 'Thodi aur detail batayein. Main AC, plumbing, electrical, cleaning, interior, renovation, construction, AMC mein help kar sakti hun.',
    [Language.MIXED]: 'Thoda detail mein batao. Main AC, plumbing, electrical, cleaning, interior, renovation, construction, AMC services mein help kar sakti hun.',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
};

export function getReply(intent: Intent, lang: Language): string {
  const replies = REPLIES[intent];
  return replies[lang] || replies[Language.EN];
}

const SUGGESTIONS: Record<Intent, string[]> = {
  AC: ['Today 3-5 PM', 'Today 6-8 PM', 'Tomorrow morning'],
  PLUMBING: ['Tap leaking', 'No water', 'Drainage blocked'],
  ELECTRICAL: ['No power', 'Switch broken', 'Fan not working'],
  APPLIANCE: ['Fridge not cooling', 'Washing machine', 'Geyser issue'],
  INTERIOR: ['Modular kitchen', 'Full home', 'Just one room'],
  RENOVATION: ['Kitchen renovation', 'Bathroom renovation', 'Full home'],
  CONSTRUCTION: ['New home', 'Extension', 'Site visit'],
  CLEANING: ['Home deep clean', 'Sofa cleaning', 'Bathroom deep clean'],
  AMC: ['Home Essentials ₹6,999', 'Home Complete ₹12,999', 'Corporate plan'],
  CORPORATE: ['Schedule a demo', 'Talk to sales', 'View AMC plans'],
  PRICING: ['AC service prices', 'Plumbing prices', 'Cleaning prices'],
  TRACK_ORDER: ['My latest order', 'All active orders'],
  GREETING: ['Book AC service', 'Plumbing problem', 'Need cleaning', 'AMC plans'],
  UNKNOWN: ['AC repair', 'Plumbing', 'Cleaning', 'Renovation'],
};

export function getSuggestions(intent: Intent): string[] {
  return SUGGESTIONS[intent] || SUGGESTIONS.UNKNOWN;
}
