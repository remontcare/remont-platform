import 'reflect-metadata';
import { UserRole } from '@prisma/client';
import { LegalService, AdminLegalController, LegalController, recordPolicyAcceptances } from './legal.module';
import { POLICY_TEMPLATES } from './legal.templates';
import { ROLES_KEY } from '../../common';

/**
 * Workflow tests for the Legal & Policies CMS against a small in-memory Prisma
 * fake (just the calls LegalService makes), so versioning rules are exercised
 * end-to-end rather than through per-call mocks.
 */

type Row = Record<string, any>;
let seq = 0;
const id = () => `id${++seq}`;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(v);
      if ('not' in cond) return cond.not === null ? v != null : v !== cond.not;
      if ('contains' in cond) return String(v || '').toLowerCase().includes(String(cond.contains).toLowerCase());
    }
    return v === cond;
  });
}

function makeDb() {
  const tables: Record<string, Row[]> = {
    legalPolicy: [], legalPolicyVersion: [], legalPolicySection: [], policyAcceptance: [], auditLog: [], siteSetting: [], user: [],
  };
  const withRelations = (table: string, row: Row, include?: Row): Row => {
    if (!include) return { ...row };
    const out: Row = { ...row };
    if (table === 'legalPolicyVersion' && include.sections) {
      const w = include.sections.where || {};
      out.sections = tables.legalPolicySection.filter((s) => s.versionId === row.id && matches(s, w)).sort((a, b) => a.sortOrder - b.sortOrder);
    }
    if (table === 'legalPolicyVersion' && include._count) out._count = { sections: tables.legalPolicySection.filter((s) => s.versionId === row.id).length };
    if (table === 'legalPolicySection' && include.version) out.version = tables.legalPolicyVersion.find((v) => v.id === row.versionId);
    if (table === 'legalPolicy' && include.versions) {
      out.versions = tables.legalPolicyVersion.filter((v) => v.policyId === row.id && matches(v, include.versions.where))
        .map((v) => ({ ...v, _count: { sections: tables.legalPolicySection.filter((s) => s.versionId === v.id).length } }));
    }
    return out;
  };
  const sortRows = (rows: Row[], orderBy?: Row | Row[]) => {
    const orders = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
    return [...rows].sort((a, b) => {
      for (const o of orders) {
        const [k, dir] = Object.entries(o)[0] as [string, string];
        if (a[k] < b[k]) return dir === 'asc' ? -1 : 1;
        if (a[k] > b[k]) return dir === 'asc' ? 1 : -1;
      }
      return 0;
    });
  };
  const model = (table: string) => ({
    findUnique: async ({ where, include }: Row) => { const r = tables[table].find((x) => matches(x, where)); return r ? withRelations(table, r, include) : null; },
    findFirst: async ({ where, include }: Row = {}) => { const r = tables[table].find((x) => matches(x, where)); return r ? withRelations(table, r, include) : null; },
    findMany: async ({ where, include, orderBy, take, select }: Row = {}) => sortRows(tables[table].filter((x) => matches(x, where)), orderBy).slice(0, take || undefined)
      .map((r) => withRelations(table, r, include))
      .map((r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r)),
    create: async ({ data }: Row) => {
      if (table === 'legalPolicy' && tables.legalPolicy.some((p) => p.slug === data.slug)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      if (table === 'legalPolicyVersion' && tables.legalPolicyVersion.some((v) => v.policyId === data.policyId && v.version === data.version)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      const now = new Date(Date.now() + seq);
      const defaults = table === 'legalPolicy' ? { showInFooter: true } : {};
      const r = { id: id(), createdAt: now, updatedAt: now, sortOrder: 0, ...defaults, ...data };
      tables[table].push(r); return { ...r };
    },
    createMany: async ({ data }: Row) => { for (const d of data) await model(table).create({ data: d }); return { count: data.length }; },
    update: async ({ where, data }: Row) => {
      const r = tables[table].find((x) => matches(x, where)); if (!r) throw new Error(`${table} not found`);
      Object.assign(r, data, { updatedAt: new Date(Date.now() + ++seq) }); return { ...r };
    },
    updateMany: async ({ where, data }: Row) => { const rs = tables[table].filter((x) => matches(x, where)); rs.forEach((r) => Object.assign(r, data)); return { count: rs.length }; },
    upsert: async ({ where, create, update }: Row) => { const r = tables[table].find((x) => matches(x, where)); return r ? model(table).update({ where, data: update }) : model(table).create({ data: create }); },
    delete: async ({ where }: Row) => { const i = tables[table].findIndex((x) => matches(x, where)); const [r] = tables[table].splice(i, 1); return r; },
    aggregate: async () => ({ _max: { sortOrder: Math.max(0, ...tables[table].map((r) => r.sortOrder || 0)) } }),
    groupBy: async ({ where }: Row) => {
      const m = new Map<string, number>();
      tables[table].filter((x) => matches(x, where)).forEach((r) => m.set(r.version, (m.get(r.version) || 0) + 1));
      return [...m].map(([version, n]) => ({ version, _count: { _all: n } }));
    },
  });
  const prisma: any = { tables };
  for (const t of Object.keys(tables)) prisma[t] = model(t);
  prisma.$transaction = async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg));
  return prisma;
}

const admin = { sub: 'admin1', role: UserRole.ADMIN, phone: '1', name: 'Asha Admin' } as any;

const LEGAL_INFO = {
  COMPANY_LEGAL_NAME: 'Test Legal Pvt Ltd', COMPANY_ADDRESS: '1 Test Road, Bhopal', SUPPORT_EMAIL: 'help@example.com',
  SUPPORT_PHONE: '+91 00000 00000', GRIEVANCE_OFFICER: 'Test Officer, Grievance Officer', GRIEVANCE_EMAIL: 'grievance@example.com', GSTIN: 'TESTGSTIN',
};

/** legalInfo=false leaves Legal Information as seeded (only brand, website and privacy email). */
async function setup(legalInfo = true) {
  const prisma = makeDb();
  const svc = new LegalService(prisma);
  await svc.ensureDefaultPolicies();
  if (legalInfo) await svc.setLegalInfo({ values: LEGAL_INFO }, admin);
  return { prisma, svc };
}

describe('LegalService — seeding & hierarchy', () => {
  it('seeds every built-in main policy once, as an unpublished v0.1 draft with its sections', async () => {
    const { prisma, svc } = await setup();
    expect(prisma.tables.legalPolicy).toHaveLength(POLICY_TEMPLATES.length);
    expect(POLICY_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    expect(POLICY_TEMPLATES.length).toBeLessThanOrEqual(12);
    for (const p of prisma.tables.legalPolicy) {
      expect(p.status).toBe('DRAFT');
      expect(p.currentVersionId).toBeFalsy();
      const versions = prisma.tables.legalPolicyVersion.filter((v: Row) => v.policyId === p.id);
      expect(versions.map((v: Row) => [v.version, v.status])).toEqual([['0.1', 'DRAFT']]);
    }
    const privacy = (await svc.list({})).find((p) => p.slug === 'privacy-policy')!;
    expect(privacy.sectionCount).toBe(24);
    // Idempotent: a second run creates nothing and never overwrites.
    expect(await svc.ensureDefaultPolicies()).toEqual([]);
    expect(prisma.tables.legalPolicy).toHaveLength(POLICY_TEMPLATES.length);
  });

  it('templates never assert unverified compliance claims', () => {
    const all = JSON.stringify(POLICY_TEMPLATES).toLowerCase();
    for (const banned of ['100% compliant', 'legally mandatory', 'guaranteed', 'meta approval', 'play approval', 'intermediary', '27aabct', 'background-verified', 'police verified', 'aadhaar verified', 'todo', 'fixme']) expect(all).not.toContain(banned);
    // Privacy covers the Meta channels and AI disclosure.
    const privacy = POLICY_TEMPLATES.find((t) => t.slug === 'privacy-policy')!;
    const text = JSON.stringify(privacy.sections);
    for (const w of ['WhatsApp', 'Messenger', 'Instagram', 'conversation metadata', 'webhook events', 'hand the conversation to a human', 'create or update a lead', 'summarise a conversation', 'may contain errors', 'not a human and not a technician', 'PhonePe', 'Google Fonts', 'UTM', 'Aadhaar', 'police verification certificate', 'Self-service account deletion is not yet available', '{{PRIVACY_EMAIL}}', 'verifiable consent of a parent or lawful guardian', 'Data Protection Board of India', 'not employees', 'does not knowingly support or authorise fraud', 'Nothing in this policy or other platform documentation is intended to exclude, restrict or waive any liability']) expect(text).toContain(w);
    // Privacy must be publishable once Legal Information is complete — no [[placeholders]].
    expect(text).not.toContain('[[');
  });

  it('nothing is public until published', async () => {
    const { svc } = await setup();
    expect(await svc.publicList()).toEqual([]);
    await expect(svc.publicPolicy('privacy')).rejects.toThrow('Policy not found');
  });
});

describe('LegalService — versioning', () => {
  it('publish → edit creates next draft → publish archives previous → restore creates a newer draft', async () => {
    const { prisma, svc } = await setup();
    const { policy } = await svc.getPolicy('privacy-policy');

    // Privacy has no placeholders: with Legal Information complete it publishes without confirmation.
    const pub1 = await svc.publish(policy.id, {}, admin);
    expect(pub1).toMatchObject({ published: true, version: '1.0' });
    let p = await svc.findPolicy(policy.id);
    expect(p).toMatchObject({ status: 'PUBLISHED', currentVersion: '1.0', publishedByName: 'Asha Admin' });
    const v10 = p.currentVersionId!;

    // Published version is immutable.
    const liveSection = prisma.tables.legalPolicySection.find((s: Row) => s.versionId === v10);
    await expect(svc.updateSection(liveSection.id, { content: 'x' }, admin)).rejects.toThrow(/cannot be edited/);
    await expect(svc.addSection(v10, { title: 'X' }, admin)).rejects.toThrow(/cannot be edited/);

    // Editing → draft 1.1 copied from 1.0; calling again returns the same draft.
    const d11 = await svc.ensureDraft(policy.id, admin);
    expect(d11.version).toBe('1.1');
    expect(d11.sections).toHaveLength(24);
    expect((await svc.ensureDraft(policy.id, admin)).id).toBe(d11.id);
    await svc.updateSection(d11.sections[0].id, { content: '<p>Updated intro</p>' }, admin);
    expect(prisma.tables.legalPolicySection.find((s: Row) => s.id === liveSection.id).content).not.toBe('<p>Updated intro</p>');

    await svc.publish(policy.id, { force: true }, admin);
    p = await svc.findPolicy(policy.id);
    expect(p.currentVersion).toBe('1.1');
    const statuses = Object.fromEntries(prisma.tables.legalPolicyVersion.filter((v: Row) => v.policyId === policy.id).map((v: Row) => [v.version, v.status]));
    expect(statuses).toEqual({ '1.0': 'ARCHIVED', '1.1': 'PUBLISHED' });
    expect(prisma.tables.legalPolicyVersion.filter((v: Row) => v.policyId === policy.id && v.status === 'PUBLISHED')).toHaveLength(1);

    // Restore 1.0 → new draft 1.2 with 1.0's content; 1.1 stays live; history kept.
    const d12 = await svc.restore(v10, {}, admin);
    expect(d12.version).toBe('1.2');
    expect(d12.restoredFromVersionId).toBe(v10);
    expect(d12.sections[0].content).toBe(liveSection.content);
    expect((await svc.findPolicy(policy.id)).currentVersion).toBe('1.1');
    await expect(svc.restore(v10, {}, admin)).rejects.toThrow(/already exists/);
    const d13 = await svc.restore(v10, { replaceDraft: true }, admin);
    expect(d13.version).toBe('1.3');
    expect(prisma.tables.legalPolicyVersion.filter((v: Row) => v.policyId === policy.id)).toHaveLength(4); // nothing deleted

    // Every action is audited against the policy.
    const actions = prisma.tables.auditLog.filter((a: Row) => a.targetId === policy.id).map((a: Row) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['LEGAL_POLICY_PUBLISHED', 'LEGAL_POLICY_DRAFT_CREATED', 'LEGAL_SECTION_UPDATED', 'LEGAL_VERSION_RESTORED', 'LEGAL_DRAFT_DISCARDED']));
  });

  it('unpublish hides the page, publish without a draft re-publishes, archive/unarchive', async () => {
    const { svc } = await setup();
    const { policy } = await svc.getPolicy('terms-and-conditions');
    await svc.publish(policy.id, { force: true }, admin);
    expect(await svc.publicPolicy('terms')).toMatchObject({ title: 'Terms & Conditions', version: '1.0' });

    await svc.unpublish(policy.id, admin);
    await expect(svc.publicPolicy('terms')).rejects.toThrow('Policy not found');
    expect(await svc.publicList()).toEqual([]);

    await svc.publish(policy.id, {}, admin);
    expect(await svc.publicPolicy('terms')).toMatchObject({ version: '1.0' });

    await svc.archive(policy.id, admin);
    await expect(svc.publicPolicy('terms')).rejects.toThrow();
    await expect(svc.publish(policy.id, { force: true }, admin)).rejects.toThrow(/archive/);
    expect((await svc.list({})).some((p) => p.id === policy.id)).toBe(false);
    expect((await svc.list({ status: 'ARCHIVED' })).map((p) => p.id)).toEqual([policy.id]);
    expect((await svc.unarchive(policy.id, admin)).status).toBe('UNPUBLISHED');
  });
});

describe('LegalService — publishing safety', () => {
  it('blocks publishing (even forced) while critical Legal Information used by the policy is missing', async () => {
    const { svc } = await setup(false);
    const privacy = await svc.findPolicy('privacy-policy');
    await expect(svc.publish(privacy.id, { force: true }, admin)).rejects.toThrow(/Legal Information.*Registered legal entity name.*Grievance Officer/);
    expect((await svc.findPolicy(privacy.id)).status).toBe('DRAFT');
    // Privacy email is pre-filled from the verified contact, so it is not reported missing.
    expect((await svc.getLegalInfo()).find((v) => v.name === 'PRIVACY_EMAIL')!.value).toBe('remont.care@gmail.com');
    // Policies that use no critical variables are not blocked by them.
    const cookie = await svc.findPolicy('cookie-technology-policy');
    expect(await svc.publish(cookie.id, {}, admin)).toMatchObject({ published: true });
  });

  it('GSTIN is an admin-editable field and Grievance cannot publish without it', async () => {
    const { svc } = await setup(false);
    await svc.setLegalInfo({ values: { ...LEGAL_INFO, GSTIN: '' } }, admin);
    const g = await svc.findPolicy('grievance-legal-policy');
    await expect(svc.publish(g.id, { force: true }, admin)).rejects.toThrow(/GSTIN/);
    await svc.setLegalInfo({ values: { GSTIN: 'TESTGSTIN' } }, admin);
    expect(await svc.publish(g.id, { force: true }, admin)).toMatchObject({ published: true });
    expect(JSON.stringify(await svc.publicPolicy('grievance-policy'))).toContain('TESTGSTIN');
  });

  it('[[placeholders]] only need confirmation, they never block the CMS', async () => {
    const { svc } = await setup();
    const t = await svc.findPolicy('terms-and-conditions');
    const r: any = await svc.publish(t.id, {}, admin);
    expect(r).toMatchObject({ published: false, requiresConfirmation: true });
    expect(r.placeholders.length).toBeGreaterThan(0);
    expect(await svc.publish(t.id, { force: true }, admin)).toMatchObject({ published: true });
  });
});

describe('LegalService — sections', () => {
  it('add / duplicate / reorder / disable / delete on the draft', async () => {
    const { svc } = await setup();
    const { working } = await svc.getPolicy('cookie-technology-policy');
    const vId = working!.id;
    const base = working!.sections.length;

    const added = await svc.addSection(vId, { title: '<b>New</b> Section', content: '<p onclick="x()">Hi<script>alert(1)</script></p>' }, admin);
    expect(added.title).toBe('New Section');
    expect(added.content).toBe('<p>Hi</p>');
    expect(added.slug).toBe('new-section');

    const dup = await svc.duplicateSection(added.id, admin);
    expect(dup.title).toBe('New Section (copy)');
    let v = await svc.getVersion(vId);
    const ids = v.sections.map((s) => s.id);
    expect(ids.indexOf(dup.id)).toBe(ids.indexOf(added.id) + 1);

    const reversed = [...ids].reverse();
    v = await svc.reorder(vId, { sectionIds: reversed }, admin);
    expect(v.sections.map((s) => s.id)).toEqual(reversed);
    await expect(svc.reorder(vId, { sectionIds: reversed.slice(1) }, admin)).rejects.toThrow(/exactly once/);

    await svc.updateSection(added.id, { isActive: false }, admin);
    const preview = await svc.preview(vId);
    expect(preview.sections.map((s: any) => s.title)).not.toContain('New Section');
    expect(preview.sections.map((s: any) => s.title)).toContain('New Section (copy)');

    await svc.deleteSection(dup.id, admin);
    expect((await svc.getVersion(vId)).sections).toHaveLength(base + 1);
  });

  it('public render substitutes variables, escapes them, and omits inactive sections', async () => {
    const { prisma, svc } = await setup();
    await svc.setLegalInfo({ values: { COMPANY_NAME: 'Remont <India>', SUPPORT_EMAIL: 'help@example.com', NOT_A_VAR: 'x' } }, admin);
    expect(prisma.tables.siteSetting.find((s: Row) => s.key === 'legal_company_name').value).toBe('Remont'); // tags stripped
    await svc.setLegalInfo({ values: { COMPANY_NAME: 'Remont & Co' } }, admin);
    const { policy, working } = await svc.getPolicy('ai-communication-policy');
    await svc.updateSection(working!.sections[0].id, { content: '<p>{{COMPANY_NAME}} v{{POLICY_VERSION}} — {{SUPPORT_EMAIL}}</p>' }, admin);
    await svc.updateSection(working!.sections[1].id, { isActive: false }, admin);
    await svc.publish(policy.id, { force: true }, admin);

    const page = await svc.publicPolicy('ai-policy');
    expect(page.sections[0].html).toBe('<p>Remont &amp; Co v1.0 — help@example.com</p>');
    expect(page.sections.map((s: any) => s.title)).not.toContain(working!.sections[1].title);
    expect(page.canonical).toBe('https://www.remontindia.com/ai-policy');
    expect(page.seoTitle).toContain('AI & Communication Policy');
    expect(page).not.toHaveProperty('missingVariables');
    // Same doc reachable by slug.
    expect((await svc.publicPolicy('ai-communication-policy')).title).toBe(page.title);
    expect(await svc.publicList()).toEqual([expect.objectContaining({ publicPath: '/ai-policy', version: '1.0', showInFooter: true })]);
  });

  it('sanitises even content written straight to the DB when rendering publicly', async () => {
    const { prisma, svc } = await setup();
    const { policy, working } = await svc.getPolicy('payment-policy');
    await svc.publish(policy.id, { force: true }, admin);
    prisma.tables.legalPolicySection.find((s: Row) => s.id === working!.sections[0].id).content = '<img src=x onerror=alert(1)><p>ok</p>';
    const page = await svc.publicPolicy('payment-policy');
    expect(page.sections[0].html).toBe('<p>ok</p>');
  });
});

describe('LegalService — custom policies', () => {
  it('creates a custom main policy as a draft with recommended sections at /policy/<slug>', async () => {
    const { svc } = await setup();
    const res = await svc.create({ title: 'Shipping Policy', category: 'Marketplace', description: 'Delivery rules' }, admin);
    expect(res.policy).toMatchObject({ slug: 'shipping-policy', publicPath: '/policy/shipping-policy', status: 'DRAFT', policyType: 'CUSTOM' });
    expect(res.working!.version).toBe('0.1');
    expect(res.working!.sections.length).toBeGreaterThan(3);
    await expect(svc.create({ title: 'Shipping Policy' }, admin)).rejects.toThrow(/already exists/);
    await expect(svc.create({ title: 'Privacy', slug: 'privacy-policy' }, admin)).rejects.toThrow(/built-in/);
  });
});

describe('Policy acceptance', () => {
  it('records the exact published version and skips unpublished policies', async () => {
    const { prisma, svc } = await setup();
    const terms = await svc.findPolicy('terms-and-conditions');
    await svc.publish(terms.id, { force: true }, admin);
    const n = await recordPolicyAcceptances(prisma, { policySlugs: ['terms-and-conditions', 'partner-policy'], subjectType: 'PARTNER_REGISTRATION', subjectId: 'PR-1', userId: 'u1' });
    expect(n).toBe(1);
    expect(prisma.tables.policyAcceptance).toEqual([expect.objectContaining({ policyId: terms.id, version: '1.0', subjectType: 'PARTNER_REGISTRATION', userId: 'u1' })]);
  });

  it('never throws, even if the tables are unavailable', async () => {
    await expect(recordPolicyAcceptances({} as any, { policySlugs: ['x'], subjectType: 'T' })).resolves.toBe(0);
  });

  it('customer accept is idempotent and rejects a stale version', async () => {
    const { svc } = await setup();
    const terms = await svc.findPolicy('terms-and-conditions');
    await svc.publish(terms.id, { force: true }, admin);
    const cust = { sub: 'c1', role: UserRole.CUSTOMER } as any;
    const a = await svc.accept({ policy: 'terms' }, cust);
    expect(a).toMatchObject({ version: '1.0', subjectType: 'CUSTOMER', userId: 'c1' });
    expect((await svc.accept({ policy: 'terms' }, cust)).id).toBe(a.id);
    await expect(svc.accept({ policy: 'terms', versionId: 'old' }, cust)).rejects.toThrow(/updated/);
  });
});

describe('RBAC metadata', () => {
  it('admin controller requires ADMIN or SUPER_ADMIN', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminLegalController)).toEqual([UserRole.ADMIN, UserRole.SUPER_ADMIN]);
    expect(Reflect.getMetadata('__guards__', AdminLegalController)).toHaveLength(2);
  });
  it('public reads are @Public, accept requires auth', () => {
    const proto = LegalController.prototype as any;
    expect(Reflect.getMetadata('isPublic', proto.list)).toBe(true);
    expect(Reflect.getMetadata('isPublic', proto.get)).toBe(true);
    expect(Reflect.getMetadata('isPublic', proto.accept)).toBeUndefined();
    expect(Reflect.getMetadata('__guards__', proto.accept)).toHaveLength(1);
  });
});
