// One-off backfill: normalize existing ServiceVendor.skills onto real ServiceCategory.key
// values, mirroring normalizeSkillKey() in backend/src/common/index.ts (kept in sync by
// hand since this is a plain Node script, not compiled TS).
// Run once against production: DATABASE_URL="<DATABASE_PUBLIC_URL>" node prisma/normalize-vendor-skills.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SKILL_KEY_ALIASES = {
  PLUMBER: 'PLUMBING',
  ELECTRICIAN: 'ELECTRICAL',
  CIVIL: 'CONSTRUCTION',
  PEST: 'PEST_CONTROL',
};
function normalizeSkillKey(raw) {
  const key = String(raw || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return SKILL_KEY_ALIASES[key] || key;
}

async function main() {
  const vendors = await prisma.serviceVendor.findMany({ select: { id: true, fullName: true, skills: true } });
  let changed = 0;
  for (const v of vendors) {
    const normalized = v.skills.map(normalizeSkillKey);
    const isDifferent = JSON.stringify(normalized) !== JSON.stringify(v.skills);
    if (isDifferent) {
      await prisma.serviceVendor.update({ where: { id: v.id }, data: { skills: normalized } });
      console.log(v.fullName, ':', JSON.stringify(v.skills), '->', JSON.stringify(normalized));
      changed++;
    }
  }
  console.log(`\nDone. ${changed} of ${vendors.length} vendors updated.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
