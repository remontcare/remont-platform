-- Vendor Wallet accounting fix: a vendor collecting COD cash from a customer on Remont's
-- behalf previously had NO ledger effect at all — only the job's own JOB_EARNING credit was
-- posted, identically whether the job was paid online or in cash. That meant a COD vendor
-- ended up holding the customer's cash in their pocket AND showing a "Remont owes me" ledger
-- credit for the full job payout — a real double-count in the vendor's favor, with Remont's
-- own commission never recovered from the cash the vendor is holding. This new type lets
-- OrdersService.collectBalance()/collectCod() post the offsetting debit.
ALTER TYPE "LedgerEntryType" ADD VALUE 'COD_COLLECTION';
