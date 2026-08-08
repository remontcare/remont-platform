/* ══════════════════════════════════════════════════════════════════════════
   REMONT INDIA — INTERIOR DESIGN PAGE CONFIG
   Single source of truth for every price, label, service-type, and
   integration key shown on /interior. Edit THIS file to change prices or
   reclassify a service — interior.html renders its Services / Consultancy /
   Packages tabs and the AI Studio price straight from this object (see
   service-page.js -> renderFromConfig()).

   Future pages (renovation, architecture, construction, painting) get their
   own config file with the same shape and reuse the same renderer.
   ══════════════════════════════════════════════════════════════════════════ */
window.INTERIOR_CONFIG = {
  category: 'interior',
  whatsapp: '919232071064',
  supportPhone: '+919876543210',

  /* ── serviceType: 'digital' | 'onsite' —
     digital  = deliverable is produced remotely, buyable from anywhere, no
                city check ever runs for it.
     onsite   = requires a professional physically present, so booking checks
                the live serviceable-city data (see RemontCity in
                service-page.js, backed by the real GET /api/v1/cities) before
                sending the customer into the booking flow. If the city isn't
                live yet for that service, the customer never gets blocked —
                they see the lead-capture panel instead (see RemontLead).

     categoryKey (onsite items only) — must match a key inside a city's
     `activeServiceKeys` array as returned by GET /api/v1/cities. This is
     what makes availability admin-configurable: whoever manages the Cities
     table controls activeVendors / activeServiceKeys per city, and this page
     picks that up automatically on every load — nothing here is hardcoded
     per city. ── */
  services: {
    residential: [
      { icon: '🏠', name: 'Full Home Interior', priceLabel: 'from ₹2,00,000', slug: 'full-home-interior', serviceType: 'onsite', categoryKey: 'interior' },
      { icon: '🍳', name: 'Modular Kitchen',     priceLabel: 'from ₹1,20,000', slug: 'modular-kitchen',    serviceType: 'onsite', categoryKey: 'modular-kitchen' },
      { icon: '🛏️', name: 'Bedroom Interior',     priceLabel: 'from ₹85,000',   slug: 'bedroom-interior',   serviceType: 'onsite', categoryKey: 'interior' },
      { icon: '🛋️', name: 'Living Room',          priceLabel: 'from ₹95,000',   slug: 'living-room',        serviceType: 'onsite', categoryKey: 'interior' },
      { icon: '🚪', name: 'Wardrobe',             priceLabel: 'from ₹45,000',   slug: 'wardrobe',           serviceType: 'onsite', categoryKey: 'interior' },
      { icon: '📺', name: 'TV Unit',              priceLabel: 'from ₹25,000',   slug: 'tv-unit',            serviceType: 'onsite', categoryKey: 'interior' },
      { icon: '⬛', name: 'False Ceiling',        priceLabel: 'from ₹18,000',   slug: 'false-ceiling',      serviceType: 'onsite', categoryKey: 'false-ceiling' },
      { icon: '🚿', name: 'Bathroom Interior',    priceLabel: 'from ₹60,000',   slug: 'bathroom-interior',  serviceType: 'onsite', categoryKey: 'interior' },
    ],
    commercial: [
      { icon: '🏢', name: 'Office Interior',      priceLabel: 'from ₹3,50,000', slug: 'office-interior',     serviceType: 'onsite', categoryKey: 'commercial' },
      { icon: '🏬', name: 'Commercial Interior',  priceLabel: 'from ₹5,00,000', slug: 'commercial-interior', serviceType: 'onsite', categoryKey: 'commercial' },
    ],
  },

  consultancy: {
    consultation: [
      { icon: '💻', name: 'Online Consultation',   priceLabel: '₹499 / 45 min', slug: 'online-consultation',  serviceType: 'digital' },
      { icon: '🏠', name: 'Home Visit',             priceLabel: '₹999 / visit',  slug: 'home-visit',           serviceType: 'onsite', categoryKey: 'interior' },
      { icon: '🧱', name: 'Material Consultation',  priceLabel: '₹799',          slug: 'material-consultation', serviceType: 'digital' },
      { icon: '💰', name: 'Budget Planning',        priceLabel: '₹599',          slug: 'budget-planning',      serviceType: 'digital' },
    ],
    deliverables: [
      { icon: '📐', name: '2D Floor Plan',   priceLabel: 'from ₹4,999',        slug: '2d-floor-plan',   serviceType: 'digital' },
      { icon: '🧊', name: '3D Design',       priceLabel: 'from ₹9,999 / room', slug: '3d-design',       serviceType: 'digital' },
      { icon: '🏗️', name: 'Elevation Design', priceLabel: 'from ₹7,999',       slug: 'elevation-design', serviceType: 'digital' },
      { icon: '🗺️', name: 'Space Planning',  priceLabel: 'from ₹2,999',        slug: 'space-planning',  serviceType: 'digital' },
    ],
  },

  packages: [
    { id: 'basic', name: 'Basic', priceLabel: '₹4,999', featured: false, serviceType: 'digital',
      bullets: ['2D layout plan', '1 consultation call', 'Material shopping list'] },
    { id: 'standard', name: 'Standard', priceLabel: '₹14,999', featured: true, serviceType: 'digital',
      bullets: ['Everything in Basic', 'Full 3D design', 'Material & colour suggestions', '2 revisions'] },
    { id: 'premium', name: 'Premium', priceLabel: '₹29,999', featured: false, serviceType: 'digital',
      bullets: ['Everything in Standard', '3D walkthrough video', 'Detailed BOQ', 'Unlimited revisions'] },
    { id: 'complete-interior', name: 'Complete Interior', priceLabel: '₹2,00,000', featured: false, serviceType: 'onsite', categoryKey: 'interior',
      bullets: ['Full design + execution', 'Dedicated project manager', 'Turnkey delivery', '10-year structural warranty'] },
  ],

  // AI Design Studio is entirely digital (PAN-India/worldwide) — no city check
  // is ever applied to it; see initAiStudioUi() in service-page.js.
  aiStudio: {
    priceAmount: 19,
    priceLabel: '₹19',
    packLabel: '₹49 for 3 designs',
    styles: ['Modern', 'Minimal', 'Luxury', 'Traditional'],
    wallColours: ['Warm White', 'Beige', 'Sage', 'Charcoal', 'Blue'],
  },

  /* ── Customer journey — "Just Exploring" (self-planning) vs "Ready to
     Build" (designer matching) paths shown in the new journey selector
     section. Pure addition — none of the existing tabs read from this. ── */
  journey: {
    budgetEstimator: {
      // priceAnchorSlug must match a slug in services.residential/commercial
      // above — the estimator reads that item's priceLabel as its base.
      spaceOptions: [
        { label: 'Full Home', priceAnchorSlug: 'full-home-interior' },
        { label: 'Modular Kitchen', priceAnchorSlug: 'modular-kitchen' },
        { label: 'Bedroom', priceAnchorSlug: 'bedroom-interior' },
        { label: 'Living Room', priceAnchorSlug: 'living-room' },
        { label: 'Bathroom', priceAnchorSlug: 'bathroom-interior' },
        { label: 'Office', priceAnchorSlug: 'office-interior' },
      ],
      sizeTiers: [
        { label: 'Compact', multiplier: 0.8 },
        { label: 'Standard', multiplier: 1 },
        { label: 'Large', multiplier: 1.4 },
      ],
      finishTiers: [
        { label: 'Essential', multiplier: 0.85 },
        { label: 'Premium', multiplier: 1 },
        { label: 'Luxury', multiplier: 1.6 },
      ],
    },
    // Style inspiration gallery — clicking an image jumps into the (already
    // built) AI Design Studio tab with that style pre-selected.
    inspiration: [
      { style: 'Modern', img: 'https://images.unsplash.com/photo-1615873968403-89e068629265?w=500&q=75' },
      { style: 'Minimal', img: 'https://images.unsplash.com/photo-1613545325278-f24b0cae1224?w=500&q=75' },
      { style: 'Luxury', img: 'https://images.unsplash.com/photo-1616594039964-ae9021a400a0?w=500&q=75' },
      { style: 'Traditional', img: 'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=500&q=75' },
    ],
    // Budget-conscious designer matching — these are Remont's own in-house,
    // background-verified designers (same "Verified Designers" promise as
    // the Why Choose section below), not an external/unaffiliated
    // marketplace — matches how the rest of this page already talks about
    // "your dedicated designer".
    designers: [
      { id: 'd1', name: 'Studio Verve', avatar: '🎨', style: 'Modern', budgetTier: 'Budget', city: 'Bhopal', rating: '4.9', quoteLabel: 'from ₹1.6L', timelineWeeks: 5 },
      { id: 'd2', name: 'Casa Interiors', avatar: '🏡', style: 'Traditional', budgetTier: 'Mid-range', city: 'Bhopal', rating: '4.8', quoteLabel: 'from ₹2.4L', timelineWeeks: 7 },
      { id: 'd3', name: 'Minimal Co.', avatar: '⬜', style: 'Minimal', budgetTier: 'Budget', city: 'Indore', rating: '4.7', quoteLabel: 'from ₹1.4L', timelineWeeks: 4 },
      { id: 'd4', name: 'Luxe Design House', avatar: '✨', style: 'Luxury', budgetTier: 'Premium', city: 'Indore', rating: '5.0', quoteLabel: 'from ₹4.5L', timelineWeeks: 9 },
    ],
    // Optional add-on off the designer-matching path.
    kitchenBrands: [
      { name: 'HomeLane Modular', priceLabel: 'from ₹95,000' },
      { name: 'Livspace Select', priceLabel: 'from ₹1,10,000' },
      { name: 'Sleek Kitchens', priceLabel: 'from ₹1,35,000' },
      { name: 'Godrej Interio', priceLabel: 'from ₹90,000' },
    ],
  },

  /* ── Integrations — swap these to go live. Nothing in interior.html or
     service-page.js needs to change: every CTA already calls RemontCTA.*,
     RemontCity.*, RemontLead.*, or RemontAI.*, which all read their behavior
     from here. ── */
  integrations: {
    booking: {
      // The real, already-live Remont booking flow (frontend/booking.html).
      // It reads ?service=<slug> and ?city=<name|id> and pre-selects them;
      // unmatched slugs just fall through to manual selection, so every
      // slug above is a safe forward-compatible hint, not a hard dependency.
      baseUrl: '/booking',
      live: true,
    },
    cities: {
      // Real, already-live endpoint (same one the homepage's city modal uses).
      // Returns each city's isActive / activeVendors / activeServiceKeys —
      // that's the actual admin-configurable source of truth for onsite
      // availability. Nothing about city rollout is hardcoded on this page.
      endpoint: '/api/v1/cities',
      live: true,
    },
    leads: {
      // Real, already-live public endpoint backing the CRM (frontend/crm.html)
      // — the same one used by the AI chat / WhatsApp bot lead capture.
      captureEndpoint: '/api/v1/crm/leads/capture',
      source: 'WEBSITE',
      live: true,
    },
    payment: {
      provider: 'razorpay',
      mode: 'mock',       // 'mock' | 'live' — see README before flipping this
      keyId: null,        // set to your real Razorpay key id to go live
      createOrderEndpoint: '/api/v1/payments/create-order',
    },
    ai: {
      provider: null,     // e.g. 'nano-banana' | 'stability' | 'gemini-image'
      mode: 'mock',        // 'mock' | 'live'
      generateEndpoint: '/api/v1/interior/ai-design/generate',
      storage: { autoDeleteDays: 30 },
    },
  },
};
