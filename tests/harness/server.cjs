// Local full-stack harness for tests/homepage.spec.js: the real backend (ts-node) on a THROWAWAY
// Postgres + the frontend routed like Vercel (files + cleanUrls first, then vercel.json rewrites,
// /api proxied to the backend). Seeds a catalogue shaped like production, including 9 empty
// categories, linked products, deals, taxes and the bundle setting.
//
//   TEST_DATABASE_URL=postgresql://postgres@localhost:55432/<db>  (schema already pushed; must be localhost)
//   node tests/harness/server.cjs          → prints READY and writes tests/harness/info.json
//
// Test-only hook: GET /__test/new-deploy gives the service worker a new build id (= a new deploy).
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND = path.join(ROOT, 'frontend');
const DB = process.env.TEST_DATABASE_URL || '';
if (!/^postgresql:\/\/[^@]*@(localhost|127\.0\.0\.1):\d+\//.test(DB)) throw new Error('TEST_DATABASE_URL must be a local throwaway database');
const JWT_SECRET = 'pw-jwt-secret';
const API_PORT = Number(process.env.API_PORT || 3401), WEB_PORT = Number(process.env.WEB_PORT || 3400);
let swBuild = 'pw-build-1';

Object.assign(process.env, {
  DATABASE_URL: DB, NODE_ENV: 'test', JWT_SECRET, JWT_REFRESH_SECRET: 'pw-refresh',
  RAZORPAY_KEY_ID: 'rzp_test_pw', RAZORPAY_KEY_SECRET: 'pw-key', RAZORPAY_WEBHOOK_SECRET: 'pw-hook', FRONTEND_URL: `http://127.0.0.1:${WEB_PORT}`,
  TS_NODE_PROJECT: path.join(BACKEND, 'tsconfig.json'), TS_NODE_TRANSPILE_ONLY: 'true',
});
require(path.join(BACKEND, 'node_modules/ts-node')).register({ transpileOnly: true, project: path.join(BACKEND, 'tsconfig.json') });
const jwt = require(path.join(BACKEND, 'node_modules/jsonwebtoken'));
const { PrismaClient } = require(path.join(BACKEND, 'node_modules/@prisma/client'));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg' };
const vercel = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'vercel.json'), 'utf8'));
const fileFor = (p) => {
  const f = path.join(FRONTEND, p);
  if (!f.startsWith(FRONTEND)) return null;
  return [f, f + '.html', path.join(f, 'index.html')].find((x) => fs.existsSync(x) && fs.statSync(x).isFile()) || null;
};
function serveStatic(req, res) {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__test/new-deploy') { swBuild = 'pw-build-' + Date.now(); res.writeHead(200); return res.end(swBuild); }
  let hit = fileFor(p);
  if (!hit) for (const r of vercel.rewrites) {
    if (r.source.startsWith('/api/')) continue;
    if (new RegExp('^' + r.source.replace(/:[a-z]+\*?/g, '[^/]+') + '$').test(p)) { hit = fileFor(r.destination); break; }
  }
  if (!hit) { res.writeHead(404); return res.end('not found'); }
  const headers = { 'Content-Type': MIME[path.extname(hit)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
  if (path.basename(hit) === 'firebase-messaging-sw.js') { // what frontend/stamp-sw.js does at deploy time
    res.writeHead(200, headers);
    return res.end(fs.readFileSync(hit, 'utf8').split('__BUILD_ID__').join(swBuild));
  }
  res.writeHead(200, headers);
  fs.createReadStream(hit).pipe(res);
}
function proxy(req, res) {
  const up = http.request({ host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}

(async () => {
  const { NestFactory } = require(path.join(BACKEND, 'node_modules/@nestjs/core'));
  const { AppModule } = require(path.join(BACKEND, 'src/app.module'));
  const { configureHttpApp } = require(path.join(BACKEND, 'src/app.setup'));
  const app = await NestFactory.create(AppModule, { rawBody: true, bodyParser: true, logger: ['error'] });
  configureHttpApp(app);
  await app.listen(API_PORT, '127.0.0.1');

  const prisma = new PrismaClient({ datasources: { db: { url: DB } } });
  const user = (role) => prisma.user.create({ data: { phone: `+9166${String(Date.now()).slice(-6)}${crypto.randomInt(10, 99)}`, name: `PW ${role}`, role, isVerified: true } });
  const admin = await user('SUPER_ADMIN');
  const adminToken = jwt.sign({ sub: admin.id, phone: admin.phone, role: admin.role }, JWT_SECRET, { expiresIn: '12h' });
  const IMG = 'https://res.cloudinary.com/demo/image/upload/sample.jpg';
  const ids = {};

  if (!(await prisma.serviceCategory.count())) {
    const cat = (key, slug, name, icon, sortOrder, extra = {}) => prisma.serviceCategory.create({ data: { key, slug, name, icon, sortOrder, ...extra } });
    const sub = (categoryId, key, name, sortOrder) => prisma.subCategory.create({ data: { categoryId, key, name, sortOrder } });
    const svc = (categoryId, subCategoryId, name, price, extra = {}) => prisma.service.create({ data: {
      categoryId, subCategoryId, name, slug: `pw-${crypto.randomBytes(4).toString('hex')}`, basePrice: price, unit: 'per visit', hsnSac: '998719',
      inclusions: ['Verified professional', '30-day warranty'], description: `${name} by a verified professional.`, durationMinutes: 60, ...extra } });

    const ac = await cat('AC_SERVICE', 'ac-service-repair', 'AC Service & Repair', '❄️', 0, { description: 'Servicing, gas filling and installation.' });
    const acServ = await sub(ac.id, 'ac-servicing', 'AC Servicing', 0), acInst = await sub(ac.id, 'ac-installation', 'AC Installation', 1), acGas = await sub(ac.id, 'gas', 'Gas Filling', 2);
    await sub(ac.id, 'ac-amc', 'AMC & Plans', 3); // no services → its tile must be hidden
    await svc(ac.id, acServ.id, 'Split AC Servicing', 599, { isPopular: true });
    ids.foamJet = (await svc(ac.id, acServ.id, 'AC Foam Jet / Jet Spray Service', 599)).id;
    ids.acInstall = (await svc(ac.id, acInst.id, 'Split AC Installation (1.5 Ton)', 1499)).id;
    await svc(ac.id, acGas.id, 'AC Gas Refill (Full Charge)', 2199);

    const pl = await cat('PLUMBING', 'plumbing', 'Plumbing', '🔧', 1, { description: 'Taps, drains and leaks.' });
    const plTap = await sub(pl.id, 'tap', 'Tap & Faucet', 0), plDr = await sub(pl.id, 'drain', 'Drainage & Blockage', 1);
    ids.tapRepair = (await svc(pl.id, plTap.id, 'Tap Repair (Leak/Drip Fix)', 199, { isPopular: true })).id;
    await svc(pl.id, plTap.id, 'Mixer Installation', 349);
    await svc(pl.id, plDr.id, 'Bathroom Drainage Blockage Removal', 399);

    const pest = await cat('PEST_CONTROL', 'pest-control', 'Pest Control', '🐛', 2, { description: 'Cockroach, termite and bed bug treatments.' });
    const pGen = await sub(pest.id, 'general', 'General Pest Control', 0), pTerm = await sub(pest.id, 'termite', 'Termite Treatment', 1);
    await svc(pest.id, pGen.id, 'General Pest Control (1BHK)', 799, { isPopular: true });
    await svc(pest.id, pTerm.id, 'Termite Spot Treatment', 1299);

    const el = await cat('ELECTRICAL', 'electrical', 'Electrical', '⚡', 3);
    await svc(el.id, null, 'Ceiling Fan Installation', 249, { durationMinutes: 45 });
    await svc(el.id, null, 'MCB Replacement', 299);
    const rn = await cat('RENOVATION', 'renovation', 'Renovation', '🏗️', 4);
    await svc(rn.id, null, 'Bathroom Renovation – Essential', 64999, { durationMinutes: 4320 }); // never "quick"
    const inr = await cat('INTERIOR', 'interior-design', 'Interior Design', '🏠', 5);
    await svc(inr.id, null, 'Full Home Interior Design', 0);

    // The 9 categories that are empty in production right now — must never show.
    ids.empty = [];
    for (const [key, slug, name, i] of [['FALSE-CEILING', 'false-ceiling', 'False Ceiling', 10], ['FABRICATION', 'fabrication-welding', 'Fabrication & Welding', 11],
      ['aluminium-work', null, 'Aluminium Work', 12], ['glass-work', null, 'Glass & Glazing', 13], ['CCTV-SECURITY', 'cctv-security', 'CCTV & Security', 14],
      ['solar', null, 'Solar Installation', 15], ['modular-kitchen', null, 'Modular Kitchen', 16], ['architecture', 'architecture-planning', 'Architecture & Planning', 17],
      ['commercial', null, 'Commercial Fitout', 18]]) {
      ids.empty.push((await cat(key, slug, name, '🏠', i)).id);
    }

    // Taxes (services 18%, platform fee) and the bundle offer setting.
    for (const [appliesTo, hsnCode] of [['SERVICE', '998719'], ['PLATFORM_FEE', '999799']]) {
      await prisma.taxConfig.create({ data: { name: `PW ${appliesTo} 18%`, rate: 18, hsnCode, appliesTo: [appliesTo], approvalStatus: 'APPROVED', approvedBy: admin.id, approvedAt: new Date(), approvalNote: 'test fixture' } });
    }
    await prisma.siteSetting.upsert({ where: { key: 'bundle_discount_percent' }, update: { value: '10' }, create: { key: 'bundle_discount_percent', value: '10', label: 'Bundle discount %', group: 'operations' } });

    // Products: AC/HVAC + plumbing (linked to AC and Plumbing), tools (nothing for pest control).
    const sellerUser = await user('PRODUCT_VENDOR');
    const seller = await prisma.productVendor.create({ data: { userId: sellerUser.id, businessName: 'PW Seller', status: 'ACTIVE', state: 'Madhya Pradesh' } });
    const pcat = (key, name) => prisma.productCategory.create({ data: { key, name, icon: '📦' } });
    const pcAc = await pcat('AC-HVAC', 'AC & HVAC'), pcPl = await pcat('PLUMBING', 'Plumbing'), pcTools = await pcat('TOOLS', 'Tools');
    const prod = (categoryId, name, price, mrp, extra = {}) => prisma.product.create({ data: {
      categoryId, vendorId: seller.id, name, brand: 'PW', slug: `pw-${crypto.randomBytes(4).toString('hex')}`, sku: `PW-${crypto.randomBytes(4).toString('hex')}`,
      price, mrp, stock: 50, gstOverridePercent: 18, gstInclusive: false, isActive: true, description: name, ...extra } });
    const acProduct = await prod(pcAc.id, 'Split AC 1.5 Ton 3 Star', 32000, 42000, { images: [IMG] });
    ids.acProduct = acProduct.id; ids.acProductSlug = acProduct.slug;
    await prod(pcAc.id, 'AC Outdoor Stand', 900, 1400);
    ids.tapProduct = (await prod(pcPl.id, 'Single-Lever Mixer Tap', 2499, 3999)).id;
    await prod(pcTools.id, 'Hand Saw 22 inch', 650, 990);

    const bhopal = await prisma.city.upsert({ where: { name: 'Bhopal' }, update: { isActive: true }, create: { name: 'Bhopal', state: 'Madhya Pradesh', latitude: 23.2599, longitude: 77.4126, isActive: true } });
    await prisma.city.update({ where: { id: bhopal.id }, data: { activeServiceKeys: ['AC_SERVICE', 'PLUMBING', 'PEST_CONTROL', 'ELECTRICAL', 'RENOVATION', 'INTERIOR', 'FALSE-CEILING'] } });
    const pu = await user('SERVICE_VENDOR');
    await prisma.serviceVendor.create({ data: { userId: pu.id, fullName: 'PW Partner', businessName: 'PW Partner', baseCity: 'Bhopal', staffType: 'PARTNER', status: 'ACTIVE', isOnline: true, skills: ['AC_SERVICE', 'PLUMBING'], serviceRadius: 25 } });
  } else {
    const byName = async (name) => (await prisma.service.findFirst({ where: { name } })).id;
    ids.foamJet = await byName('AC Foam Jet / Jet Spray Service');
    ids.acInstall = await byName('Split AC Installation (1.5 Ton)');
    ids.tapRepair = await byName('Tap Repair (Leak/Drip Fix)');
    const acp = await prisma.product.findFirst({ where: { name: 'Split AC 1.5 Ton 3 Star' } });
    ids.acProduct = acp.id; ids.acProductSlug = acp.slug;
    ids.tapProduct = (await prisma.product.findFirst({ where: { name: 'Single-Lever Mixer Tap' } })).id;
    ids.empty = (await prisma.serviceCategory.findMany({ where: { services: { none: {} } }, select: { id: true } })).map((c) => c.id);
  }

  http.createServer((req, res) => (req.url.startsWith('/api/') ? proxy(req, res) : serveStatic(req, res))).listen(WEB_PORT, '127.0.0.1');
  fs.writeFileSync(path.join(__dirname, 'info.json'), JSON.stringify({ web: `http://127.0.0.1:${WEB_PORT}`, adminToken, ids }, null, 2));
  console.log(`READY http://127.0.0.1:${WEB_PORT}`);
})().catch((e) => { console.error('HARNESS FAILED', e); process.exit(1); });
