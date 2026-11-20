import { PrismaService } from './src/prisma/prisma.module';

const prisma = new PrismaService();

async function main() {
  try {
    // Search for ANY pending transaction from Nov 15 (when order was created)
    const transactions = await prisma.paymentTransaction.findMany({
      where: {
        createdAt: {
          gte: new Date('2026-11-15T00:00:00Z'),
          lte: new Date('2026-11-15T23:59:59Z'),
        },
        orderId: 'cmwhvxpnw002h98s3feps2onz', // The order ID
      },
      select: {
        id: true,
        orderId: true,
        amount: true,
        status: true,
        gateway: true,
        gatewayOrderId: true,
        gatewayPaymentId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (transactions.length > 0) {
      console.log('Found transactions:');
      console.log(JSON.stringify(transactions, null, 2));
    } else {
      console.log('No transactions found for this order on Nov 15');

      // Try to find ANY transaction with similar amount
      const similar = await prisma.paymentTransaction.findMany({
        where: {
          amount: 10.62,
          createdAt: {
            gte: new Date('2026-11-15T00:00:00Z'),
            lte: new Date('2026-11-15T23:59:59Z'),
          },
        },
        select: {
          id: true,
          orderId: true,
          amount: true,
          status: true,
          gateway: true,
          gatewayOrderId: true,
          gatewayPaymentId: true,
          createdAt: true,
        },
      });

      if (similar.length > 0) {
        console.log('\nFound similar amount transactions:');
        console.log(JSON.stringify(similar, null, 2));
      }
    }
  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
