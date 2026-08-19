-- Financial-integrity fix: separates "gateway captured this payment" (status) from
-- "we actually credited the target wallet/ledger" (creditedAt). status gets written by both
-- the explicit confirm-payment call and the async Razorpay webhook, whichever lands first —
-- using status==='PAID' as the "already credited" idempotency check let a webhook that raced
-- ahead of the explicit confirm call mark a transaction PAID without ever crediting anyone,
-- and the explicit confirm call would then see PAID and skip crediting too. creditedAt is set
-- exactly once, by whichever caller wins an atomic updateMany claim right before crediting.
ALTER TABLE "PaymentTransaction" ADD COLUMN "creditedAt" TIMESTAMP(3);
