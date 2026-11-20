import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { assertSafeKycDocument } from './kyc-document';

// One-time, READ-ONLY audit of KYC documents stored before uploads were content-checked.
// It runs every stored inline (data:) document through the exact same check new uploads get
// (uploads/kyc-document.ts: real signature, size, image decode, ClamAV) and REPORTS what fails.
// It never updates or deletes anything — an admin reviews the report and decides per record.
//
// ClamAV is only reachable on Railway's private network (clamav.railway.internal), so this
// must run inside the backend service, e.g.:  railway ssh  →  node dist/modules/uploads/kyc-stored-scan.js
// If ClamAV is unreachable it aborts rather than produce a misleading "all clean" report.
// Output contains record ids, field names and reasons only — never document contents.

interface Source { model: string; fields: string[]; listFields?: string[] }
export const STORED_KYC_SOURCES: Source[] = [
  { model: 'vendorDocument', fields: ['url'] },
  { model: 'sellerDocument', fields: ['url'] },
  { model: 'partnerRegistration', fields: ['idProofFront', 'idProofBack', 'panCardUrl', 'profilePhotoUrl', 'skillCertificateUrl', 'policeVerificationUrl', 'cancelledChequeUrl'] },
  {
    model: 'sellerRegistration',
    fields: ['gstCertificateUrl', 'panCardUrl', 'cancelledChequeUrl', 'bankPassbookUrl', 'businessProofUrl', 'addressProofUrl', 'ownerPhotoUrl', 'ownerAadhaarUrl'],
    listFields: ['warehouseImages', 'storeImages'],
  },
];

export interface StoredKycFinding { model: string; id: string; field: string; reason: string }
export interface StoredKycReport { scanned: number; skippedNotInline: number; flagged: StoredKycFinding[] }

export async function scanStoredKycDocuments(
  prisma: any,
  opts: { batchSize?: number; log?: (line: string) => void } = {},
): Promise<StoredKycReport> {
  const batchSize = opts.batchSize ?? 20; // each value can be up to ~5MB — keep memory bounded
  const log = opts.log ?? (() => undefined);
  const report: StoredKycReport = { scanned: 0, skippedNotInline: 0, flagged: [] };

  for (const src of STORED_KYC_SOURCES) {
    const columns = [...src.fields, ...(src.listFields ?? [])];
    const select: Record<string, true> = { id: true };
    for (const c of columns) select[c] = true;
    let cursor: string | undefined;
    for (;;) {
      const rows: any[] = await prisma[src.model].findMany({
        select, orderBy: { id: 'asc' }, take: batchSize, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) break;
      for (const row of rows) {
        for (const field of columns) {
          const raw = row[field];
          const values: unknown[] = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
          for (const value of values) {
            if (typeof value !== 'string' || !value.startsWith('data:')) { if (value) report.skippedNotInline++; continue; }
            report.scanned++;
            try {
              await assertSafeKycDocument(field, value);
            } catch (e: any) {
              if (e instanceof ServiceUnavailableException) {
                throw new Error(`Aborted: virus scanner unavailable after ${report.scanned - 1} documents — no clean/dirty conclusion can be drawn. Re-run when ClamAV is up.`);
              }
              if (!(e instanceof BadRequestException)) throw e;
              report.flagged.push({ model: src.model, id: row.id, field, reason: String(e.message) });
              log(`FLAGGED ${src.model}#${row.id}.${field}: ${e.message}`);
            }
          }
        }
      }
      cursor = rows[rows.length - 1].id;
      log(`${src.model}: scanned up to ${cursor} (${report.scanned} documents so far)`);
    }
  }
  return report;
}

/* istanbul ignore next -- CLI entry point, exercised manually on Railway */
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  scanStoredKycDocuments(prisma, { log: (l) => console.log(l) })
    .then((r) => {
      console.log(JSON.stringify({ scanned: r.scanned, skippedNotInline: r.skippedNotInline, flaggedCount: r.flagged.length, flagged: r.flagged }, null, 2));
      process.exitCode = r.flagged.length ? 2 : 0;
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
