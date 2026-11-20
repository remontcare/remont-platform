import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    // Find the order
    const order = await prisma.order.findFirst({
      where: { orderNumber: 'REM-1794750210856-581064' },
      select: {
        id: true,
        orderNumber: true,
        totalAmount: true,
        paymentStatus: true,
        status: true,
        customerId: true,
        guestPhone: true,
        createdAt: true,
      },
    });

    if (!order) {
      console.log('❌ Order not found');
      process.exit(1);
    }

    console.log('\n📋 ORDER:');
    console.log(JSON.stringify(order, null, 2));

    // Find payment transactions for this order
    const transactions = await prisma.paymentTransaction.findMany({
      where: { orderId: order.id },
      select: {
        id: true,
        amount: true,
        status: true,
        gateway: true,
        gatewayOrderId: true,
        gatewayPaymentId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    console.log('\n💳 PAYMENT TRANSACTIONS:');
    if (transactions.length === 0) {
      console.log('No payment transactions found');
    } else {
      console.log(JSON.stringify(transactions, null, 2));
    }

    console.log('\n✅ Query complete');
  } catch (err: any) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
