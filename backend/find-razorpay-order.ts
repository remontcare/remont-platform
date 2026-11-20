import { PrismaService } from './src/prisma/prisma.module';

const prisma = new PrismaService();

async function main() {
  try {
    console.log('\n🔍 Finding Razorpay Order ID for payment: pay_UOTJFniUIzbTUr\n');

    // Search for any transaction with this payment ID
    const txByPaymentId = await prisma.paymentTransaction.findMany({
      where: {
        gatewayPaymentId: 'pay_UOTJFniUIzbTUr',
      },
      select: {
        id: true,
        orderId: true,
        gatewayOrderId: true,
        amount: true,
        status: true,
        createdAt: true,
      },
    });

    if (txByPaymentId.length > 0) {
      console.log('✅ Found transaction with this payment ID:');
      console.log(JSON.stringify(txByPaymentId, null, 2));
      process.exit(0);
    }

    // Search for transactions created on Nov 15 around 07:13 pm IST
    // IST = UTC + 5:30, so 07:13 IST = 01:43 UTC
    console.log('Searching for transactions on Nov 15, 2026 around payment time...\n');

    const txByDate = await prisma.paymentTransaction.findMany({
      where: {
        createdAt: {
          gte: new Date('2026-11-15T07:00:00Z'),
          lte: new Date('2026-11-15T08:00:00Z'),
        },
        amount: 10.62,
      },
      select: {
        id: true,
        orderId: true,
        gatewayOrderId: true,
        gatewayPaymentId: true,
        amount: true,
        status: true,
        createdAt: true,
      },
    });

    if (txByDate.length > 0) {
      console.log(`Found ${txByDate.length} transaction(s) around that time:\n`);
      console.log(JSON.stringify(txByDate, null, 2));

      // Check which one is for our order
      const ourOrder = await prisma.order.findFirst({
        where: { orderNumber: 'REM-1794750210856-581064' },
        select: { id: true },
      });

      if (ourOrder) {
        const ourTx = txByDate.find(t => t.orderId === ourOrder.id);
        if (ourTx) {
          console.log(`\n✅ THIS is our order's transaction!`);
          console.log(`   Order ID: ${ourTx.orderId}`);
          console.log(`   Gateway Order ID: ${ourTx.gatewayOrderId}`);
          process.exit(0);
        }
      }

      console.log('\n⚠️ Found transactions but not for our order.');
      console.log('Checking all transactions for this customer...\n');
    }

    // Try by customer phone
    const user = await prisma.user.findUnique({
      where: { phone: '+919425442156' },
      select: { id: true },
    });

    if (user) {
      const userTxs = await prisma.paymentTransaction.findMany({
        where: {
          userId: user.id,
          createdAt: {
            gte: new Date('2026-11-15T00:00:00Z'),
            lte: new Date('2026-11-15T23:59:59Z'),
          },
        },
        select: {
          id: true,
          orderId: true,
          gatewayOrderId: true,
          gatewayPaymentId: true,
          amount: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (userTxs.length > 0) {
        console.log(`Found ${userTxs.length} transaction(s) for user +919425442156:\n`);
        console.log(JSON.stringify(userTxs, null, 2));
        process.exit(0);
      }
    }

    console.log('❌ No transactions found.\n');
    console.log('The payment exists in Razorpay but transaction was never created in our DB.');
    console.log('This confirms the root cause.\n');

  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
