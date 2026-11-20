import { PrismaService } from './src/prisma/prisma.module';

const prisma = new PrismaService();

async function main() {
  try {
    console.log('\n📋 Checking order relationships...\n');

    // Check the order that HAS a transaction
    const order1 = await prisma.order.findUnique({
      where: { id: 'cmwhvxpnl002f98s317ylh6g3' },
      select: {
        id: true,
        orderNumber: true,
        totalAmount: true,
        paymentStatus: true,
        status: true,
        masterOrderId: true,
      },
    });

    console.log('Order WITH transaction:');
    console.log(JSON.stringify(order1, null, 2));

    // Check OUR problematic order
    const order2 = await prisma.order.findFirst({
      where: { orderNumber: 'REM-1794750210856-581064' },
      select: {
        id: true,
        orderNumber: true,
        totalAmount: true,
        paymentStatus: true,
        status: true,
        masterOrderId: true,
        customerId: true,
        createdAt: true,
      },
    });

    console.log('\nOur problematic order:');
    console.log(JSON.stringify(order2, null, 2));

    // Check relationship
    if (order1?.masterOrderId && order2?.masterOrderId) {
      console.log('\n🔗 Relationship:');
      console.log('   Order 1 master:', order1.masterOrderId);
      console.log('   Order 2 master:', order2.masterOrderId);
      if (order1.masterOrderId === order2.masterOrderId) {
        console.log('   ✅ They are SIBLINGS under same master order!');
      } else {
        console.log('   ❌ Different master orders');
      }
    }

    console.log('\n💡 Analysis:');
    console.log('Payment ID: pay_UOTJFniUIzbTUr');
    console.log('Gateway Order: order_U0TJANilByceQD');
    console.log(`Linked to order: ${order1?.id} (${order1?.orderNumber})`);
    console.log(`But user sees pending on: ${order2?.orderNumber}`);

  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
