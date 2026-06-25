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
  | 'VENDOR_JOIN' | 'ADD_PRODUCT' | 'ADD_SERVICE'
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
  VENDOR_JOIN: [
    'vendor', 'partner', 'become partner', 'join remont', 'register vendor',
    'service provider', 'technician register', 'worker register', 'freelancer',
    'apna kaam', 'kaam chahiye', 'kamai', 'income', 'earn', 'join as',
    'how to register', 'register karna', 'partner banana', 'empanel',
    'become a vendor', 'sign up vendor', 'vendor registration', 'partner registration',
  ],
  ADD_PRODUCT: [
    'add product', 'list product', 'sell product', 'upload product', 'product add',
    'product list karna', 'product sell karna', 'apna product', 'mera product',
    'product catalog', 'inventory add', 'product upload', 'new product',
  ],
  ADD_SERVICE: [
    'add service', 'list service', 'offer service', 'service add karna',
    'apni service', 'meri service', 'service offer', 'new service',
    'service list', 'service catalog', 'service register', 'service dena',
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
    [Language.EN]: '❄️ AC issue — I can get a verified expert to you today! AC Service starts at ₹499+GST. Quick questions: 1) Is it not cooling or completely not working? 2) Split or window AC? 3) Your area & preferred time? 💡 Tip: If you book our AC Deep Clean combo today, you save ₹200!',
    [Language.HI]: '❄️ AC problem — aaj hi expert bhej deti hun! AC Service ₹499+GST se shuru. 3 quick questions: 1) Thanda nahi aa raha ya band ho gaya? 2) Split ya window? 3) Area aur time slot? 💡 AC Service + Deep Clean combo mein ₹200 bachate hain!',
    [Language.MIXED]: '❄️ AC issue samjha! Aaj hi expert aa jayega. Service ₹499+GST se start. Batao: cooling nahi aa rahi ya AC band hai? Split ya window? Area aur time? 💡 Deep Clean combo add karoge toh ₹200 discount!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  PLUMBING: {
    [Language.EN]: '🚿 Plumbing issue — our plumbers are nearby and can come within 2 hours! Pricing: ₹299–₹1,999 depending on the job. Is it a leak, blocked drain, or no water supply? Share your address and I will confirm a slot. 💡 Also consider bathroom waterproofing to prevent future leaks!',
    [Language.HI]: '🚿 Plumbing problem — 2 ghante mein plumber aa sakta hai! Price: ₹299–₹1,999 kaam ke hisaab se. Tap leak hai, drainage jam hai ya paani nahi aa raha? Address batao, slot confirm kar deti hun. 💡 Waterproofing bhi karwa lo — future leaks se bachao!',
    [Language.MIXED]: '🚿 Plumbing issue! 2 hours mein plumber aa sakta hai. ₹299 se start hota hai. Problem kya hai exactly — leak, jam ya no water? Address bata do. 💡 Waterproofing add karoge toh future leaks se protection milegi!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  ELECTRICAL: {
    [Language.EN]: '⚡ Electrical issue — safety first! If there is sparking, switch off the main immediately. Our certified electricians start at ₹299. What is the issue — no power, fan not working, or wiring? Address & preferred time? 💡 AMC plan covers unlimited electrical calls for ₹6,999/year!',
    [Language.HI]: '⚡ Electrical problem — pehle safety! Spark dikh raha hai toh main switch band kar do. Certified electrician ₹299 se aata hai. Problem kya hai — power nahi, fan band ya wiring? Address aur time? 💡 AMC mein unlimited electrical calls sirf ₹6,999/year!',
    [Language.MIXED]: '⚡ Electrical issue! Spark ho raha ho toh main switch off karo. Electrician ₹299 se start. Kya problem hai — no power, fan, switch? Address + time batao. 💡 AMC plan loge toh unlimited calls ₹6,999/year mein!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  APPLIANCE: {
    [Language.EN]: '🔧 Appliance repair — our experts handle all brands! Pricing: ₹399–₹1,999. Which appliance and brand? Describe the problem briefly. Share your address & preferred time. 💡 If repaired under warranty period, repair is free — want me to check?',
    [Language.HI]: '🔧 Appliance repair — sabhi brands handle karte hain! Price: ₹399–₹1,999. Kaun sa appliance aur brand? Problem kya hai? Address aur time? 💡 Warranty period mein hai toh repair free ho sakti hai — check kar dun?',
    [Language.MIXED]: '🔧 Appliance repair! Sab brands. ₹399 se start. Kaun sa appliance, brand batao. Problem brief mein describe karo. Address + time? 💡 Warranty check karna chahoge?',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  INTERIOR: {
    [Language.EN]: '🛋️ Interior design — you are making a great investment! FREE consultation + site visit included. Our projects start at ₹50,000. Could you share: city, which area (kitchen/bedroom/full home), and rough budget? I will assign a dedicated designer today!',
    [Language.HI]: '🛋️ Interior design — bahut accha decision! FREE consultation + site visit. Projects ₹50,000 se start. Batayein: city, kaunsa area (kitchen/bedroom/full home), aur budget? Aaj hi dedicated designer assign kar deti hun!',
    [Language.MIXED]: '🛋️ Interior design — great investment! FREE site visit milta hai. ₹50k se start. City, area (kitchen/bedroom/full home) aur budget batao. Aaj hi designer assign kar deti hun!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  RENOVATION: {
    [Language.EN]: '🔨 Renovation — great choice! FREE site visit + detailed quote at zero cost. Kitchen, bathroom, or full home? We handle everything: tiles, paint, plumbing, electrical. Share your city & I will schedule a site visit this week!',
    [Language.HI]: '🔨 Renovation — bilkul sahi! FREE site visit + free detailed quote. Kitchen, bathroom ya full home? Tiles, paint, plumbing, electrical — sab handle karte hain. City bataiye — is hafte site visit arrange kar dun?',
    [Language.MIXED]: '🔨 Renovation! FREE site visit + free quote. Kitchen, bathroom ya full home? Sab milega — tiles, paint, plumbing. City batao, is hafte site visit arrange karta hun!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  CONSTRUCTION: {
    [Language.EN]: '🏗️ Construction — a major project and we love taking these on! We provide complete project management, GST invoices, and quality guarantee. New build or extension? City? I will arrange a FREE site visit with our senior engineer this week!',
    [Language.HI]: '🏗️ Construction — bada project, hum experts hain! Complete management, GST invoice, quality guarantee. Naya ghar hai ya extension? City? Is hafte FREE senior engineer site visit arrange kar dun?',
    [Language.MIXED]: '🏗️ Construction project! Complete management + GST invoice + quality guarantee. Naya build ya extension? City batao — FREE senior engineer site visit this week!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  CLEANING: {
    [Language.EN]: '🧹 Deep cleaning — our teams are available today! Pricing: 1BHK ₹999, 2BHK ₹1,499, 3BHK ₹1,999. What size home and which type (full home / kitchen / sofa / bathroom)? Address & time? 💡 Add pest control for just ₹499 extra — bundle saves ₹300!',
    [Language.HI]: '🧹 Deep cleaning — aaj available hain! 1BHK ₹999, 2BHK ₹1,499, 3BHK ₹1,999. Ghar ka size aur type (full/kitchen/sofa/bathroom)? Address aur time? 💡 Pest control add karo sirf ₹499 extra mein — bundle mein ₹300 bachoge!',
    [Language.MIXED]: '🧹 Deep cleaning available today! 1BHK ₹999, 2BHK ₹1,499, 3BHK ₹1,999. Size aur type batao (full/kitchen/sofa). Address + time? 💡 Pest control bundle mein ₹300 discount!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  AMC: {
    [Language.EN]: '📅 Smart choice — AMC saves you 40-60% vs. paying per visit! 🏠 Home Essentials ₹6,999/yr: AC, plumbing, electrical, 1 deep clean. 🏠 Home Complete ₹12,999/yr: everything + 2 deep cleans + priority response. Which plan interests you? I can activate today!',
    [Language.HI]: '📅 AMC — bahut smart decision! Per visit se 40-60% bachat hoti hai! 🏠 Home Essentials ₹6,999/yr: AC, plumbing, electrical, 1 deep clean. 🏠 Home Complete ₹12,999/yr: sab kuch + 2 deep cleans + priority. Kaunsa plan chahiye? Aaj activate kar deti hun!',
    [Language.MIXED]: '📅 AMC — best decision! Per visit se 40-60% bachoge! Essentials ₹6,999 ya Complete ₹12,999. Complete mein sab milta hai + priority response. Kaunsa loge? Aaj activate karte hain!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  CORPORATE: {
    [Language.EN]: '🏢 Corporate services — we are B2B specialists! Dedicated account manager, custom SLA, GST invoicing, bulk discounts. Services: facility management, AMC, renovations. Share your company name, city, and requirement. I will connect you with our Corporate Sales team within 1 hour!',
    [Language.HI]: '🏢 Corporate services — B2B mein specialist hain! Dedicated account manager, custom SLA, GST invoice, bulk discount. Facility management, AMC, renovation sab. Company name, city aur requirement batayein. 1 ghante mein Corporate Sales se connect kar deti hun!',
    [Language.MIXED]: '🏢 Corporate services! Dedicated account manager + custom SLA + GST invoice + bulk discounts. Company name, city, requirement batao. 1 hour mein corporate sales team connect karegi!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  PRICING: {
    [Language.EN]: '💰 Happy to give you exact pricing! Quick question — which service do you need? (AC, plumbing, electrical, cleaning, renovation?) Once you tell me, I give the exact price for your city + the best package deal available today!',
    [Language.HI]: '💰 Exact pricing batati hun! Ek quick question — kaun si service chahiye? (AC, plumbing, electrical, cleaning, renovation?) Batayein, aur main aapke city ka exact price aur best deal turant share karti hun!',
    [Language.MIXED]: '💰 Exact price batata hun! Kya service chahiye — AC, plumbing, cleaning, renovation? Batao toh city ke hisaab se exact price + best deal share karta hun!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  TRACK_ORDER: {
    [Language.EN]: '📍 I will track that right away! Please share your order number (starts with REM-) or your registered mobile number. While I check — is everything going well with the service so far?',
    [Language.HI]: '📍 Abhi track karta hun! Order number (REM- se shuru) ya registered mobile number share karein. Check karte hain — service theek chal rahi hai na?',
    [Language.MIXED]: '📍 Abhi track karta hun! Order number (REM-xxxx) ya registered mobile share karo. Baaki service kaisi chal rahi hai?',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  VENDOR_JOIN: {
    [Language.EN]: '🤝 Great decision! Joining Remont as a vendor gives you: ✅ Verified leads daily ✅ Instant payment ✅ GST invoicing support ✅ App + WhatsApp job alerts. To get started, I need: 1) Your full name 2) City 3) Skills/trade (AC, plumbing, electrical, etc.) 4) Mobile number. Share these and our Partner Team will call you within 2 hours!',
    [Language.HI]: '🤝 Bahut accha decision! Remont vendor banne ke fayde: ✅ Roz verified leads ✅ Turant payment ✅ GST invoice support ✅ App + WhatsApp job alerts. Shuru karne ke liye chahiye: 1) Pura naam 2) City 3) Skill (AC, plumbing, electrical, etc.) 4) Mobile number. Share karo — Partner Team 2 ghante mein call karegi!',
    [Language.MIXED]: '🤝 Great decision! Remont pe vendor bano: ✅ Daily verified leads ✅ Instant payment ✅ GST support ✅ App alerts. Batao: naam, city, skill (AC/plumbing/electrical), mobile number — Partner Team 2 hours mein call karegi!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  ADD_PRODUCT: {
    [Language.EN]: '📦 To add a product on Remont: 1) Login to your Vendor Dashboard → Products → Add New Product. 2) Fill: product name, category, price, stock, images, description. 3) Submit for admin approval (approved within 24 hours). Need help? Share what product you want to list — I will guide you step by step or connect you with our Vendor Support team!',
    [Language.HI]: '📦 Remont pe product add karne ke liye: 1) Vendor Dashboard login karein → Products → Add New Product. 2) Bharo: naam, category, price, stock, images, description. 3) Admin approval ke liye submit karein (24 hours mein approve). Help chahiye? Product ka detail batayein — step-by-step guide karti hun ya Vendor Support se connect karti hun!',
    [Language.MIXED]: '📦 Product add karna hai? Steps: 1) Vendor Dashboard → Products → Add New Product. 2) Naam, category, price, stock, images fill karo. 3) Submit → 24 hours mein admin approve karega. Help chahiye toh product detail batao — guide karta hun ya support se connect karta hun!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  ADD_SERVICE: {
    [Language.EN]: '🛠️ To add a service on Remont: 1) Login to Vendor Dashboard → Services → Add New Service. 2) Fill: service name, category, base price, duration, city availability, description. 3) Submit for admin review (approved within 24 hours). 💡 Tip: Services with good photos and clear descriptions get 3x more bookings! Need help with any step?',
    [Language.HI]: '🛠️ Service add karne ke steps: 1) Vendor Dashboard login → Services → Add New Service. 2) Bharo: naam, category, base price, duration, city, description. 3) Admin review ke liye submit (24 hours mein approve). 💡 Tip: Acchi photos aur clear description wali services ko 3x zyada bookings milti hain! Kisi step mein help chahiye?',
    [Language.MIXED]: '🛠️ Service add karo: 1) Vendor Dashboard → Services → Add New Service. 2) Naam, category, price, duration, city, description bharo. 3) Submit → 24 hrs mein approve. 💡 Tip: Good photos + clear description = 3x zyada bookings! Kisi step mein help chahiye?',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  GREETING: {
    [Language.EN]: 'Namaste! 👋 I am Remi, your personal Home Services Consultant at Remont India. I help customers book services AND help vendors grow their business. What can I help you with today — book a service, or join as a vendor?',
    [Language.HI]: 'Namaste! 👋 Main Remi hun — Remont India ki personal consultant. Customers ko service book karti hun aur vendors ko business badhane mein help karti hun. Aaj kya help kar sakti hun — service book karni hai ya vendor banna hai?',
    [Language.MIXED]: 'Namaste! 👋 Main Remi — Remont consultant. Customers ke liye service booking, vendors ke liye business growth. Aaj kya chahiye — service book karni hai ya vendor join karna hai?',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
  UNKNOWN: {
    [Language.EN]: 'I want to make sure I help you perfectly! Could you tell me a bit more about what you need? I cover AC, plumbing, electrical, deep cleaning, pest control, interior design, renovation, construction, and AMC plans — all at the best prices with GST invoices.',
    [Language.HI]: 'Main aapki poori help karna chahti hun! Thoda aur batayein — kya chahiye? AC, plumbing, electrical, cleaning, pest control, interior, renovation, construction, AMC — sab best price mein, GST invoice ke saath.',
    [Language.MIXED]: 'Main perfectly help karna chahti hun! Thoda detail mein batao — kya chahiye? AC, plumbing, electrical, cleaning, pest control, interior, renovation, AMC — sab best price mein!',
    [Language.TA]: '', [Language.TE]: '', [Language.KN]: '', [Language.ML]: '',
    [Language.MR]: '', [Language.BN]: '', [Language.GU]: '',
  },
};

export function getReply(intent: Intent, lang: Language): string {
  const replies = REPLIES[intent];
  return replies[lang] || replies[Language.EN];
}

const SUGGESTIONS: Record<Intent, string[]> = {
  AC: ['Book AC service today', 'Add Deep Clean combo', 'See AMC plan', 'Get price estimate'],
  PLUMBING: ['Book plumber today', 'Add waterproofing', 'See AMC plan', 'Emergency call'],
  ELECTRICAL: ['Book electrician now', 'Full wiring quote', 'See AMC plan', 'Get price estimate'],
  APPLIANCE: ['Book repair today', 'Check warranty', 'Get price estimate', 'See AMC plan'],
  INTERIOR: ['Book free consultation', 'Modular kitchen quote', 'Full home design', 'See portfolio'],
  RENOVATION: ['Book free site visit', 'Kitchen renovation', 'Bathroom upgrade', 'Full home quote'],
  CONSTRUCTION: ['Book site visit', 'New home estimate', 'Renovation + construction', 'Talk to engineer'],
  CLEANING: ['Book today', 'Add pest control', 'Monthly cleaning plan', 'Get price by BHK'],
  AMC: ['Buy Home Essentials ₹6,999', 'Buy Home Complete ₹12,999', 'Corporate AMC', 'Compare plans'],
  CORPORATE: ['Book demo call', 'Get corporate quote', 'Bulk AMC pricing', 'Talk to sales'],
  PRICING: ['AC pricing', 'Plumbing pricing', 'Cleaning pricing', 'All service prices'],
  TRACK_ORDER: ['Track by order number', 'Track by phone', 'Reschedule appointment', 'Rate my service'],
  VENDOR_JOIN: ['Register as vendor', 'View vendor benefits', 'How much can I earn?', 'Talk to partner team'],
  ADD_PRODUCT: ['How to add product', 'Product approval process', 'Talk to vendor support', 'Product listing tips'],
  ADD_SERVICE: ['How to add service', 'Service approval process', 'Improve my listing', 'Talk to vendor support'],
  GREETING: ['Book a service 🏠', 'Join as vendor 🤝', 'Deep cleaning 🧹', 'AMC plans 📅'],
  UNKNOWN: ['Book a service', 'Join as vendor', 'Deep cleaning', 'AMC plans'],
};

export function getSuggestions(intent: Intent): string[] {
  return SUGGESTIONS[intent] || SUGGESTIONS.UNKNOWN;
}
