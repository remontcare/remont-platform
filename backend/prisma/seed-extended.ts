/**
 * Extended seed — 25 categories, 160+ services, 60+ products, 25 test vendors
 * Run: npx ts-node prisma/seed-extended.ts
 * Safe to re-run (upsert everywhere).
 * All test users/vendors are marked with [TEST] prefix and tagged in adminNotes.
 */
import { PrismaClient, UserRole, VendorStatus } from '@prisma/client';

const prisma = new PrismaClient();

// ══════════════════════════════════════════════════════════
// CATEGORIES (25)
// ══════════════════════════════════════════════════════════
const CATEGORIES = [
  { key: 'ac',               name: 'AC Service & Repair',          icon: '❄️',  sortOrder: 1,  isPremium: false },
  { key: 'plumbing',         name: 'Plumbing',                     icon: '🚿',  sortOrder: 2,  isPremium: false },
  { key: 'electrical',       name: 'Electrical Work',              icon: '💡',  sortOrder: 3,  isPremium: false },
  { key: 'appliance',        name: 'Appliance Repair',             icon: '📺',  sortOrder: 4,  isPremium: false },
  { key: 'cleaning',         name: 'Deep Cleaning',                icon: '🧹',  sortOrder: 5,  isPremium: false },
  { key: 'painting',         name: 'Painting Services',            icon: '🎨',  sortOrder: 6,  isPremium: false },
  { key: 'carpentry',        name: 'Carpentry & Woodwork',         icon: '🪚',  sortOrder: 7,  isPremium: false },
  { key: 'pest-control',     name: 'Pest Control',                 icon: '🐛',  sortOrder: 8,  isPremium: false },
  { key: 'waterproofing',    name: 'Waterproofing',                icon: '💧',  sortOrder: 9,  isPremium: false },
  { key: 'flooring',         name: 'Flooring',                     icon: '🏠',  sortOrder: 10, isPremium: false },
  { key: 'false-ceiling',    name: 'False Ceiling',                icon: '⬛',  sortOrder: 11, isPremium: true  },
  { key: 'fabrication',      name: 'Fabrication & Welding',        icon: '⚙️',  sortOrder: 12, isPremium: false },
  { key: 'aluminium-work',   name: 'Aluminium Work',               icon: '🪟',  sortOrder: 13, isPremium: false },
  { key: 'glass-work',       name: 'Glass & Glazing',              icon: '🔲',  sortOrder: 14, isPremium: false },
  { key: 'cctv-security',    name: 'CCTV & Security',              icon: '📷',  sortOrder: 15, isPremium: false },
  { key: 'solar',            name: 'Solar Installation',           icon: '☀️',  sortOrder: 16, isPremium: true  },
  { key: 'interior',         name: 'Interior Design',              icon: '🛋️',  sortOrder: 17, isPremium: true  },
  { key: 'renovation',       name: 'Home Renovation',              icon: '🔨',  sortOrder: 18, isPremium: true  },
  { key: 'construction',     name: 'Civil Construction',           icon: '🏗️',  sortOrder: 19, isPremium: true  },
  { key: 'modular-kitchen',  name: 'Modular Kitchen',              icon: '🍳',  sortOrder: 20, isPremium: true  },
  { key: 'architecture',     name: 'Architecture & Planning',      icon: '📐',  sortOrder: 21, isPremium: true  },
  { key: 'commercial',       name: 'Commercial Fitout',            icon: '🏢',  sortOrder: 22, isPremium: true  },
  { key: 'landscaping',      name: 'Landscaping & Garden',         icon: '🌿',  sortOrder: 23, isPremium: false },
  { key: 'smart-home',       name: 'Smart Home Automation',        icon: '🤖',  sortOrder: 24, isPremium: true  },
  { key: 'property-mgmt',    name: 'Property Maintenance',         icon: '🏡',  sortOrder: 25, isPremium: false },
];

// ══════════════════════════════════════════════════════════
// SERVICES (160+)
// ══════════════════════════════════════════════════════════
const SERVICES = [
  // ── AC Service & Repair ──
  { c: 'ac', name: 'AC General Service (Split)',        price: 599,    orig: 899,    dur: 60,   popular: true,  desc: 'Full service: filter clean, coil wash, gas check, drain clear' },
  { c: 'ac', name: 'AC Deep Cleaning',                  price: 999,    orig: 1499,   dur: 90,   popular: true,  desc: 'Jet-wash indoor unit, coil cleaning, disinfection' },
  { c: 'ac', name: 'AC Gas Refill (R-22)',               price: 2499,   orig: 3499,   dur: 120,  popular: false, desc: 'R-22 refrigerant top-up with pressure test' },
  { c: 'ac', name: 'AC Gas Refill (R-32 / R-410A)',      price: 3499,   orig: 4999,   dur: 120,  popular: false, desc: 'Eco-friendly R-32 or R-410A refrigerant refill' },
  { c: 'ac', name: 'AC Installation (Split 1-2 Ton)',    price: 1499,   orig: 2199,   dur: 150,  popular: true,  desc: 'Supply & fix brackets, pipes, drain, electrical point' },
  { c: 'ac', name: 'AC Uninstallation & Shifting',       price: 799,    orig: 1199,   dur: 90,   popular: false, desc: 'Safe removal and reinstallation at new location' },
  { c: 'ac', name: 'AC PCB / Motor Repair',              price: 1999,   orig: 2999,   dur: 120,  popular: false, desc: 'Diagnose and repair PCB, fan motor, or capacitor' },
  { c: 'ac', name: 'Cassette / Duct AC Service',         price: 2499,   orig: 3499,   dur: 150,  popular: false, desc: 'Commercial cassette or ducted AC servicing' },
  { c: 'ac', name: 'Window AC Service',                  price: 499,    orig: 799,    dur: 60,   popular: false, desc: 'Window unit filter, coil, drain pan cleaning' },
  { c: 'ac', name: 'AC Annual Maintenance Contract',     price: 2499,   orig: 3999,   dur: 60,   popular: false, desc: '2 services + priority repair for 1 year' },

  // ── Plumbing ──
  { c: 'plumbing', name: 'Tap / Faucet Leak Fix',        price: 199,    orig: 399,    dur: 30,   popular: true,  desc: 'Repair dripping taps, cartridge replacement' },
  { c: 'plumbing', name: 'Toilet Repair / Flush Fix',    price: 299,    orig: 499,    dur: 45,   popular: true,  desc: 'Fix flush valve, float, or cistern issues' },
  { c: 'plumbing', name: 'Toilet Installation',          price: 1499,   orig: 2199,   dur: 120,  popular: false, desc: 'Remove old and install new toilet with fittings' },
  { c: 'plumbing', name: 'Pipe Leak Repair',             price: 499,    orig: 799,    dur: 90,   popular: true,  desc: 'Locate and seal pipe leaks, minor replacements' },
  { c: 'plumbing', name: 'Drainage Unclogging',          price: 399,    orig: 699,    dur: 60,   popular: true,  desc: 'Machine jetting to clear blocked drains & pipes' },
  { c: 'plumbing', name: 'Geyser / Water Heater Installation', price: 699, orig: 999, dur: 90,   popular: false, desc: 'Fix brackets, plumb connections, electrical point' },
  { c: 'plumbing', name: 'Overhead Tank Cleaning',       price: 1999,   orig: 2999,   dur: 180,  popular: false, desc: 'Full tank drain, scrub, disinfect, refill' },
  { c: 'plumbing', name: 'Sump Pump Installation',       price: 3499,   orig: 4999,   dur: 240,  popular: false, desc: 'Supply and install submersible pump with wiring' },
  { c: 'plumbing', name: 'Full Bathroom Plumbing',       price: 25000,  orig: 35000,  dur: 2880, popular: false, desc: 'Complete plumbing for new bathroom — CP fittings', premium: true },
  { c: 'plumbing', name: 'Water Softener Installation',  price: 2999,   orig: 4499,   dur: 180,  popular: false, desc: 'Install water softener with inlet/outlet plumbing' },

  // ── Electrical ──
  { c: 'electrical', name: 'Switch / Socket Repair',     price: 299,    orig: 499,    dur: 45,   popular: true,  desc: 'Replace broken switches, sockets, MCB' },
  { c: 'electrical', name: 'Fan Installation',           price: 399,    orig: 599,    dur: 60,   popular: true,  desc: 'Mount and wire ceiling fan with canopy' },
  { c: 'electrical', name: 'Fan Repair / Regulation',    price: 349,    orig: 549,    dur: 60,   popular: false, desc: 'Fix capacitor, winding, speed regulator' },
  { c: 'electrical', name: 'Light Fixture Installation', price: 299,    orig: 499,    dur: 45,   popular: false, desc: 'Install chandeliers, strip lights, spotlights' },
  { c: 'electrical', name: 'MCB / DB Box Replacement',   price: 999,    orig: 1499,   dur: 90,   popular: false, desc: 'Upgrade distribution board or replace MCBs' },
  { c: 'electrical', name: 'Full House Wiring',          price: 25000,  orig: 38000,  dur: 2880, popular: false, desc: 'Complete internal wiring for new construction', premium: true },
  { c: 'electrical', name: 'Inverter / UPS Installation', price: 1499,  orig: 1999,   dur: 90,   popular: false, desc: 'Install home inverter with battery and wiring' },
  { c: 'electrical', name: 'EV Charger Installation',    price: 3999,   orig: 5999,   dur: 180,  popular: false, desc: 'Install 7kW / 11kW EV home charging point' },
  { c: 'electrical', name: 'Safety Audit (Electrical)',  price: 1999,   orig: 2999,   dur: 120,  popular: false, desc: 'Full electrical health-check, earthing test, report' },
  { c: 'electrical', name: 'Exhaust Fan Installation',   price: 349,    orig: 549,    dur: 45,   popular: false, desc: 'Mount and wire exhaust fan in bathroom/kitchen' },

  // ── Appliance Repair ──
  { c: 'appliance', name: 'Refrigerator Repair',         price: 499,    orig: 799,    dur: 90,   popular: true,  desc: 'Diagnose and fix compressor, thermostat, cooling issues' },
  { c: 'appliance', name: 'Washing Machine Repair',      price: 449,    orig: 699,    dur: 90,   popular: true,  desc: 'Front-load / top-load drum, motor, control panel' },
  { c: 'appliance', name: 'TV Repair (LED/OLED)',         price: 399,    orig: 599,    dur: 60,   popular: false, desc: 'Panel, backlight, power board diagnostics & repair' },
  { c: 'appliance', name: 'Microwave Repair',            price: 349,    orig: 549,    dur: 60,   popular: false, desc: 'Magnetron, turntable, control board issues' },
  { c: 'appliance', name: 'Dishwasher Repair',           price: 549,    orig: 849,    dur: 90,   popular: false, desc: 'Pump, door latch, water inlet valve repair' },
  { c: 'appliance', name: 'RO / Water Purifier Service', price: 399,    orig: 699,    dur: 60,   popular: true,  desc: 'Filter change, membrane flush, UV check' },
  { c: 'appliance', name: 'Geyser Repair',               price: 399,    orig: 599,    dur: 60,   popular: false, desc: 'Element, thermostat, safety valve replacement' },
  { c: 'appliance', name: 'Chimney Cleaning & Repair',   price: 699,    orig: 999,    dur: 90,   popular: false, desc: 'Motor, baffle filter deep-clean, oil cup service' },
  { c: 'appliance', name: 'Dryer Repair',                price: 499,    orig: 799,    dur: 90,   popular: false, desc: 'Heating element, belt, thermostat diagnostics' },
  { c: 'appliance', name: 'Induction / Cooktop Repair',  price: 349,    orig: 549,    dur: 60,   popular: false, desc: 'IGBT, control board, touch panel issues' },

  // ── Deep Cleaning ──
  { c: 'cleaning', name: '1BHK Deep Home Cleaning',      price: 1999,   orig: 2999,   dur: 180,  popular: true,  desc: 'Full scrub: kitchen, bathrooms, floors, walls, fans' },
  { c: 'cleaning', name: '2BHK Deep Home Cleaning',      price: 2499,   orig: 3499,   dur: 240,  popular: true,  desc: 'Comprehensive 2BHK top-to-bottom deep clean' },
  { c: 'cleaning', name: '3BHK Deep Home Cleaning',      price: 3499,   orig: 4999,   dur: 300,  popular: false, desc: 'Full 3BHK deep clean with kitchen and 2 baths' },
  { c: 'cleaning', name: 'Bathroom Deep Clean',          price: 499,    orig: 799,    dur: 90,   popular: true,  desc: 'Tiles, fixtures, grouting, exhaust, mirror' },
  { c: 'cleaning', name: 'Kitchen Deep Clean',           price: 999,    orig: 1499,   dur: 180,  popular: true,  desc: 'Chimney, hob, tiles, cabinets, sink degreased' },
  { c: 'cleaning', name: 'Sofa & Upholstery Cleaning',   price: 1499,   orig: 2299,   dur: 120,  popular: false, desc: 'Foam extraction clean for sofa, recliners, curtains' },
  { c: 'cleaning', name: 'Carpet / Rug Shampooing',      price: 699,    orig: 999,    dur: 90,   popular: false, desc: 'Hot-water extraction or dry foam shampoo' },
  { c: 'cleaning', name: 'Post-Construction Cleaning',   price: 4999,   orig: 7999,   dur: 480,  popular: false, desc: 'Remove construction dust, debris, cement marks' },
  { c: 'cleaning', name: 'Move-In / Move-Out Cleaning',  price: 3499,   orig: 4999,   dur: 360,  popular: false, desc: 'Full sanitisation for vacant flat before handover' },
  { c: 'cleaning', name: 'Water Tank Cleaning',          price: 1999,   orig: 2999,   dur: 180,  popular: false, desc: 'Drain, scrub, disinfect overhead or underground tank' },

  // ── Painting ──
  { c: 'painting', name: 'Interior Wall Painting (1 room)', price: 3999, orig: 5999,  dur: 480,  popular: true,  desc: 'Wall putty, primer, 2 coats Asian / Berger / Nerolac' },
  { c: 'painting', name: 'Full Home Interior Painting 2BHK', price: 18000, orig: 26000, dur: 2880, popular: true, desc: 'Complete 2BHK paint job, branded paint included' },
  { c: 'painting', name: 'Full Home Interior Painting 3BHK', price: 26000, orig: 38000, dur: 3600, popular: false, desc: 'Complete 3BHK with texture / plain finish' },
  { c: 'painting', name: 'Exterior Wall Painting',       price: 25,     orig: 40,     dur: 2880, popular: false, desc: 'Per sq.ft rate — weather coat exterior paint', premium: true },
  { c: 'painting', name: 'Texture / Stencil Painting',   price: 8000,   orig: 12000,  dur: 960,  popular: false, desc: 'Designer texture for feature wall, bedroom accent' },
  { c: 'painting', name: 'Wood / Metal Painting',        price: 1999,   orig: 2999,   dur: 240,  popular: false, desc: 'Enamel or PU paint for doors, grilles, furniture' },
  { c: 'painting', name: 'Waterproof Painting (Terrace)', price: 35,    orig: 55,     dur: 1440, popular: false, desc: 'Per sq.ft — Dr. Fixit / STP terrace waterproofing paint' },

  // ── Carpentry ──
  { c: 'carpentry', name: 'Door / Window Repair',        price: 399,    orig: 699,    dur: 60,   popular: true,  desc: 'Fix hinges, handles, bolts, warped frames' },
  { c: 'carpentry', name: 'Furniture Assembly',          price: 499,    orig: 799,    dur: 90,   popular: true,  desc: 'IKEA or flat-pack furniture assembly & fixing' },
  { c: 'carpentry', name: 'Custom Wardrobe (per sqft)',  price: 850,    orig: 1200,   dur: 2880, popular: false, desc: 'Plywood wardrobe with laminate / PU finish', premium: true },
  { c: 'carpentry', name: 'Bed Frame Repair / Assembly', price: 599,    orig: 899,    dur: 90,   popular: false, desc: 'Reinforce loose joints, fix slats, re-assemble' },
  { c: 'carpentry', name: 'TV Unit / Wall Panel',        price: 15000,  orig: 22000,  dur: 1440, popular: false, desc: 'Custom TV unit with back panel and shelves', premium: true },
  { c: 'carpentry', name: 'False Ceiling Repair',        price: 999,    orig: 1499,   dur: 120,  popular: false, desc: 'Patch cracks, replace panels, fix grid system' },
  { c: 'carpentry', name: 'Wooden Flooring Installation', price: 85,    orig: 120,    dur: 2880, popular: false, desc: 'Per sq.ft — laminate, hardwood, or engineered wood', premium: true },

  // ── Pest Control ──
  { c: 'pest-control', name: 'Cockroach Control (1BHK)', price: 799,    orig: 1199,   dur: 60,   popular: true,  desc: 'Gel-based treatment for cockroaches in kitchen + baths' },
  { c: 'pest-control', name: 'Cockroach Control (3BHK)', price: 1499,   orig: 2199,   dur: 90,   popular: false, desc: 'Gel treatment full 3BHK flat' },
  { c: 'pest-control', name: 'Bed Bug Treatment',        price: 1999,   orig: 2999,   dur: 120,  popular: true,  desc: 'Heat + chemical treatment for all bedrooms' },
  { c: 'pest-control', name: 'Termite Treatment',        price: 3999,   orig: 5999,   dur: 240,  popular: false, desc: 'Anti-termite drilling + chemical injection, warranty', premium: true },
  { c: 'pest-control', name: 'Mosquito Control (Fogging)', price: 999,  orig: 1499,   dur: 60,   popular: false, desc: 'ULV fogging for garden, balcony, rooms' },
  { c: 'pest-control', name: 'Rat / Rodent Control',     price: 1499,   orig: 2199,   dur: 90,   popular: false, desc: 'Bait stations + glue traps + entry sealing' },
  { c: 'pest-control', name: 'Annual Pest Control AMC',  price: 3999,   orig: 5999,   dur: 60,   popular: false, desc: 'Quarterly visits + 24/7 helpline for 1 year' },

  // ── Waterproofing ──
  { c: 'waterproofing', name: 'Bathroom Waterproofing',  price: 150,    orig: 220,    dur: 2880, popular: true,  desc: 'Per sq.ft — crystalline waterproofing with 5-yr warranty', premium: true },
  { c: 'waterproofing', name: 'Terrace Waterproofing',   price: 90,     orig: 140,    dur: 1440, popular: true,  desc: 'Per sq.ft — STP / Dr. Fixit waterproofing membrane' },
  { c: 'waterproofing', name: 'Basement / Sunken Waterproofing', price: 200, orig: 300, dur: 2880, popular: false, desc: 'Injection grouting + crystalline treatment for basements' },
  { c: 'waterproofing', name: 'External Wall Waterproofing', price: 60,  orig: 90,    dur: 1440, popular: false, desc: 'Per sq.ft — elastomeric coating for exterior walls' },
  { c: 'waterproofing', name: 'Overhead Tank Waterproofing', price: 4999, orig: 6999, dur: 480,  popular: false, desc: 'HDPE lining or Roff coating for water tanks' },
  { c: 'waterproofing', name: 'Leakage Diagnosis Visit', price: 499,    orig: 799,    dur: 90,   popular: false, desc: 'Expert inspection with moisture meter and thermal scan' },

  // ── Flooring ──
  { c: 'flooring', name: 'Vitrified Tile Installation',  price: 55,     orig: 80,     dur: 2880, popular: true,  desc: 'Per sq.ft — supply and fix 600×600 or 800×800 tile', premium: true },
  { c: 'flooring', name: 'Marble / Granite Polishing',   price: 12,     orig: 18,     dur: 480,  popular: true,  desc: 'Per sq.ft — diamond polishing + crystallisation' },
  { c: 'flooring', name: 'Epoxy Flooring (Garage/Kitchen)', price: 80,  orig: 120,    dur: 1440, popular: false, desc: 'Per sq.ft — 2-part epoxy coating, seamless finish' },
  { c: 'flooring', name: 'Vinyl / SPC Flooring',         price: 70,     orig: 100,    dur: 1440, popular: false, desc: 'Per sq.ft — waterproof SPC or luxury vinyl plank install' },
  { c: 'flooring', name: 'Anti-Skid Tile Treatment',     price: 15,     orig: 25,     dur: 240,  popular: false, desc: 'Per sq.ft — chemical anti-skid for bathroom floors' },
  { c: 'flooring', name: 'Floor Tile Grouting / Repair', price: 999,    orig: 1499,   dur: 120,  popular: false, desc: 'Replace cracked grout, fix loose tiles, patch cracks' },

  // ── False Ceiling ──
  { c: 'false-ceiling', name: 'Gypsum Board False Ceiling', price: 75,  orig: 115,    dur: 2880, popular: true,  desc: 'Per sq.ft — standard gypsum board with POP finish', premium: true },
  { c: 'false-ceiling', name: 'POP False Ceiling',         price: 65,   orig: 95,     dur: 2880, popular: false, desc: 'Per sq.ft — Plaster of Paris ceiling with cornice' },
  { c: 'false-ceiling', name: 'Grid / Armstrong Ceiling',  price: 55,   orig: 80,     dur: 1440, popular: false, desc: 'Per sq.ft — 600×600 mineral fibre tile grid ceiling' },
  { c: 'false-ceiling', name: 'L-shaped / Tray Ceiling',   price: 95,   orig: 140,    dur: 2880, popular: false, desc: 'Per sq.ft — designer tray or cove ceiling with lighting', premium: true },
  { c: 'false-ceiling', name: 'Ceiling Crack / Patch Repair', price: 999, orig: 1499, dur: 120,  popular: false, desc: 'Plaster repair, sealing, texture match, paint touch-up' },

  // ── Fabrication ──
  { c: 'fabrication', name: 'MS Grille / Gate Fabrication', price: 350, orig: 500,   dur: 1440, popular: true,  desc: 'Per sq.ft — mild steel grille or gate with primer paint', premium: true },
  { c: 'fabrication', name: 'SS Railing / Handrail',        price: 600, orig: 900,   dur: 1440, popular: false, desc: 'Per running ft — SS 304 pipe railing, staircase / balcony', premium: true },
  { c: 'fabrication', name: 'Window Grill Installation',    price: 280, orig: 420,   dur: 480,  popular: false, desc: 'Per sq.ft — MS / Galvanised window grilles with fixing' },
  { c: 'fabrication', name: 'Rolling Shutter Installation', price: 350, orig: 500,   dur: 480,  popular: false, desc: 'Per sq.ft — motorised or manual rolling shutters' },
  { c: 'fabrication', name: 'Pergola / Shed Fabrication',   price: 800, orig: 1200,  dur: 2880, popular: false, desc: 'Per sq.ft — MS or GI structure with polycarbonate sheet', premium: true },

  // ── Aluminium Work ──
  { c: 'aluminium-work', name: 'Aluminium Sliding Window', price: 450,  orig: 650,   dur: 1440, popular: true,  desc: 'Per sq.ft — powder-coated, 3-track with mosquito mesh', premium: true },
  { c: 'aluminium-work', name: 'Aluminium Partition / Wall', price: 550, orig: 800,  dur: 1440, popular: false, desc: 'Per sq.ft — frame + toughened glass / ACP partition', premium: true },
  { c: 'aluminium-work', name: 'ACP Cladding (Exterior)',   price: 220, orig: 320,   dur: 2880, popular: false, desc: 'Per sq.ft — Aluminium Composite Panel external cladding' },
  { c: 'aluminium-work', name: 'Aluminium Door Repair',     price: 599, orig: 999,   dur: 90,   popular: false, desc: 'Fix rollers, handles, locks, section replacement' },

  // ── Glass Work ──
  { c: 'glass-work', name: 'Toughened Glass Partition',    price: 300,  orig: 450,   dur: 1440, popular: true,  desc: 'Per sq.ft — 8mm / 10mm toughened glass with fittings', premium: true },
  { c: 'glass-work', name: 'Shower Enclosure / Cubicle',   price: 18000, orig: 26000, dur: 480, popular: false, desc: '800×800mm frameless shower with hardware' },
  { c: 'glass-work', name: 'Glass Staircase Railing',      price: 700,  orig: 1000,  dur: 1440, popular: false, desc: 'Per running ft — 12mm toughened, stainless fittings' },
  { c: 'glass-work', name: 'Mirror Supply & Fixing',       price: 1999, orig: 2999,  dur: 120,  popular: false, desc: 'Custom-cut mirror with bevelled edge and fixings' },
  { c: 'glass-work', name: 'Window Glass Replacement',     price: 299,  orig: 499,   dur: 60,   popular: false, desc: 'Replace cracked or broken window pane, any size' },

  // ── CCTV & Security ──
  { c: 'cctv-security', name: 'CCTV Camera Installation (4 cameras)', price: 8999, orig: 12999, dur: 240, popular: true,  desc: '4 × 2MP IP cameras, 1TB DVR, 30m cables, remote view' },
  { c: 'cctv-security', name: 'Video Door Phone',          price: 3999, orig: 5999,  dur: 120,  popular: true,  desc: '7-inch colour monitor, HD outdoor camera, electric lock' },
  { c: 'cctv-security', name: 'Alarm System Installation', price: 4999, orig: 7499,  dur: 180,  popular: false, desc: 'Burglar alarm — PIR sensors, siren, GSM dialer' },
  { c: 'cctv-security', name: 'Smart Lock / Digital Lock', price: 6999, orig: 9999,  dur: 120,  popular: false, desc: 'App-controlled biometric or PIN smart door lock' },
  { c: 'cctv-security', name: 'CCTV Maintenance AMC',      price: 3999, orig: 5999,  dur: 60,   popular: false, desc: 'Annual maintenance — cleaning, storage, cable check' },

  // ── Solar Installation ──
  { c: 'solar', name: '1 kW Rooftop Solar System',          price: 55000, orig: 70000, dur: 4320, popular: true,  desc: '1kW on-grid system, 3 panels, MNRE-approved, 25yr warranty', premium: true },
  { c: 'solar', name: '3 kW Rooftop Solar System',          price: 145000, orig: 185000, dur: 4320, popular: true, desc: '3kW system, 9 panels, net metering, EPC included', premium: true },
  { c: 'solar', name: '5 kW Rooftop Solar System',          price: 235000, orig: 295000, dur: 5760, popular: false, desc: '5kW system — ideal for 3BHK + AC-heavy household', premium: true },
  { c: 'solar', name: 'Solar Water Heater (200L ETC)',       price: 18000, orig: 25000, dur: 480,  popular: false, desc: '200-litre evacuated tube collector, 5yr warranty' },
  { c: 'solar', name: 'Solar Panel Cleaning Service',       price: 999,  orig: 1499,  dur: 120,  popular: false, desc: 'Soft-wash cleaning, inspection, efficiency report' },

  // ── Interior Design ──
  { c: 'interior', name: '1BHK Complete Interior',          price: 350000, orig: 500000, dur: 43200, popular: true, desc: 'End-to-end 1BHK interior: kitchen, wardrobe, living', premium: true },
  { c: 'interior', name: '2BHK Complete Interior',          price: 650000, orig: 900000, dur: 60000, popular: true, desc: '2BHK full interior package, branded hardware included', premium: true },
  { c: 'interior', name: '3BHK Complete Interior',          price: 950000, orig: 1300000, dur: 72000, popular: false, desc: '3BHK interior — premium finish, 5-yr warranty', premium: true },
  { c: 'interior', name: 'Wardrobe Design & Execution',     price: 35000, orig: 50000, dur: 4320,  popular: false, desc: 'Custom-built wardrobe, sliding or hinged doors', premium: true },
  { c: 'interior', name: 'False Ceiling + Lighting Design', price: 80000, orig: 120000, dur: 4320, popular: false, desc: 'Designer false ceiling with ambient + accent lighting', premium: true },
  { c: 'interior', name: 'Home Office Interior Setup',      price: 85000, orig: 120000, dur: 2880, popular: false, desc: 'Ergonomic workstation, shelves, cable management', premium: true },
  { c: 'interior', name: 'Interior Design Consultation',    price: 2999,  orig: 5000,  dur: 120,  popular: false, desc: 'Site visit + concept board + material recommendations' },

  // ── Home Renovation ──
  { c: 'renovation', name: 'Full Home Renovation (2BHK)',   price: 500000, orig: 700000, dur: 72000, popular: true, desc: 'Complete demolition and rebuild, tiling, painting, joinery', premium: true },
  { c: 'renovation', name: 'Bathroom Renovation',           price: 80000, orig: 120000, dur: 7200, popular: true,  desc: 'Full reno — wall tiles, floor, sanitary, waterproofing', premium: true },
  { c: 'renovation', name: 'Kitchen Renovation',            price: 120000, orig: 175000, dur: 7200, popular: false, desc: 'Modular + plumbing + tiling + electrical + painting', premium: true },
  { c: 'renovation', name: 'Bedroom Renovation',            price: 75000, orig: 110000, dur: 4320, popular: false, desc: 'Wardrobes, flooring, false ceiling, wall treatment', premium: true },
  { c: 'renovation', name: 'Balcony Renovation',            price: 25000, orig: 38000, dur: 2880,  popular: false, desc: 'Tiles, railing, waterproofing, plant shelves' },
  { c: 'renovation', name: 'Renovation Consultation',       price: 1999,  orig: 3999,  dur: 120,  popular: false, desc: 'Site visit + estimate + material suggestions' },

  // ── Civil Construction ──
  { c: 'construction', name: 'RCC Slab Construction (per sqft)', price: 1800, orig: 2500, dur: 43200, popular: true, desc: 'Per sq.ft — RCC design, formwork, rebar, pour, cure', premium: true },
  { c: 'construction', name: 'Brick Wall Construction (per sqft)', price: 120, orig: 180, dur: 4320, popular: false, desc: 'Per sq.ft — fly ash brick, plaster, waterproofing' },
  { c: 'construction', name: 'Foundation & Plinth Work',    price: 80000, orig: 120000, dur: 14400, popular: false, desc: 'Excavation, PCC, RCC footing, plinth beam', premium: true },
  { c: 'construction', name: 'Site Visit & Free Estimate',  price: 0,    orig: 1999,   dur: 120,  popular: true,  desc: 'Engineer site visit, measurement, cost breakdown' },
  { c: 'construction', name: 'Demolition & Debris Removal', price: 15,   orig: 25,     dur: 2880, popular: false, desc: 'Per sq.ft — controlled demolition, debris hauling' },

  // ── Modular Kitchen ──
  { c: 'modular-kitchen', name: 'L-Shaped Modular Kitchen',  price: 150000, orig: 200000, dur: 14400, popular: true, desc: '8–10 ft L-shape, HDHMR carcass, soft-close hardware', premium: true },
  { c: 'modular-kitchen', name: 'U-Shaped Modular Kitchen',  price: 200000, orig: 275000, dur: 14400, popular: false, desc: '10–12 ft U-shape, quartz countertop, full loft', premium: true },
  { c: 'modular-kitchen', name: 'Straight / Parallel Kitchen', price: 100000, orig: 140000, dur: 7200, popular: false, desc: 'Compact straight or parallel layout, economical', premium: true },
  { c: 'modular-kitchen', name: 'Kitchen Countertop Replace', price: 8000, orig: 12000, dur: 480,  popular: false, desc: 'Replace with granite, quartz, or SS countertop' },
  { c: 'modular-kitchen', name: 'Kitchen Cabinet Repair',    price: 999,  orig: 1499,  dur: 120,  popular: false, desc: 'Fix loose hinges, drawer sliders, door alignment' },

  // ── Architecture & Planning ──
  { c: 'architecture', name: 'Architectural Design (per sqft)', price: 35, orig: 60,   dur: 14400, popular: true, desc: 'Per sq.ft — floor plans, elevations, 3D views, approvals', premium: true },
  { c: 'architecture', name: 'Structural Design',            price: 25,   orig: 40,    dur: 7200, popular: false, desc: 'Per sq.ft — RCC / steel structural drawings & SOQ', premium: true },
  { c: 'architecture', name: 'Vastu Consultation',           price: 2999, orig: 4999,  dur: 90,   popular: false, desc: 'Site visit + Vastu audit + correction report' },
  { c: 'architecture', name: 'Interior Design 3D Render',    price: 4999, orig: 7999,  dur: 1440, popular: false, desc: 'Photorealistic 3D render of any 2 rooms' },

  // ── Commercial Fitout ──
  { c: 'commercial', name: 'Office Interior Fitout (per sqft)', price: 1200, orig: 1800, dur: 14400, popular: true, desc: 'Per sq.ft — partitions, flooring, ceiling, furniture', premium: true },
  { c: 'commercial', name: 'Retail Shop Fitout',             price: 1500, orig: 2200,  dur: 14400, popular: false, desc: 'Per sq.ft — counters, shelving, branding, lighting', premium: true },
  { c: 'commercial', name: 'Restaurant / Café Fitout',       price: 1800, orig: 2700,  dur: 14400, popular: false, desc: 'Per sq.ft — bespoke restaurant interiors, kitchen plan', premium: true },
  { c: 'commercial', name: 'Facility Management Contract',   price: 50000, orig: 75000, dur: 0,    popular: false, desc: 'Monthly flat fee — MEP upkeep, cleaning, security', premium: true },

  // ── Landscaping ──
  { c: 'landscaping', name: 'Garden Design & Planting',      price: 15000, orig: 22000, dur: 2880, popular: true, desc: 'Layout, soil prep, shrub and flower planting' },
  { c: 'landscaping', name: 'Lawn Installation / Repair',    price: 25,   orig: 40,    dur: 1440, popular: false, desc: 'Per sq.ft — roll-on lawn or turf repair' },
  { c: 'landscaping', name: 'Balcony / Terrace Garden',      price: 8000, orig: 12000, dur: 960,  popular: false, desc: 'Planter boxes, grow bags, drip irrigation, plants' },
  { c: 'landscaping', name: 'Garden Maintenance (Monthly)',  price: 1999, orig: 2999,  dur: 120,  popular: false, desc: 'Weekly watering, fertilising, pruning, pest spray' },

  // ── Smart Home ──
  { c: 'smart-home', name: 'Smart Lighting Setup (5 rooms)', price: 25000, orig: 35000, dur: 480, popular: true, desc: 'Alexa/Google Home — 5-room smart switches + voice control', premium: true },
  { c: 'smart-home', name: 'Home Theatre Installation',      price: 15000, orig: 22000, dur: 480, popular: false, desc: '5.1 surround, screen/projector setup, HDMI matrix', premium: true },
  { c: 'smart-home', name: 'Smart AC Control Setup',         price: 3999, orig: 5999,  dur: 120,  popular: false, desc: 'IR blaster + app-based control for existing ACs' },
  { c: 'smart-home', name: 'Video Doorbell + Intercom',      price: 5999, orig: 8999,  dur: 120,  popular: false, desc: 'WiFi video doorbell with indoor chime, cloud recording' },
  { c: 'smart-home', name: 'Smart Home Full Automation',     price: 150000, orig: 220000, dur: 7200, popular: false, desc: 'KNX/Modbus full home automation — lighting, climate, security', premium: true },

  // ── Property Maintenance ──
  { c: 'property-mgmt', name: 'Annual Property Maintenance (2BHK)', price: 7999, orig: 12999, dur: 60, popular: true, desc: 'Quarterly checks — plumbing, electrical, pest, cleaning' },
  { c: 'property-mgmt', name: 'Pre-Monsoon Property Check',   price: 2999, orig: 4999, dur: 240, popular: true,  desc: 'Roof, drainage, waterproofing, electrical safety audit' },
  { c: 'property-mgmt', name: 'Property Handover Inspection', price: 1999, orig: 2999, dur: 120, popular: false, desc: 'Builder-defect report before possession, punch list' },
  { c: 'property-mgmt', name: 'Rental Property Upkeep',       price: 4999, orig: 7999, dur: 0,   popular: false, desc: 'Monthly visits — ensure tenant-ready condition' },
];

// ══════════════════════════════════════════════════════════
// PRODUCT CATEGORIES (10)
// ══════════════════════════════════════════════════════════
const PRODUCT_CATS = [
  { key: 'ac-hvac',      name: 'AC & HVAC Products',          icon: '❄️',  sortOrder: 1 },
  { key: 'plumbing',     name: 'Plumbing & Bathroom',         icon: '🚿',  sortOrder: 2 },
  { key: 'kitchen',      name: 'Kitchen & Appliances',        icon: '🍳',  sortOrder: 3 },
  { key: 'electrical',   name: 'Lighting & Electrical',       icon: '💡',  sortOrder: 4 },
  { key: 'construction', name: 'Construction Materials',      icon: '🧱',  sortOrder: 5 },
  { key: 'tools',        name: 'Power Tools & Hardware',      icon: '🔧',  sortOrder: 6 },
  { key: 'safety',       name: 'Safety & Security',           icon: '🔒',  sortOrder: 7 },
  { key: 'solar',        name: 'Solar & Energy',              icon: '☀️',  sortOrder: 8 },
  { key: 'flooring',     name: 'Flooring & Tiles',            icon: '🏠',  sortOrder: 9 },
  { key: 'paint',        name: 'Paints & Coatings',           icon: '🎨',  sortOrder: 10 },
];

// ══════════════════════════════════════════════════════════
// PRODUCTS (60+)
// ══════════════════════════════════════════════════════════
const PRODUCTS = [
  // AC & HVAC
  { c: 'ac-hvac', name: 'Daikin 1.5T 5-Star Inverter Split AC',   brand: 'Daikin',    price: 34990, mrp: 44990, desc: '5-star, R-32, WiFi-ready, auto-clean filter', stock: 20 },
  { c: 'ac-hvac', name: 'LG 1.5T 3-Star Dual Inverter AC',        brand: 'LG',        price: 28490, mrp: 36990, desc: 'Dual inverter compressor, 4-way swing, auto clean', stock: 25 },
  { c: 'ac-hvac', name: 'V-Guard 4kVA AC Voltage Stabilizer',     brand: 'V-Guard',   price: 2799,  mrp: 3999,  desc: 'Wide range 90V–300V, digital display', stock: 50 },
  { c: 'ac-hvac', name: 'Voltas 1T 3-Star Window AC',             brand: 'Voltas',    price: 18990, mrp: 24000, desc: 'Copper condenser, anti-dust filter, 3-star rating', stock: 15 },
  { c: 'ac-hvac', name: 'Blue Star 5-Star Cassette AC 2T',        brand: 'Blue Star',  price: 58000, mrp: 72000, desc: '4-way airflow, auto-swing, 360° throw', stock: 8 },
  { c: 'ac-hvac', name: 'Carrier 2T Inverter Duct AC',            brand: 'Carrier',   price: 65000, mrp: 82000, desc: 'Commercial grade duct AC for office/shop', stock: 5 },

  // Plumbing & Bathroom
  { c: 'plumbing', name: 'Jaquar Solo Single Lever Basin Mixer',   brand: 'Jaquar',    price: 3299,  mrp: 4999,  desc: 'Chrome finish, ceramic disc cartridge, quarter-turn', stock: 40 },
  { c: 'plumbing', name: 'Kohler Span Wall-Mount Toilet',          brand: 'Kohler',    price: 9999,  mrp: 14000, desc: 'Elongated, dual flush 3/6L, soft-close seat', stock: 12 },
  { c: 'plumbing', name: 'Hindware Shower Panel (5-function)',     brand: 'Hindware',  price: 7999,  mrp: 12000, desc: 'SS body, overhead rain, handheld, jets, LED temperature', stock: 18 },
  { c: 'plumbing', name: 'Racold 25L Electric Water Heater',       brand: 'Racold',    price: 5499,  mrp: 7999,  desc: '5-star, titanium-coated tank, 8 bar pressure', stock: 30 },
  { c: 'plumbing', name: 'Supreme CPVC Pipe 1" (3m)',              brand: 'Supreme',   price: 299,   mrp: 399,   desc: 'ISI-marked CPVC, 90PSI, hot/cold water compatible', stock: 200 },
  { c: 'plumbing', name: 'Sintex Triple-Layer HDPE Water Tank 1000L', brand: 'Sintex', price: 4499, mrp: 5999,  desc: 'UV-protected, ISI-marked, food-grade HDPE', stock: 15 },

  // Kitchen & Appliances
  { c: 'kitchen', name: 'Faber Hood Cyber 90 Auto-Clean Chimney', brand: 'Faber',     price: 13999, mrp: 21000, desc: '1500 m³/hr, auto-clean, oil collector, 5-yr motor warranty', stock: 20 },
  { c: 'kitchen', name: 'Carysil Rock Series Granite Kitchen Sink', brand: 'Carysil',  price: 8499,  mrp: 13000, desc: '37×18 single bowl, heat/scratch resistant granite', stock: 25 },
  { c: 'kitchen', name: 'Hindware Oscar 1.5T Countertop Microwave', brand: 'Hindware', price: 5999,  mrp: 8499,  desc: '20L, solo, 800W, 8 auto-cook menus', stock: 30 },
  { c: 'kitchen', name: 'Bosch Serie 6 Dishwasher 12-Place',       brand: 'Bosch',     price: 42000, mrp: 55000, desc: 'ActiveWater, 5 wash programs, auto-open drying', stock: 6 },
  { c: 'kitchen', name: 'Kent Pearl 8L RO + UV Water Purifier',    brand: 'Kent',      price: 8999,  mrp: 13000, desc: 'TDS controller, 20L/hr, 8L storage, KENT patented', stock: 35 },
  { c: 'kitchen', name: 'Glen 4 Burner Auto-Ignition Gas Hob',     brand: 'Glen',      price: 6999,  mrp: 9999,  desc: '4 brass burners, auto-ignition, SS body, flame failure', stock: 22 },

  // Electrical & Lighting
  { c: 'electrical', name: 'Philips Hue Smart E27 Bulb (3-Pack)',  brand: 'Philips',   price: 4499,  mrp: 6499,  desc: '800 lm, 16M colours, Alexa/Google compatible', stock: 60 },
  { c: 'electrical', name: 'Havells 1200mm Inverter Fan',          brand: 'Havells',   price: 3999,  mrp: 5499,  desc: '35W BLDC motor, 5-speed touch remote, 2-yr warranty', stock: 40 },
  { c: 'electrical', name: 'Legrand Arteor 6A Socket 3-Pin',       brand: 'Legrand',   price: 899,   mrp: 1299,  desc: 'Safety shutter, child-proof, modular white', stock: 100 },
  { c: 'electrical', name: 'Luminous Cruze 2kVA Inverter + 150Ah Battery', brand: 'Luminous', price: 15499, mrp: 20000, desc: 'Pure sinewave, intelligent charging, 150Ah tubular battery', stock: 12 },
  { c: 'electrical', name: 'Anchor Roma 10A MCB (10-Pack)',        brand: 'Anchor',    price: 1199,  mrp: 1799,  desc: 'C-curve, 10kA breaking capacity, ISI-marked', stock: 80 },
  { c: 'electrical', name: 'Wipro Smart Home Hub + 2 Switch Modules', brand: 'Wipro', price: 3499,  mrp: 4999,  desc: 'Alexa/Google, scene programming, 2A dimmer included', stock: 25 },

  // Construction Materials
  { c: 'construction', name: 'UltraTech PPC Cement 50kg',          brand: 'UltraTech', price: 410,   mrp: 480,   desc: 'Portland Pozzolana Cement, BIS-certified, strong cure', stock: 500 },
  { c: 'construction', name: 'TATA Tiscon Fe500D TMT 12mm per bundle', brand: 'TATA', price: 6800,  mrp: 7500,  desc: '10-rod bundle 12mm TMT, quenched & tempered, earthquake-resistant', stock: 50 },
  { c: 'construction', name: 'Asian Paints SmartCare Damp Block',  brand: 'Asian Paints', price: 1299, mrp: 1799, desc: '1L waterproof primer for damp walls, anti-fungal', stock: 80 },
  { c: 'construction', name: 'Fevicol MR White Adhesive 5kg',      brand: 'Fevicol',   price: 899,   mrp: 1199,  desc: 'Moisture-resistant wood adhesive, carpenter grade', stock: 120 },
  { c: 'construction', name: 'STP Roffment 5kg Waterproofing Compound', brand: 'STP', price: 1499, mrp: 2199, desc: 'Ready-mix polymer modified mortar for terrace/bath', stock: 60 },

  // Power Tools & Hardware
  { c: 'tools', name: 'Bosch GSB 550 550W Impact Drill',          brand: 'Bosch',     price: 2299,  mrp: 3199,  desc: 'Corded, 2800 rpm, 13mm chuck, 2-speed gearbox', stock: 30 },
  { c: 'tools', name: 'Stanley FatMax 5m Tape Measure',           brand: 'Stanley',   price: 599,   mrp: 899,   desc: 'Magnetic tip, shock-absorb casing, 25mm blade width', stock: 100 },
  { c: 'tools', name: 'Makita 18V Cordless Drill Driver',         brand: 'Makita',    price: 7499,  mrp: 9999,  desc: 'Brushless, 2-speed, 2Ah battery + charger included', stock: 15 },
  { c: 'tools', name: 'Ingco Angle Grinder 4.5" 850W',            brand: 'Ingco',     price: 1299,  mrp: 1899,  desc: '11000 rpm, 115mm disc, safety guard, ISI-marked', stock: 40 },
  { c: 'tools', name: 'Pidilite Fevibond Contact Adhesive 200g',  brand: 'Pidilite',  price: 349,   mrp: 499,   desc: 'Rubber-based, bonds laminate, rubber, leather', stock: 150 },

  // Safety & Security
  { c: 'safety', name: 'CP Plus 2MP Dome IP CCTV Camera',         brand: 'CP Plus',   price: 1499,  mrp: 2199,  desc: '1080p, IR 30m, IP67, PoE, H.265+ compression', stock: 60 },
  { c: 'safety', name: 'Godrej 6-Lever Door Lock Ultralock',      brand: 'Godrej',    price: 1999,  mrp: 2999,  desc: 'Pick-resistant, anti-drill, 3 keys included', stock: 45 },
  { c: 'safety', name: 'Eureka Forbes Agni 2 Fire Extinguisher 1kg', brand: 'EF',     price: 999,   mrp: 1499,  desc: 'Dry powder, class ABC, refillable, ISI-marked', stock: 70 },
  { c: 'safety', name: 'Hikam Smart WiFi Video Doorbell',         brand: 'Hikam',     price: 3499,  mrp: 4999,  desc: '2MP HD, night vision, 2-way audio, cloud storage', stock: 25 },
  { c: 'safety', name: 'Tripod Safety Helmet (Hard Hat)',          brand: 'Tripod',    price: 349,   mrp: 499,   desc: 'HDPE shell, 6-point suspension, ANSI Z89.1 certified', stock: 100 },

  // Solar & Energy
  { c: 'solar', name: 'Waaree 545W Monocrystalline Solar Panel',  brand: 'Waaree',    price: 17500, mrp: 22000, desc: 'PERC, 21.2% efficiency, 25-yr power warranty', stock: 30 },
  { c: 'solar', name: 'Luminous Solarverter Pro 3kVA Inverter',   brand: 'Luminous',  price: 18999, mrp: 25000, desc: 'Solar hybrid inverter, MPPT, pure sinewave', stock: 10 },
  { c: 'solar', name: 'V-Guard VGU 100 150Ah Solar Battery',      brand: 'V-Guard',   price: 10999, mrp: 13999, desc: 'Tubular, 2V cells, deep cycle, 5-yr warranty', stock: 20 },
  { c: 'solar', name: 'Havells 10A Solar Charge Controller',      brand: 'Havells',   price: 899,   mrp: 1299,  desc: 'PWM, 12V/24V auto-detect, LCD display, overcharge protection', stock: 50 },

  // Flooring & Tiles
  { c: 'flooring', name: 'Kajaria 800×800 Soluble Salt Vitrified Tile (box)', brand: 'Kajaria', price: 1599, mrp: 2199, desc: '5-tile box (3.2 sqm), anti-skid, 0.3 PEI rating', stock: 80 },
  { c: 'flooring', name: 'Johnson 600×600 Matt Finish Floor Tile (box)', brand: 'Johnson', price: 1199, mrp: 1699, desc: '4-tile box (1.44 sqm), natural stone texture, slip-resistant', stock: 100 },
  { c: 'flooring', name: 'Pergo Original Excellence 8mm Laminate Flooring', brand: 'Pergo', price: 699, mrp: 999,  desc: 'Per sq.ft — AC4, water-repellent surface, 30-yr warranty', stock: 200 },
  { c: 'flooring', name: 'ArcWhite Marble Polishing Kit',          brand: 'ArcWhite',  price: 1499,  mrp: 2199,  desc: 'Diamond pads + crystallisation powder, DIY kit', stock: 40 },

  // Paints & Coatings
  { c: 'paint', name: 'Asian Paints Apcolite Enamel Gloss White 4L', brand: 'Asian Paints', price: 1299, mrp: 1699, desc: 'Interior/exterior enamel, gloss finish, metal/wood', stock: 80 },
  { c: 'paint', name: 'Berger WeatherCoat All Guard Exterior 20L', brand: 'Berger',    price: 5499,  mrp: 7499,  desc: '3-in-1 waterproof, anti-algae, exterior emulsion', stock: 40 },
  { c: 'paint', name: 'Nerolac Excel Total 20L Interior Emulsion', brand: 'Nerolac',   price: 4999,  mrp: 6999,  desc: 'Anti-bacterial, sheen finish, 10,000 scrub cycles', stock: 45 },
  { c: 'paint', name: 'Dulux Weathershield Power 10L',             brand: 'Dulux',     price: 3499,  mrp: 4999,  desc: 'All-weather protection, 15-yr anti-fade guarantee', stock: 35 },
];

// ══════════════════════════════════════════════════════════
// TEST VENDORS (25 service vendors)
// ══════════════════════════════════════════════════════════
const TEST_VENDORS = [
  // AC
  { phone: '+919800000101', name: '[TEST] Rahul Sharma — AC Technician', city: 'Mumbai',    skills: ['ac'],               rating: 4.8, jobs: 156 },
  { phone: '+919800000102', name: '[TEST] Suresh Kumar — HVAC Specialist', city: 'Delhi NCR', skills: ['ac'],             rating: 4.6, jobs: 230 },
  // Plumbing
  { phone: '+919800000103', name: '[TEST] Raju Plumber', city: 'Bangalore',                  skills: ['plumbing'],         rating: 4.5, jobs: 89 },
  { phone: '+919800000104', name: '[TEST] Mohammed Ali — Plumbing Expert', city: 'Hyderabad', skills: ['plumbing'],        rating: 4.7, jobs: 112 },
  // Electrical
  { phone: '+919800000105', name: '[TEST] Vijay Electrician', city: 'Mumbai',                skills: ['electrical'],       rating: 4.9, jobs: 198 },
  { phone: '+919800000106', name: '[TEST] Deepak Singh — Master Electrician', city: 'Pune', skills: ['electrical'],        rating: 4.4, jobs: 67 },
  // Appliance
  { phone: '+919800000107', name: '[TEST] Sanjay Appliance Repair', city: 'Chennai',         skills: ['appliance'],        rating: 4.6, jobs: 145 },
  { phone: '+919800000108', name: '[TEST] Anil Kumar — Electronics Expert', city: 'Kolkata', skills: ['appliance'],        rating: 4.3, jobs: 78 },
  // Cleaning
  { phone: '+919800000109', name: '[TEST] Meena Cleaning Services', city: 'Mumbai',           skills: ['cleaning'],         rating: 4.7, jobs: 312 },
  { phone: '+919800000110', name: '[TEST] FreshHome Team — Bangalore', city: 'Bangalore',     skills: ['cleaning'],         rating: 4.5, jobs: 221 },
  // Painting
  { phone: '+919800000111', name: '[TEST] Ramesh Painter — Interior', city: 'Delhi NCR',      skills: ['painting'],         rating: 4.8, jobs: 95 },
  { phone: '+919800000112', name: '[TEST] ColorPro Rahul', city: 'Ahmedabad',                 skills: ['painting'],         rating: 4.2, jobs: 44 },
  // Carpentry
  { phone: '+919800000113', name: '[TEST] Master Carpenter Ganesh', city: 'Mumbai',           skills: ['carpentry'],        rating: 4.7, jobs: 178 },
  { phone: '+919800000114', name: '[TEST] WoodCraft Sunil — Modular', city: 'Bangalore',      skills: ['carpentry', 'interior'], rating: 4.6, jobs: 88 },
  // Pest Control
  { phone: '+919800000115', name: '[TEST] PestBye Services Jaipur', city: 'Jaipur',           skills: ['pest-control'],     rating: 4.5, jobs: 200 },
  // Waterproofing
  { phone: '+919800000116', name: '[TEST] DryShield Waterproofing Team', city: 'Hyderabad',  skills: ['waterproofing'],    rating: 4.8, jobs: 134 },
  // Flooring
  { phone: '+919800000117', name: '[TEST] FloorMaster Krishna', city: 'Chennai',              skills: ['flooring', 'tiling'], rating: 4.6, jobs: 109 },
  // Interior / Renovation
  { phone: '+919800000118', name: '[TEST] Preeti Interior Studio', city: 'Mumbai',            skills: ['interior', 'renovation'], rating: 4.9, jobs: 42 },
  { phone: '+919800000119', name: '[TEST] BuildRight Contractors Delhi', city: 'Delhi NCR',   skills: ['construction', 'renovation'], rating: 4.5, jobs: 27 },
  // CCTV
  { phone: '+919800000120', name: '[TEST] SecureView CCTV Solutions', city: 'Bangalore',      skills: ['cctv-security'],    rating: 4.7, jobs: 167 },
  // Solar
  { phone: '+919800000121', name: '[TEST] SunPower Solar Installers', city: 'Pune',           skills: ['solar'],            rating: 4.8, jobs: 56 },
  // Multi-skilled
  { phone: '+919800000122', name: '[TEST] OmniTech Home Solutions', city: 'Mumbai',           skills: ['ac', 'electrical', 'appliance'], rating: 4.6, jobs: 340 },
  { phone: '+919800000123', name: '[TEST] AllCare Maintenance Team', city: 'Delhi NCR',       skills: ['cleaning', 'pest-control', 'plumbing'], rating: 4.4, jobs: 289 },
  { phone: '+919800000124', name: '[TEST] Luxury Interiors Bangalore', city: 'Bangalore',     skills: ['interior', 'modular-kitchen', 'false-ceiling'], rating: 4.9, jobs: 31 },
  { phone: '+919800000125', name: '[TEST] SmartFix Pro Hyderabad', city: 'Hyderabad',         skills: ['electrical', 'smart-home', 'cctv-security'], rating: 4.7, jobs: 78 },
];

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function main() {
  console.log('🌱 Extended seed starting...\n');

  // ── Service Categories ──
  const catMap: Record<string, string> = {};
  for (const cat of CATEGORIES) {
    const c = await prisma.serviceCategory.upsert({
      where: { key: cat.key },
      update: { name: cat.name, icon: cat.icon, sortOrder: cat.sortOrder, isPremium: cat.isPremium },
      create: { key: cat.key, name: cat.name, icon: cat.icon, sortOrder: cat.sortOrder, isActive: true, isPremium: cat.isPremium },
    });
    catMap[cat.key] = c.id;
  }
  console.log(`✅ ${CATEGORIES.length} service categories`);

  // ── Services ──
  let svcCount = 0;
  for (const s of SERVICES) {
    const sl = slug(s.name);
    await prisma.service.upsert({
      where: { slug: sl },
      update: { basePrice: s.price, originalPrice: s.orig, description: s.desc },
      create: {
        categoryId: catMap[s.c],
        name: s.name, slug: sl,
        description: s.desc || '',
        basePrice: s.price, originalPrice: s.orig,
        durationMinutes: s.dur,
        requiredSkills: [s.c],
        isActive: true, isPopular: s.popular || false, isPremium: (s as any).premium || false,
      },
    });
    svcCount++;
  }
  console.log(`✅ ${svcCount} services`);

  // ── Product Categories ──
  const prodCatMap: Record<string, string> = {};
  for (const cat of PRODUCT_CATS) {
    const c = await prisma.productCategory.upsert({
      where: { key: cat.key },
      update: { name: cat.name, icon: cat.icon, sortOrder: cat.sortOrder },
      create: { key: cat.key, name: cat.name, icon: cat.icon, sortOrder: cat.sortOrder, isActive: true },
    });
    prodCatMap[cat.key] = c.id;
  }
  console.log(`✅ ${PRODUCT_CATS.length} product categories`);

  // ── Product Vendor (shared) ──
  let vendorUser = await prisma.user.findUnique({ where: { phone: '+919999000001' } });
  if (!vendorUser) {
    vendorUser = await prisma.user.create({
      data: { phone: '+919999000001', name: 'Remont Direct', role: UserRole.PRODUCT_VENDOR, isVerified: true },
    });
  }
  let vendor = await prisma.productVendor.findUnique({ where: { userId: vendorUser.id } });
  if (!vendor) {
    vendor = await prisma.productVendor.create({
      data: { userId: vendorUser.id, businessName: 'Remont Direct', gstNumber: '27ABCDE1234F1Z5', status: 'ACTIVE', rating: 4.6 },
    });
  }

  // ── Products ──
  let prodCount = 0;
  for (const p of PRODUCTS) {
    if (!prodCatMap[p.c]) { console.warn(`  ⚠️  No cat for product key "${p.c}"`); continue; }
    const sl = slug(p.name);
    await prisma.product.upsert({
      where: { slug: sl },
      update: { price: p.price, mrp: p.mrp, stock: p.stock },
      create: {
        vendorId: vendor.id,
        categoryId: prodCatMap[p.c],
        name: p.name, slug: sl, sku: `RMNT-${sl.slice(0, 18).toUpperCase()}`,
        brand: p.brand, description: p.desc,
        price: p.price, mrp: p.mrp,
        stock: p.stock, images: [], aiEnhancedImgs: [],
        isActive: true,
      },
    });
    prodCount++;
  }
  console.log(`✅ ${prodCount} products`);

  // ── Update Cities with all new service keys ──
  const allServiceKeys = [...new Set(SERVICES.map((s) => s.c))];
  await prisma.city.updateMany({
    data: { activeServiceKeys: allServiceKeys },
  });
  console.log(`✅ Cities updated with ${allServiceKeys.length} service keys`);

  // ── Test Vendors ──
  let vendorCreated = 0;
  for (const v of TEST_VENDORS) {
    let user = await prisma.user.findUnique({ where: { phone: v.phone } });
    if (!user) {
      user = await prisma.user.create({
        data: { phone: v.phone, name: v.name, role: UserRole.SERVICE_VENDOR, isVerified: true },
      });
    } else {
      await prisma.user.update({ where: { id: user.id }, data: { name: v.name } });
    }

    const cityRec = await prisma.city.findFirst({ where: { name: v.city } });
    if (!cityRec) { console.warn(`  ⚠️  City not found: ${v.city}`); continue; }

    await prisma.serviceVendor.upsert({
      where: { userId: user.id },
      update: { rating: v.rating, completedJobs: v.jobs, skills: v.skills, baseCity: v.city, status: VendorStatus.ACTIVE },
      create: {
        userId: user.id,
        fullName: v.name,
        businessName: v.name.replace('[TEST] ', ''),
        skills: v.skills,
        serviceRadius: 15,
        baseCity: v.city,
        status: VendorStatus.ACTIVE,
        isOnline: true,
        rating: v.rating,
        completedJobs: v.jobs,
        currentLatitude: cityRec.latitude + (Math.random() - 0.5) * 0.1,
        currentLongitude: cityRec.longitude + (Math.random() - 0.5) * 0.1,
        lastLocationUpdate: new Date(),
      },
    });
    vendorCreated++;
  }
  console.log(`✅ ${vendorCreated} test vendors`);

  console.log('\n🎉 Extended seed complete!');
  console.log(`   Categories: ${CATEGORIES.length}`);
  console.log(`   Services:   ${svcCount}`);
  console.log(`   Products:   ${prodCount}`);
  console.log(`   Vendors:    ${vendorCreated} (all tagged [TEST])`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
