import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Starting cleanup...');

  // 1. Delete reviews (no cascade from Order)
  const rev = await prisma.review.deleteMany({});
  console.log(`✅ Reviews deleted: ${rev.count}`);

  // 2. Delete invoices (no cascade from Order)
  const inv = await prisma.invoice.deleteMany({});
  console.log(`✅ Invoices deleted: ${inv.count}`);

  // 3. Delete all orders (cascades: OrderItem, ExtraWorkItem)
  const ord = await prisma.order.deleteMany({});
  console.log(`✅ Orders deleted: ${ord.count}`);

  // 4. Delete cityServices (needed before service delete)
  const cs = await prisma.cityService.deleteMany({});
  console.log(`✅ CityServices deleted: ${cs.count}`);

  // 5. Delete all services
  const svc = await prisma.service.deleteMany({});
  console.log(`✅ Services deleted: ${svc.count}`);

  // 6. Delete inactive categories (duplicate old ones)
  const inactiveCats = await prisma.serviceCategory.findMany({ where: { isActive: false } });
  let catDel = 0;
  for (const cat of inactiveCats) {
    await prisma.serviceCategory.delete({ where: { id: cat.id } });
    console.log(`✅ Deleted inactive category: ${cat.name} (${cat.key})`);
    catDel++;
  }
  console.log(`✅ Inactive categories deleted: ${catDel}`);

  console.log('\n🎉 CLEANUP COMPLETE!');
  console.log('Ab naye services upload karo. Active categories safe hain.');
}

main().catch(e => { console.error('❌ ERROR:', e.message); process.exit(1); }).finally(() => prisma.$disconnect());
