-- Reliability fix: OrdersService.autoGenerateInvoice() runs fire-and-forget on job
-- completion. If InvoicesService.generateForOrder() ever throws (bad GST config, missing
-- data, etc.), the failure was previously only logged -- the order stayed COMPLETED forever
-- with no invoice and nothing admin-visible. These two columns make that failure findable.
ALTER TABLE "Order" ADD COLUMN "invoiceGenerationFailed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "invoiceGenerationError" TEXT;
