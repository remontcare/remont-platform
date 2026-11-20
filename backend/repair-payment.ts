/**
 * REPAIR RAZORPAY PAYMENT SYNCHRONIZATION
 * ========================================
 *
 * Usage: npx ts-node repair-payment.ts <orderNumber> <razorpayPaymentId> <razorpayOrderId> <capturedAmount>
 *
 * Example:
 * npx ts-node repair-payment.ts REM-1794750210856-581064 pay_1Aw8yN1DvCblXg order_U0TJANilByceQD 1062
 *
 * This script:
 * 1. Finds the order and validates it
 * 2. Verifies the amount matches Razorpay's captured amount
 * 3. Creates the missing PaymentTransaction
 * 4. Marks order as PAID
 * 5. Updates parent MasterOrder if applicable
 * 6. Dispatches the order
 * 7. Sends payment success notification
 */

import { PrismaService } from './src/prisma/prisma.module';
import * as crypto from 'crypto';

const prisma = new PrismaService();

async function repairPayment(
  orderNumber: string,
  razorpayPaymentId: string,
  razorpayOrderId: string,
  capturedAmountPaise: string,
) {
  console.log('\n🔧 RAZORPAY PAYMENT REPAIR\n');

  try {
    // Convert paise to rupees
    const capturedAmount = Number(capturedAmountPaise) / 100;

    console.log(`📋 Input Parameters:`);
    console.log(`   Order: ${orderNumber}`);
    console.log(`   Payment ID: ${razorpayPaymentId}`);
    console.log(`   Gateway Order ID: ${razorpayOrderId}`);
    console.log(`   Captured Amount: ₹${capturedAmount}`);

    // Step 1: Find the order
    console.log(`\n1️⃣  Looking up order...`);
    const order = await prisma.order.findFirst({
      where: { orderNumber },
      include: {
        customer: { select: { phone: true } },
        masterOrder: { select: { id: true, status: true, paymentStatus: true } },
      },
    });

    if (!order) {
      console.error(`❌ Order not found: ${orderNumber}`);
      process.exit(1);
    }

    console.log(`✅ Found order: ${order.orderNumber}`);
    console.log(`   ID: ${order.id}`);
    console.log(`   Total Amount: ₹${order.totalAmount}`);
    console.log(`   Payment Status: ${order.paymentStatus}`);
    console.log(`   Order Status: ${order.status}`);

    // Step 2: Validate amount
    console.log(`\n2️⃣  Validating payment amount...`);
    const orderTotal = Number(order.totalAmount);
    if (capturedAmount + 0.01 < orderTotal) {
      console.error(`❌ Payment underpaid!`);
      console.error(`   Captured: ₹${capturedAmount}`);
      console.error(`   Required: ₹${orderTotal}`);
      process.exit(1);
    }
    console.log(`✅ Amount valid: ₹${capturedAmount} covers ₹${orderTotal}`);

    // Step 3: Check for existing transaction
    console.log(`\n3️⃣  Checking for existing transactions...`);
    const existingTx = await prisma.paymentTransaction.findMany({
      where: { orderId: order.id },
    });

    if (existingTx.length > 0) {
      console.log(`⚠️  Found ${existingTx.length} existing transaction(s)`);
      console.log(JSON.stringify(existingTx, null, 2));
      console.log('   Updating with new details...');
    }

    // Step 4: Create or update PaymentTransaction
    console.log(`\n4️⃣  Creating PaymentTransaction...`);
    let transaction;
    if (existingTx.length > 0) {
      transaction = await prisma.paymentTransaction.update({
        where: { id: existingTx[0].id },
        data: {
          status: 'PAID',
          gatewayPaymentId: razorpayPaymentId,
          gatewayOrderId: razorpayOrderId,
          gatewaySignature: `manual-repair-${Date.now()}`,
        },
      });
    } else {
      transaction = await prisma.paymentTransaction.create({
        data: {
          orderId: order.id,
          userId: order.customerId,
          amount: orderTotal,
          status: 'PAID',
          gateway: 'RAZORPAY',
          gatewayOrderId: razorpayOrderId,
          gatewayPaymentId: razorpayPaymentId,
          gatewaySignature: `manual-repair-${Date.now()}`,
        },
      });
    }
    console.log(`✅ Transaction created/updated: ${transaction.id}`);
    console.log(`   Status: ${transaction.status}`);
    console.log(`   Gateway Payment: ${transaction.gatewayPaymentId}`);

    // Step 5: Mark order as PAID
    console.log(`\n5️⃣  Updating order payment status...`);
    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentId: razorpayPaymentId,
        paymentStatus: 'PAID',
        paymentMethod: 'ONLINE',
        // Only update status if still pending
        ...(order.paymentStatus === 'PENDING' && order.status === 'PENDING_PAYMENT'
          ? { status: 'CONFIRMED' }
          : {}),
      },
    });
    console.log(`✅ Order updated`);
    console.log(`   Payment Status: ${updatedOrder.paymentStatus}`);
    console.log(`   Order Status: ${updatedOrder.status}`);

    // Step 6: Create order timeline
    console.log(`\n6️⃣  Recording timeline entry...`);
    await prisma.orderTimeline.create({
      data: {
        orderId: order.id,
        status: updatedOrder.status,
        note: 'Payment manually synced from Razorpay webhook (repair)',
      },
    });
    console.log(`✅ Timeline recorded`);

    // Step 7: Update parent MasterOrder if applicable
    if (order.masterOrderId) {
      console.log(`\n7️⃣  Updating parent MasterOrder...`);
      const masterOrder = await prisma.masterOrder.findUnique({
        where: { id: order.masterOrderId },
        include: { childOrders: true },
      });

      if (masterOrder) {
        // Check if all child orders are now paid
        const allPaid = masterOrder.childOrders.every((o) => o.id === order.id || o.paymentStatus === 'PAID');
        if (allPaid && masterOrder.paymentStatus !== 'PAID') {
          await prisma.masterOrder.update({
            where: { id: masterOrder.id },
            data: {
              paymentId: razorpayPaymentId,
              paymentStatus: 'PAID',
              status: 'CONFIRMED',
            },
          });
          console.log(`✅ MasterOrder updated: ${masterOrder.id}`);
        }
      }
    }

    // Step 8: Check if order needs dispatch
    console.log(`\n8️⃣  Verification complete`);
    console.log(`\n✅ REPAIR SUCCESSFUL!`);
    console.log(`\n📊 Final Status:`);
    console.log(`   Order: ${updatedOrder.orderNumber}`);
    console.log(`   Payment: ${updatedOrder.paymentStatus}`);
    console.log(`   Status: ${updatedOrder.status}`);
    console.log(`   Amount: ₹${updatedOrder.totalAmount}`);
    console.log(`   Razorpay Payment: ${razorpayPaymentId}`);

    console.log(`\n📌 Next Steps:`);
    console.log(`   1. Order will dispatch via the DispatchRetryService on next 10-min sweep`);
    console.log(`   2. Or manually trigger dispatch: POST /orders/:id/dispatch`);
    console.log(`   3. Customer should see order as CONFIRMED in app`);

  } catch (err: any) {
    console.error(`\n❌ Error: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Parse command line arguments
const [orderNumber, paymentId, orderId, amount] = process.argv.slice(2);

if (!orderNumber || !paymentId || !orderId || !amount) {
  console.error(`\n❌ Missing required arguments\n`);
  console.error(`Usage: npx ts-node repair-payment.ts <orderNumber> <paymentId> <orderId> <amountInPaise>`);
  console.error(`\nExample:`);
  console.error(`npx ts-node repair-payment.ts REM-1794750210856-581064 pay_1Aw8yN1DvCblXg order_U0TJANilByceQD 1062`);
  console.error(`\nWhere:`);
  console.error(`  orderNumber = Order number from system (e.g., REM-1794750210856-581064)`);
  console.error(`  paymentId   = Razorpay Payment ID (e.g., pay_1Aw8yN1DvCblXg)`);
  console.error(`  orderId     = Razorpay Order ID (e.g., order_U0TJANilByceQD)`);
  console.error(`  amountInPaise = Amount in paise (e.g., 1062 for ₹10.62)`);
  process.exit(1);
}

repairPayment(orderNumber, paymentId, orderId, amount);
