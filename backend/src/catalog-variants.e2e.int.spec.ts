/* eslint-disable @typescript-eslint/no-var-requires */
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

/**
 * CATALOG VARIANTS end to end — boots the REAL backend (every module, guard and validation pipe)
 * against a THROWAWAY database and drives it over HTTP: admin creates a variant listing from
 * existing rows, the public catalog carries it, checkout snapshots the chosen option onto the
 * order line, later catalog edits leave that order untouched, and removing a listing never
 * deletes a row. Same harness and gate as order-flow.e2e.int.spec.ts.
 *
 * Runs only with E2E_DATABASE_URL pointing at the local throwaway cluster (localhost:55432).
 */
const url = process.env.E2E_DATABASE_URL || '';
const d = /localhost:55432/.test(url) ? describe : describe.skip;
jest.setTimeout(240_000);

const JWT_SECRET = 'e2e-jwt-secret';

d('CATALOG VARIANTS — full application over HTTP (throwaway DB)', () => {
  let app: any;
  let base = '';
  let prisma: PrismaClient;
  const ids: Record<string, any> = {};
  let seq = 0;
  const tag = Date.now().toString(36).toUpperCase();
  const phone = () => `+9177${String(Date.now()).slice(-6)}${String(++seq).padStart(2, '0')}`;
  const token = (u: { id: string; phone: string; role: string }) => jwt.sign({ sub: u.id, phone: u.phone, role: u.role }, JWT_SECRET, { expiresIn: '1h' });

  async function api(method: string, path: string, opts: { as?: any; body?: any } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.as) headers.Authorization = `Bearer ${token(opts.as)}`;
    const res = await fetch(base + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, data: json && typeof json === 'object' && 'data' in json ? json.data : json, raw: json };
  }
  const mkUser = (role: string) => prisma.user.create({ data: { phone: phone(), name: `${role} ${seq}`, role, isVerified: true } as any });
  const mkService = (categoryId: string, name: string, price: number) =>
    prisma.service.create({ data: { categoryId, name, slug: `e2ev-${crypto.randomBytes(4).toString('hex')}`, basePrice: price, hsnSac: '998719', isActive: true } as any });

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: url, NODE_ENV: 'test', JWT_SECRET, JWT_REFRESH_SECRET: 'e2e-refresh',
      RAZORPAY_KEY_ID: 'rzp_test_e2e', RAZORPAY_KEY_SECRET: 'e2e-key', RAZORPAY_WEBHOOK_SECRET: 'e2e-webhook', FRONTEND_URL: 'http://localhost:3000',
    });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('./app.module');
    const { configureHttpApp } = require('./app.setup');
    app = await NestFactory.create(AppModule, { rawBody: true, bodyParser: true, logger: ['error'] });
    configureHttpApp(app);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;

    ids.admin = await mkUser('SUPER_ADMIN');
    ids.customer = await mkUser('CUSTOMER');
    await prisma.city.upsert({ where: { name: 'Bhopal' }, update: { isActive: true }, create: { name: 'Bhopal', state: 'Madhya Pradesh', latitude: 23.2599, longitude: 77.4126, isActive: true } as any });
    ids.cat = await prisma.serviceCategory.create({ data: { key: `E2EV${tag}`, name: 'Pest Control E2E', icon: 'x' } as any });
    ids.otherCat = await prisma.serviceCategory.create({ data: { key: `E2EW${tag}`, name: 'AC E2E', icon: 'x' } as any });
    ids.s1 = await mkService(ids.cat.id, `Pest ${tag} (1BHK)`, 799);
    ids.s2 = await mkService(ids.cat.id, `Pest ${tag} (2BHK)`, 999);
    ids.s3 = await mkService(ids.cat.id, `Pest ${tag} (3BHK)`, 1299);
    ids.ac = await mkService(ids.otherCat.id, `AC ${tag} (1 Ton)`, 999);
    await prisma.commissionRule.create({ data: { ruleType: 'COMMISSION', scope: 'CATEGORY', categoryId: ids.cat.id, commissionType: 'PERCENTAGE', value: 20, isActive: true } as any });
    await prisma.taxConfig.create({ data: { name: `E2EV SERVICE 18% ${tag}`, rate: 18, hsnCode: '998719', appliesTo: ['SERVICE'], approvalStatus: 'APPROVED', approvedBy: ids.admin.id, approvedAt: new Date(), approvalNote: 'e2e fixture' } as any });

    ids.sellerUser = await mkUser('PRODUCT_VENDOR');
    ids.seller = await prisma.productVendor.create({ data: { userId: ids.sellerUser.id, businessName: `Seller ${tag}`, status: 'ACTIVE' } as any });
    ids.pcat = await prisma.productCategory.create({ data: { key: `E2EP${tag}`, name: 'Paint E2E' } as any });
    const mkProduct = (name: string, price: number) => prisma.product.create({ data: {
      vendorId: ids.seller.id, categoryId: ids.pcat.id, name, slug: `e2ev-p-${crypto.randomBytes(4).toString('hex')}`, sku: `E2EV-${crypto.randomBytes(4).toString('hex')}`, price, stock: 10, isActive: true,
    } as any });
    ids.pWhite = await mkProduct(`Enamel ${tag} White 1L`, 450);
    ids.pBlack = await mkProduct(`Enamel ${tag} Black 1L`, 470);
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('suggests the existing size rows as one listing (review only — nothing linked)', async () => {
    const r = await api('GET', '/admin/variant-groups/suggestions?entityType=SERVICE', { as: ids.admin });
    expect(r.status).toBe(200);
    const s = r.data.find((x: any) => x.name === `Pest ${tag}`);
    expect(s.optionNames).toEqual(['Size']);
    expect(s.members.map((m: any) => m.options.Size)).toEqual(['1BHK', '2BHK', '3BHK']);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: ids.s1.id } })).variantGroupId).toBeNull();
  });

  it('rejects ambiguous, cross-category and incomplete listings, and non-admins', async () => {
    const make = (members: any[], as = ids.admin) => api('POST', '/admin/variant-groups', { as, body: { entityType: 'SERVICE', name: `Pest ${tag}`, optionNames: ['Size'], members } });
    let r = await make([{ id: ids.s1.id, options: { Size: '1BHK' } }, { id: ids.s2.id, options: { Size: '1bhk' } }]);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.raw)).toMatch(/same options/);
    r = await make([{ id: ids.s1.id, options: { Size: '1BHK' } }, { id: ids.ac.id, options: { Size: '1 Ton' } }]);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.raw)).toMatch(/different category/);
    r = await make([{ id: ids.s1.id, options: {} }]);
    expect(r.status).toBe(400);
    r = await make([{ id: ids.s1.id, options: { Size: '1BHK' } }], ids.customer);
    expect(r.status).toBe(403);
    expect(await prisma.catalogVariantGroup.count({ where: { name: `Pest ${tag}` } })).toBe(0);
  });

  it('admin creates a listing; the public catalog shows the rows with their group and options', async () => {
    const r = await api('POST', '/admin/variant-groups', { as: ids.admin, body: {
      entityType: 'SERVICE', name: `Pest ${tag}`, optionNames: ['Size'],
      members: [{ id: ids.s1.id, options: { Size: '1BHK' } }, { id: ids.s2.id, options: { Size: '2BHK' } }, { id: ids.s3.id, options: { Size: '3BHK' } }],
    } });
    expect(r.status).toBe(201);
    ids.group = r.data;
    expect(r.data.services).toHaveLength(3);

    const cats = await api('GET', '/services/categories');
    const cat = cats.data.find((c: any) => c.id === ids.cat.id);
    const s2 = cat.services.find((s: any) => s.id === ids.s2.id);
    expect(s2.variantGroup).toEqual({ id: ids.group.id, name: `Pest ${tag}`, optionNames: ['Size'], isActive: true, description: null, images: [] });
    expect(s2.variantOptions).toEqual({ Size: '2BHK' });
    expect(Number(s2.basePrice)).toBe(999); // each option keeps its own price
  });

  it('a listing carries ONE common description + up to 5 uploaded images, public on the catalog', async () => {
    const imgs = (n: number) => Array.from({ length: n }, (_, i) => `https://res.cloudinary.com/demo/image/upload/v1/pest-${i}.webp`);
    let r = await api('PATCH', `/admin/variant-groups/${ids.group.id}`, { as: ids.admin, body: { images: imgs(6) } });
    expect(r.status).toBe(400);
    r = await api('PATCH', `/admin/variant-groups/${ids.group.id}`, { as: ids.admin, body: { images: ['data:image/png;base64,AAAA'] } });
    expect(r.status).toBe(400);
    r = await api('PATCH', `/admin/variant-groups/${ids.group.id}`, { as: ids.admin, body: { images: imgs(2), description: 'Odourless gel + spray for every room.' } });
    expect(r.status).toBe(200);
    expect(r.data.images).toEqual(imgs(2));

    const cats = await api('GET', '/services/categories');
    const s1 = cats.data.find((c: any) => c.id === ids.cat.id).services.find((s: any) => s.id === ids.s1.id);
    expect(s1.variantGroup).toEqual(expect.objectContaining({ description: 'Odourless gel + spray for every room.', images: imgs(2) }));
    // members keep their own rows untouched — the common content lives on the listing only
    expect((await prisma.service.findUniqueOrThrow({ where: { id: ids.s1.id } })).images).toEqual([]);
    const pub = await api('GET', `/catalog/variant-groups/${ids.group.id}`);
    expect(pub.data).toEqual(expect.objectContaining({ description: 'Odourless gel + spray for every room.', images: imgs(2) }));
    // other fields are left alone when images/description are not sent
    await api('PATCH', `/admin/variant-groups/${ids.group.id}`, { as: ids.admin, body: { name: `Pest ${tag}` } });
    expect((await prisma.catalogVariantGroup.findUniqueOrThrow({ where: { id: ids.group.id } })).images).toEqual(imgs(2));
  });

  it('the generic service edit form cannot unlink or re-key a variant', async () => {
    const r = await api('PATCH', `/admin/services/${ids.s3.id}`, { as: ids.admin, body: { description: 'edited', variantGroupId: null, variantOptions: { Size: 'XL' } } });
    expect(r.status).toBeLessThan(300);
    const s3 = await prisma.service.findUniqueOrThrow({ where: { id: ids.s3.id } });
    expect(s3.description).toBe('edited');
    expect(s3.variantGroupId).toBe(ids.group.id);
    expect(s3.variantOptions).toEqual({ Size: '3BHK' });
  });

  it('checkout of the 2BHK option charges its own price and snapshots the choice on the order line', async () => {
    const co = await api('POST', '/master-orders/public/checkout', { body: {
      name: 'E2E Variant Customer', phone: phone(), items: [{ type: 'SERVICE', serviceId: ids.s2.id, quantity: 1 }],
      fullAddress: '12 Test Road, Arera Colony', city: 'Bhopal', state: 'Madhya Pradesh', pincode: '462016', latitude: 23.2156, longitude: 77.4304,
      paymentMethod: 'COD', idempotencyKey: `idem-${crypto.randomBytes(6).toString('hex')}`,
    } });
    expect(co.status).toBe(201);
    const child = await prisma.order.findFirstOrThrow({ where: { masterOrderId: co.data.masterOrderId }, include: { serviceItems: true } });
    ids.orderId = child.id;
    expect(child.serviceId).toBe(ids.s2.id);
    expect(child.serviceItems).toHaveLength(1);
    const line = child.serviceItems[0];
    expect(Number(line.unitPrice)).toBe(999);
    expect(line.itemName).toBe(`Pest ${tag} (2BHK)`);
    expect(line.variantGroupId).toBe(ids.group.id);
    expect(line.variantOptions).toEqual([{ name: 'Size', value: '2BHK' }]);
  });

  it('later catalog edits (rename, re-price, re-key, remove listing) never change the past order', async () => {
    await api('PATCH', `/admin/variant-groups/${ids.group.id}`, { as: ids.admin, body: {
      name: `Pest Renamed ${tag}`, optionNames: ['Flat size'],
      members: [{ id: ids.s1.id, options: { 'Flat size': '1 BHK' } }, { id: ids.s2.id, options: { 'Flat size': '2 BHK' } }, { id: ids.s3.id, options: { 'Flat size': '3 BHK' } }],
    } });
    await api('PATCH', `/admin/services/${ids.s2.id}`, { as: ids.admin, body: { name: `Pest ${tag} — Two Bedroom`, basePrice: 1111 } });
    const del = await api('DELETE', `/admin/variant-groups/${ids.group.id}`, { as: ids.admin });
    expect(del.status).toBe(200);

    const line = await prisma.orderServiceItem.findFirstOrThrow({ where: { orderId: ids.orderId } });
    expect(line.itemName).toBe(`Pest ${tag} (2BHK)`);
    expect(line.variantOptions).toEqual([{ name: 'Size', value: '2BHK' }]);
    expect(Number(line.unitPrice)).toBe(999);

    // removing the listing only unlinked the rows — all three still exist and are bookable
    const rows = await prisma.service.findMany({ where: { id: { in: [ids.s1.id, ids.s2.id, ids.s3.id] } } });
    expect(rows).toHaveLength(3);
    expect(rows.every((s) => s.isActive && s.variantGroupId === null && s.variantOptions === null)).toBe(true);
    expect(await prisma.catalogVariantGroup.count({ where: { id: ids.group.id } })).toBe(0);
  });

  it('products: a seller cannot attach a product to a listing; admin listings are public on the product page', async () => {
    const pg = await api('POST', '/admin/variant-groups', { as: ids.admin, body: {
      entityType: 'PRODUCT', name: `Enamel ${tag} 1L`, optionNames: ['Colour'],
      members: [{ id: ids.pWhite.id, options: { Colour: 'White' } }],
    } });
    expect(pg.status).toBe(201);

    // the seller tries to put their other product into it through the normal product edit
    const sp = await api('PATCH', `/products/${ids.pBlack.id}`, { as: ids.sellerUser, body: { description: 'new desc', variantGroupId: pg.data.id, variantOptions: { Colour: 'Black' } } });
    expect(sp.status).toBeLessThan(300);
    const black = await prisma.product.findUniqueOrThrow({ where: { id: ids.pBlack.id } });
    expect(black.description).toBe('new desc');
    expect(black.variantGroupId).toBeNull();

    // admin adds it properly
    const up = await api('PUT', `/admin/variant-groups/${pg.data.id}/members`, { as: ids.admin, body: { members: [
      { id: ids.pWhite.id, options: { Colour: 'White' } }, { id: ids.pBlack.id, options: { Colour: 'Black' } },
    ] } });
    expect(up.status).toBe(200);

    const pub = await api('GET', `/catalog/variant-groups/${pg.data.id}`);
    expect(pub.status).toBe(200);
    expect(pub.data.optionNames).toEqual(['Colour']);
    expect(pub.data.members.map((m: any) => m.variantLabel).sort()).toEqual(['Colour: Black', 'Colour: White']);
    expect(pub.data.members.every((m: any) => m.slug && m.price != null)).toBe(true);

    const page = await api('GET', `/products/${ids.pWhite.slug}`);
    expect(page.data.variantGroup).toEqual({ id: pg.data.id, name: `Enamel ${tag} 1L`, optionNames: ['Colour'], isActive: true, description: null, images: [] });

    // a disabled listing is no longer public (rows show separately again)
    await api('PATCH', `/admin/variant-groups/${pg.data.id}`, { as: ids.admin, body: { isActive: false } });
    expect((await api('GET', `/catalog/variant-groups/${pg.data.id}`)).status).toBe(404);
  });
});
