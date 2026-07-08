// One-off backfill: create SubCategory rows and assign every existing Service to one.
// Run once against production: DATABASE_URL="<DATABASE_PUBLIC_URL>" node prisma/assign-subcategories.js
// Not part of the request-handling code path — a hand-curated categorization based on
// reading the real 196 service names in the DB, not a runtime keyword matcher.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DATA = {
  ELECTRICAL: [
    { key: 'switch-socket', name: 'Switch & Socket', icon: '🔌', services: [
      'Switch / Socket Replacement (Per Point)', 'Smart Switch / Smart Board Installation',
      'Switchboard Installation (Per Board)', 'Switchboard Repair',
    ]},
    { key: 'fan', name: 'Fan', icon: '🌀', services: [
      'Ceiling Fan Installation', 'Ceiling Fan Installation Combo (4 Fans)', 'Ceiling Fan Repair',
      'Ceiling Fan Uninstallation', 'Exhaust Fan Installation', 'Fan Regulator Replacement',
      'Wall / Pedestal Fan Repair',
    ]},
    { key: 'wall-ceiling-light', name: 'Wall & Ceiling Light', icon: '💡', services: [
      'Decorative / Chandelier Light Installation', 'False Ceiling Light Installation (Per Light)',
      'LED Panel Installation (Per Panel)', 'Strip / Profile Light Installation (Per 5 Mtr)',
      'Tube Light / LED Batten Installation', 'Wall Light / Mirror Light Installation',
    ]},
    { key: 'wiring-earthing', name: 'Wiring & Earthing', icon: '🔧', services: [
      'Full House Rewiring (1BHK)', 'Full House Rewiring (2BHK)', 'Full House Rewiring (3BHK)',
      'New Electrical Point (Per Point)', 'Earthing Installation / Repair',
    ]},
    { key: 'doorbell-security', name: 'Doorbell & Security', icon: '🔔', services: [
      'Doorbell Installation', 'Video Door Phone Installation', 'CCTV Installation (2 Cameras)',
      'CCTV Installation (4 Cameras)', 'CCTV Repair / Service Visit',
    ]},
    { key: 'mcb-distribution', name: 'MCB & Distribution', icon: '⚡', services: [
      'MCB Replacement (Per MCB)', 'Distribution Board (DB) Installation', 'RCCB / ELCB Installation',
      'Sub-Meter Installation', 'Generator Changeover Switch Installation',
    ]},
    { key: 'appliance-ac-points', name: 'Appliance & AC Points', icon: '🔥', services: [
      'AC Point Installation (16A/20A)', 'Appliance Power Issue Repair Visit', 'Geyser Point Installation',
      'TV Wall Mounting with Concealed Wiring', 'Inverter Installation with Wiring',
      'Inverter / Battery Health Check', 'EV Charger Point Installation',
    ]},
    { key: 'safety-amc', name: 'Safety & AMC', icon: '🛡️', services: [
      'Electrical Safety Audit (Full Home)', 'Electrical AMC – Home (1 Year)',
      'Electrical AMC – Office/Shop (1 Year)', 'Short Circuit / Power Failure Emergency Visit',
      'Smart Home Automation Setup (Per Room)',
    ]},
  ],
  PLUMBING: [
    { key: 'tap-faucet', name: 'Tap & Faucet', icon: '🚰', services: [
      'Angle Valve Replacement (Per Piece)', 'Diverter Installation / Repair',
      'Jet Spray / Health Faucet Installation', 'Shower Head Installation / Replacement',
      'Shower Panel Installation', 'Single Lever Basin Mixer Installation',
      'Tap Repair (Leak/Drip Fix)', 'Tap Replacement (Per Tap)', 'Wall Mixer Installation',
    ]},
    { key: 'toilet-flush', name: 'Toilet & Flush', icon: '🚽', services: [
      'Concealed Cistern Repair', 'Dual Flush Mechanism Replacement', 'Flush Tank Repair (External PVC)',
      'Indian to Western Toilet Conversion', 'Toilet Seat Cover Replacement',
      'Wall-Hung Toilet Installation', 'Western Toilet (Floor-Mounted) Installation',
    ]},
    { key: 'drainage-blockage', name: 'Drainage & Blockage', icon: '🕳️', services: [
      'Basin Blockage Removal', 'Bathroom Drainage Blockage Removal', 'Bottle Trap / Waste Pipe Replacement',
      'Floor Trap / Nahani Trap Blockage Removal', 'Kitchen Sink Blockage Removal',
      'Main Drainage Line Cleaning (Machine)', 'New Drainage Line (Per Point)',
    ]},
    { key: 'water-tank-motor', name: 'Water Tank & Motor', icon: '🛢️', services: [
      'Overhead Water Tank Cleaning (Up to 1000L)', 'Overhead Water Tank Cleaning (Up to 2000L)',
      'Underground Sump Cleaning', 'Pressure Booster Pump Installation', 'Water Motor / Pump Installation',
      'Water Motor Repair', 'Tanker/Borewell Connection Setup',
    ]},
    { key: 'pipeline-leakage', name: 'Pipeline & Leakage', icon: '💧', services: [
      'Concealed Pipeline Leak Detection & Repair', 'Pipeline Leakage Repair (Exposed)',
      'New Water Line (Per Point)',
    ]},
    { key: 'bathroom-kitchen-fittings', name: 'Bathroom & Kitchen Fittings', icon: '🛁', services: [
      'Bathroom Fittings Installation Package', 'Full Bathroom Plumbing Package (Per Bathroom)',
      'Kitchen Sink Installation', 'Washbasin Installation', 'Washbasin Repair / Leakage Fix',
    ]},
    { key: 'geyser-appliance', name: 'Geyser & Appliance Connections', icon: '🚿', services: [
      'Geyser Plumbing Connection', 'RO Water Purifier Plumbing Point',
      'Washing Machine Inlet/Outlet Connection', 'Water Meter Installation',
    ]},
    { key: 'packages-amc', name: 'Packages & AMC', icon: '📋', services: [
      'Full Home Plumbing (2BHK Package)', 'Plumbing AMC – Commercial (1 Year)',
      'Plumbing AMC – Home (1 Year)', 'Plumbing Inspection & Estimate Visit',
      'Emergency Plumber Visit (Same Day)',
    ]},
  ],
  PEST_CONTROL: [
    { key: 'general-pest-control', name: 'General Pest Control', icon: '🏠', services: [
      'General Pest Control (1BHK)', 'General Pest Control (2BHK)', 'General Pest Control (3BHK)',
      'Full Home Herbal Pest Control (2BHK)', 'Kitchen-Only Pest Treatment',
      'Pre-Shifting Pest Control (Vacant Flat)',
    ]},
    { key: 'cockroach-control', name: 'Cockroach Control', icon: '🪳', services: [
      'Cockroach Control – Gel Treatment (1BHK)', 'Cockroach Control – Gel Treatment (2BHK)',
      'Cockroach Control – Gel Treatment (3BHK)', 'Cockroach Intense Spray + Gel Combo (2BHK)',
    ]},
    { key: 'termite-treatment', name: 'Termite Treatment', icon: '🐜', services: [
      'Termite Spot Treatment (Per Room)', 'Termite Treatment – Post-Construction (Per Sqft)',
      'Termite Treatment – Pre-Construction (Per Sqft)', 'Wood Borer Treatment (Per Room)',
    ]},
    { key: 'rodent-bird-control', name: 'Rodent & Bird Control', icon: '🐀', services: [
      'Rodent Control – Commercial (Monthly)', 'Rodent / Rat Control (Home)',
      'Bird Netting Installation (Per Sqft)', 'Bird Spikes Installation (Per Rft)',
    ]},
    { key: 'mosquito-fly-control', name: 'Mosquito & Fly Control', icon: '🦟', services: [
      'Mosquito Control – Indoor (2BHK)', 'Mosquito Fogging – Society/Outdoor (Per Round)',
      'Flies Control – Kitchen/Restaurant',
    ]},
    { key: 'bedbug-insect-treatment', name: 'Bed Bug & Insect Treatment', icon: '🛏️', services: [
      'Bed Bug Treatment – 2 Services (1BHK)', 'Bed Bug Treatment – 2 Services (2BHK)',
      'Bed Bug Treatment – 2 Services (3BHK)', 'Ant Control Treatment', 'Spider & Silverfish Treatment',
      'Lizard Repellent Treatment', 'Honeybee / Wasp Hive Removal',
      'Snake Repellent Perimeter Treatment (Bungalow)',
    ]},
    { key: 'commercial-specialized', name: 'Commercial & Specialized', icon: '🏭', services: [
      'Godown / Warehouse Fumigation (Per 100 Cbm)', 'Garden Pest & Lawn Treatment',
      'Disinfection & Sanitization Add-on (Per 1000 Sqft)',
    ]},
    { key: 'amc-consultation', name: 'AMC & Consultation', icon: '📅', services: [
      'Pest Control AMC – Commercial (12 Visits)', 'Pest Control AMC – Home (3 Services/Year)',
      'Pest Inspection & Consultation Visit',
    ]},
  ],
  RENOVATION: [
    { key: 'bathroom-renovation', name: 'Bathroom Renovation', icon: '🛁', services: [
      'Bathroom Renovation – Essential', 'Bathroom Renovation – Luxury Spa Style',
      'Bathroom Renovation – Premium', 'Bathroom Retiling Only (Per Bathroom)',
      'Plumbing Line Revamp (Per Bathroom)',
    ]},
    { key: 'kitchen-renovation', name: 'Kitchen Renovation', icon: '🍳', services: [
      'Kitchen Civil Renovation', 'Kitchen Platform Rebuild (Granite)',
      'Kitchen Renovation with Modular Units',
    ]},
    { key: 'full-home-packages', name: 'Full Home Packages', icon: '🏡', services: [
      'Full Home Renovation – 1BHK', 'Full Home Renovation – 2BHK', 'Full Home Renovation – 3BHK',
    ]},
    { key: 'flooring-tiling', name: 'Flooring & Tiling', icon: '🧱', services: [
      'Flooring Replacement (Per Sqft)', 'Wall Tiling Work (Per Sqft)',
    ]},
    { key: 'walls-partition', name: 'Walls & Partition', icon: '🧰', services: [
      'New Partition Wall – Brick (Per Sqft)', 'New Partition Wall – Gypsum/Drywall (Per Sqft)',
      'Structural Crack Repair (Per Rft)', 'POP Punning for Smooth Walls (Per Sqft)',
      'Plastering Work (Per Sqft)', 'Ceiling Leakage & Plaster Repair (Per Sqft)',
    ]},
    { key: 'electrical-fixtures', name: 'Electrical & Fixtures', icon: '💡', services: [
      'Electrical Revamp (Per Room)', 'Door & Frame Replacement Package (Per Door)',
      'Window Replacement – UPVC (Per Sqft)', 'Grill & Railing Replacement (Per Rft)',
    ]},
    { key: 'exterior-common-areas', name: 'Exterior & Common Areas', icon: '🏢', services: [
      'Balcony Makeover (Civil + Flooring)', 'Facade / Elevation Upgrade (Per Sqft)',
      'Terrace Renovation with Waterproofing', 'Society Common Area Renovation (Per Sqft)',
      'Home Extension / Extra Room Construction (Per Sqft)',
    ]},
    { key: 'commercial-renovation', name: 'Commercial Renovation', icon: '🏪', services: [
      'Office Renovation (Per Sqft)', 'Shop Renovation Package (Per Sqft)',
    ]},
    { key: 'consultation-support', name: 'Consultation & Support', icon: '📐', services: [
      'Detailed Renovation Estimate & BOQ', 'Renovation Consultation & Site Survey',
      'Vastu-Based Home Modification Consultation', 'Debris Removal Service (Per Trip)',
      'Wall Demolition & Debris Removal (Per Sqft)',
    ]},
  ],
  CONSTRUCTION: [
    { key: 'house-construction-packages', name: 'House Construction Packages', icon: '🏠', services: [
      'House Construction – Luxury Package (Per Sqft)', 'House Construction – Premium Package (Per Sqft)',
      'House Construction – Standard Package (Per Sqft)', 'Duplex / Villa Construction (Per Sqft)',
      'Turnkey Farmhouse Construction (Per Sqft)', 'Commercial Building Construction (Per Sqft)',
      'Labour-Rate Construction (Per Sqft)',
    ]},
    { key: 'structural-work', name: 'Structural Work', icon: '🏗️', services: [
      'Column & Footing Work (Per Cft)', 'RCC Slab Work (Per Sqft)', 'Steel Reinforcement Work (Per Kg)',
      'Shuttering / Centering Work (Per Sqft)', 'Brickwork (Per Sqft)', 'Plastering (Per Sqft)',
    ]},
    { key: 'site-preparation', name: 'Site Preparation', icon: '🚧', services: [
      'Site Levelling & Earthwork (Per Cft)', 'Demolition of Old Structure (Per Sqft)',
      'Anti-Termite Soil Treatment – Pre-Construction (Per Sqft)', 'Soil Testing (Per Borehole)',
      'Borewell Drilling Coordination (Per Ft)',
    ]},
    { key: 'design-drawings', name: 'Design & Drawings', icon: '📐', services: [
      '3D Elevation Design', 'Architectural Floor Plan (Per Sqft)',
      'Complete Drawing Package (Arch+Structural+MEP)', 'Structural Drawings (Per Sqft)',
      'Building Permission Drawing Support', 'Vastu-Compliant Plan Consultation',
    ]},
    { key: 'compound-boundary', name: 'Compound & Boundary', icon: '🧱', services: [
      'Boundary Wall Construction (Per Rft)', 'Compound Gate Foundation & Fixing',
      'Compound Paving – Paver Blocks (Per Sqft)', 'Kerb Stone / Landscaping Civil Work (Per Rft)',
    ]},
    { key: 'water-utilities', name: 'Water & Utilities', icon: '💧', services: [
      'Rainwater Harvesting Pit', 'Septic Tank Construction',
      'Underground Water Tank Construction (Per 1000L)',
    ]},
    { key: 'project-management', name: 'Project Management', icon: '📊', services: [
      'Construction Estimation & BOQ (Per Project)', 'Construction Site Inspection Visit',
      'Project Management Consultancy (Per Sqft)', 'Site Supervision (Monthly)',
    ]},
  ],
};

async function main() {
  let hadMismatch = false;

  // Validation pass first — confirm our hand-authored lists exactly match the real DB
  // service names for each category before writing anything.
  for (const categoryKey of Object.keys(DATA)) {
    const category = await prisma.serviceCategory.findUnique({
      where: { key: categoryKey },
      include: { services: true },
    });
    if (!category) { console.error('MISSING CATEGORY:', categoryKey); hadMismatch = true; continue; }

    const realNames = new Set(category.services.map((s) => s.name));
    const authoredNames = new Set(DATA[categoryKey].flatMap((sc) => sc.services));

    for (const n of authoredNames) {
      if (!realNames.has(n)) { console.error(`[${categoryKey}] authored name not found in DB: "${n}"`); hadMismatch = true; }
    }
    for (const n of realNames) {
      if (!authoredNames.has(n)) { console.error(`[${categoryKey}] DB service not covered by any subcategory: "${n}"`); hadMismatch = true; }
    }
  }

  if (hadMismatch) {
    console.error('\nValidation failed — fix the mismatches above before running the backfill.');
    process.exit(1);
  }
  console.log('Validation passed: every authored name matches a real DB service, 1:1, per category.\n');

  // Write pass
  for (const categoryKey of Object.keys(DATA)) {
    const category = await prisma.serviceCategory.findUnique({ where: { key: categoryKey } });
    let sortOrder = 0;
    for (const sub of DATA[categoryKey]) {
      const subCat = await prisma.subCategory.upsert({
        where: { categoryId_key: { categoryId: category.id, key: sub.key } },
        create: { categoryId: category.id, key: sub.key, name: sub.name, icon: sub.icon, sortOrder: sortOrder++ },
        update: { name: sub.name, icon: sub.icon, sortOrder: sortOrder - 1 },
      });
      const result = await prisma.service.updateMany({
        where: { categoryId: category.id, name: { in: sub.services } },
        data: { subCategoryId: subCat.id },
      });
      console.log(`${categoryKey} / ${sub.name}: ${result.count} services assigned`);
    }
  }

  const unassigned = await prisma.service.count({ where: { subCategoryId: null, categoryId: { in: (await prisma.serviceCategory.findMany({ where: { key: { in: Object.keys(DATA) } } })).map(c => c.id) } } });
  console.log(`\nDone. Unassigned services remaining in the 5 migrated categories: ${unassigned}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
