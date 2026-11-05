import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  assertWithinMegapixelCap, detectFileSignature, scanForMalware,
  SCAN_INCONCLUSIVE_REASON, SCAN_UNAVAILABLE_REASON,
} from './upload-security.interceptor';

// KYC documents (partner Aadhaar/PAN/passbook, seller GST/PAN/cheque, …) are private PII, so
// they deliberately do NOT go through MediaService (whose Cloudinary delivery URLs are public)
// — they keep being stored as data URLs on the vendor/registration record. What they were
// missing was the content checks every other upload already gets. This reuses those exact
// primitives (real-signature detection, sharp decode + megapixel cap, fail-closed ClamAV)
// rather than re-implementing any of them.

export const MAX_KYC_DOCUMENT_BYTES = 5 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const DECLARED_TO_FORMAT: Record<string, 'jpeg' | 'png' | 'webp' | 'pdf'> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const logger = new Logger('KycDocumentValidation');

/** Sentinel the draft endpoints hand back in place of an already-stored document. */
export const UPLOADED_PLACEHOLDER = '[uploaded]';

/**
 * Throws unless `value` is a base64 data URL whose ACTUAL bytes are a JPEG, PNG, WebP or
 * (when allowed) PDF matching the declared type, under 5MB, decodable (images), and clean per ClamAV.
 * APK/EXE/ZIP/ELF/SVG/scripts and anything unrecognized are rejected by signature.
 */
export async function assertSafeKycDocument(field: string, value: unknown, opts: { allowPdf?: boolean } = {}): Promise<void> {
  const allowPdf = opts.allowPdf ?? true;
  const allowedLabel = allowPdf ? 'JPG, PNG, WebP or PDF' : 'JPG, PNG or WebP';
  const match = typeof value === 'string' ? /^data:([\w./+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value) : null;
  if (!match) throw new BadRequestException(`${field}: invalid file — only ${allowedLabel} uploads are allowed`);

  const declared = DECLARED_TO_FORMAT[match[1].toLowerCase()];
  if (!declared || (declared === 'pdf' && !allowPdf)) {
    throw new BadRequestException(`${field}: only ${allowedLabel} files are allowed`);
  }
  // Reject by encoded length before decoding anything (base64 is 4 chars per 3 bytes).
  if (Math.floor((match[2].length * 3) / 4) > MAX_KYC_DOCUMENT_BYTES + 3) {
    throw new BadRequestException(`${field}: file must be under 5MB`);
  }
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length || buf.length > MAX_KYC_DOCUMENT_BYTES) throw new BadRequestException(`${field}: file must be under 5MB`);

  const sig = detectFileSignature(buf);
  const detected = sig.kind === 'image' ? sig.format : buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC) ? 'pdf' : undefined;
  if (sig.kind === 'dangerous' || detected !== declared) {
    logger.warn(`Rejected ${field}: declared=${match[1]} detected=${sig.dangerLabel ?? detected ?? sig.kind}`);
    throw new BadRequestException(`${field}: file content does not match its declared type — upload rejected`);
  }

  if (detected !== 'pdf') {
    try {
      await assertWithinMegapixelCap(buf);
    } catch (e: any) {
      throw new BadRequestException(`${field}: ${e?.message || 'file could not be read as a valid image'}`);
    }
  }

  const scan = await scanForMalware(buf, field, logger);
  if (!scan.clean) {
    if (scan.reason === SCAN_UNAVAILABLE_REASON || scan.reason === SCAN_INCONCLUSIVE_REASON) {
      throw new ServiceUnavailableException('Uploads are temporarily unavailable. Please try again shortly.');
    }
    logger.warn(`Rejected ${field}: malware scan flagged ${scan.reason}`);
    throw new BadRequestException(`${field}: file rejected by security validation.`);
  }
}
