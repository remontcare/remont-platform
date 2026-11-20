/**
 * RAZORPAY PAYMENT SYNCHRONIZATION FIX
 * ====================================
 *
 * ROOT CAUSE ANALYSIS:
 * - Order REM-1794750210856-581064 exists but has NO PaymentTransaction record
 * - This means initiatePayment() either:
 *   1. Was never called (but checkout succeeded?)
 *   2. Was called but transaction.create() failed silently
 *   3. Transaction was created but deleted or orphaned
 *
 * CONSEQUENCES:
 * - Webhook payment.captured event looks for transaction by gatewayOrderId
 * - Without transaction, webhook cannot mark payment as PAID
 * - Order stays PENDING_PAYMENT forever even though Razorpay shows CAPTURED
 * - Customer sees pending, admin sees pending, no one can proceed
 *
 * FIX STRATEGY:
 * 1. Query Razorpay API for the actual payment details
 * 2. Verify HMAC signature on the payment
 * 3. If valid: create missing transaction + mark order as PAID
 * 4. Never trust client data; always verify with Razorpay
 */

import { PrismaService } from './src/prisma/prisma.module';
import * as crypto from 'crypto';

const prisma = new PrismaService();

interface RazorpayPayment {
  id: string;
  order_id: string;
  amount: number;
  status: string;
  method: string;
  amount_refunded: number;
  created_at: number;
}

async function main() {
  console.log('\n📋 RAZORPAY PAYMENT SYNC FIX\n');

  try {
    const orderNumber = 'REM-1794750210856-581064';
    console.log(`1️⃣  Finding order: ${orderNumber}`);

    const order = await prisma.order.findFirst({
      where: { orderNumber },
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
      console.error('❌ Order not found');
      process.exit(1);
    }

    console.log(`✅ Found order: ${order.orderNumber}`);
    console.log(`   ID: ${order.id}`);
    console.log(`   Amount: ₹${order.totalAmount}`);
    console.log(`   Status: ${order.paymentStatus}`);

    // Check for existing transactions
    console.log('\n2️⃣  Checking payment transactions...');
    const existingTx = await prisma.paymentTransaction.findMany({
      where: { orderId: order.id },
      select: {
        id: true,
        amount: true,
        status: true,
        gateway: true,
        gatewayOrderId: true,
        gatewayPaymentId: true,
      },
    });

    if (existingTx.length > 0) {
      console.log(`✅ Found ${existingTx.length} transaction(s):`);
      console.log(JSON.stringify(existingTx, null, 2));
      console.log('\n✅ Order has transactions. No fix needed.');
      process.exit(0);
    }

    console.log('❌ NO PaymentTransaction found for this order!');
    console.log('   This is the root cause of the payment sync issue.');

    // The fix requires the Razorpay Payment ID
    console.log('\n3️⃣  WHAT TO DO:');
    console.log('   a) Get Razorpay Payment ID from: https://dashboard.razorpay.com/');
    console.log('   b) Search for ₹10.62 payment on Nov 15, 2026');
    console.log('   c) Copy the Payment ID (looks like: pay_XXXXXXXXX)');
    console.log('   d) Run: npx ts-node razorpay-payment-sync-fix.ts <paymentId>');
    console.log('\n   Example:');
    console.log('   npx ts-node razorpay-payment-sync-fix.ts pay_1Aw8yN1DvCblXg');

    const paymentId = process.argv[2];
    if (!paymentId) {
      console.log('\n⚠️  No Payment ID provided. Skipping sync.');
      process.exit(1);
    }

    console.log(`\n4️⃣  Attempting to sync with Razorpay Payment: ${paymentId}`);
    console.log('   NOTE: This would require Razorpay SDK integration');
    console.log('   For now, manually:');
    console.log(`   1. Verify payment ${paymentId} is CAPTURED in Razorpay`);
    console.log(`   2. Get the order_id (gateway_order_id) from that payment`);
    console.log('   3. Run the fix with: npm run fix:payment -- <orderId> <paymentId>');

  } catch (err: any) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
