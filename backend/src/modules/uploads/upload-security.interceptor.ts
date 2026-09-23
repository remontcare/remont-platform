import {
  BadRequestException, CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Readable } from 'stream';
import sharp from 'sharp';
import NodeClam from 'clamscan';
import { PrismaService } from '../../prisma/prisma.module';
import { logAudit } from '../../common';

// ─── Content-based file type detection ──────────────────────────────────────
// Never trust file.mimetype (client-declared, trivially spoofed) or the file extension —
// every check here reads the actual bytes of the uploaded buffer.

export interface FileSignature {
  kind: 'image' | 'video' | 'svg' | 'dangerous' | 'unknown';
  format?: string;
  dangerLabel?: string;
}

function matchesHex(buf: Buffer, offset: number, hex: string): boolean {
  const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}

/**
 * Reads the real file signature (magic bytes) and classifies it. Dangerous signatures
 * (PE/EXE, ELF, ZIP-family — which covers APK/JAR/DOCX too) are checked first and
 * unconditionally, regardless of what extension or declared MIME type the upload arrived
 * with. SVG (and anything else that's actually XML/text) is classified separately and
 * always rejected — SVG can carry embedded <script>, so rather than hand-rolling XML
 * sanitization (a real bypass risk if done incompletely) SVG uploads are disabled entirely,
 * per the accepted alternative for this requirement.
 */
export function detectFileSignature(buf: Buffer): FileSignature {
  if (!buf || buf.length < 4) return { kind: 'unknown' };

  if (matchesHex(buf, 0, '4d5a')) return { kind: 'dangerous', dangerLabel: 'a Windows executable (PE/EXE)' };
  if (matchesHex(buf, 0, '7f454c46')) return { kind: 'dangerous', dangerLabel: 'an ELF binary' };
  if (matchesHex(buf, 0, '504b0304') || matchesHex(buf, 0, '504b0506') || matchesHex(buf, 0, '504b0708')) {
    return { kind: 'dangerous', dangerLabel: 'a ZIP-family archive (this also covers APK/JAR/Office files)' };
  }

  const head = buf.subarray(0, Math.min(buf.length, 512)).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')) {
    return { kind: 'svg' };
  }

  if (matchesHex(buf, 0, 'ffd8ff')) return { kind: 'image', format: 'jpeg' };
  if (matchesHex(buf, 0, '89504e470d0a1a0a')) return { kind: 'image', format: 'png' };
  if (matchesHex(buf, 0, '47494638')) return { kind: 'image', format: 'gif' };
  if (matchesHex(buf, 0, '52494646') && matchesHex(buf, 8, '57454250')) return { kind: 'image', format: 'webp' };

  if (matchesHex(buf, 4, '66747970')) return { kind: 'video', format: 'mp4/mov' }; // ISO-BMFF 'ftyp' box
  if (matchesHex(buf, 0, '1a45dfa3')) return { kind: 'video', format: 'webm/mkv' }; // EBML header
  if (matchesHex(buf, 0, '52494646') && matchesHex(buf, 8, '41564920')) return { kind: 'video', format: 'avi' };

  return { kind: 'unknown' };
}

const MAX_IMAGE_MEGAPIXELS = 25;

/** Throws BadRequestException if the buffer isn't a genuinely decodable image, or exceeds
 *  the megapixel ceiling — this also doubles as a much stronger validity check than the
 *  magic-byte scan alone, since sharp actually parses the image structure. */
export async function assertWithinMegapixelCap(buf: Buffer, maxMegapixels = MAX_IMAGE_MEGAPIXELS): Promise<void> {
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    throw new BadRequestException('File could not be read as a valid image');
  }
  const megapixels = ((meta.width || 0) * (meta.height || 0)) / 1_000_000;
  if (megapixels > maxMegapixels) {
    throw new BadRequestException(`Image exceeds the maximum allowed resolution (${maxMegapixels} megapixels)`);
  }
}

// ─── Virus/malware scanning ──────────────────────────────────────────────────
// Scans against a self-hosted ClamAV `clamd` daemon running as its own Railway service
// (clamav/Dockerfile), reached over Railway's private network — never a third-party API.
// Uses the `clamscan` npm package's remote-TCP mode rather than hand-rolling clamd's
// INSTREAM wire protocol, to avoid a from-scratch protocol implementation becoming a silent
// scan-bypass bug. `clamscan: { active: false }` + `localFallback: false` guarantee this
// never falls back to a local clamscan/clamdscan binary (this container has none, and a
// silent fallback to "no scan happened" would defeat the whole point).

export interface ScanResult { clean: boolean; reason?: string; skipped?: boolean }

/** Reasons meaning "the scan itself could not complete" (as opposed to a detected threat) —
 *  still a rejection (fail-closed), but audited differently by the media pipeline. */
export const SCAN_INCONCLUSIVE_REASON = 'Scan result inconclusive';
export const SCAN_UNAVAILABLE_REASON = 'Virus scan unavailable';

// Lazily initialized, cached across calls (re-initializing per scan would add avoidable
// latency) — but cleared back to null on ANY failure (init or scan) so the very next upload
// attempt tries a fresh connection instead of permanently replaying a stale failure. There is
// no "not configured" branch: unlike the third-party API this replaces, ClamAV is a required
// part of this architecture, not an optional add-on — every failure mode below is fail-closed.
let clamscanClientPromise: Promise<NodeClam> | null = null;

function getClamscanClient(): Promise<NodeClam> {
  if (!clamscanClientPromise) {
    clamscanClientPromise = new NodeClam().init({
      removeInfected: false,
      clamdscan: {
        host: process.env.CLAMAV_HOST || 'clamav.railway.internal',
        port: Number(process.env.CLAMAV_PORT) || 3310,
        timeout: Number(process.env.CLAMAV_SCAN_TIMEOUT_MS) || 20000,
        // `socket` deliberately omitted (host/port mode, not a UNIX socket — the scanner is
        // a separate service). The package's own docs treat "omitted" and "null" as
        // equivalent, but @types/clamscan's socket field isn't typed to accept null.
        active: true,
        localFallback: false,
      },
      clamscan: { active: false }, // never attempt a local clamscan/clamdscan binary
    }).catch((e) => {
      clamscanClientPromise = null; // allow the next call to retry a fresh connection
      throw e;
    });
  }
  return clamscanClientPromise;
}

/** Test-only escape hatch — clears the cached clamscan client between test cases so each one
 *  can exercise a fresh connection attempt. Never called by production code. */
export function __resetClamscanClientForTests(): void {
  clamscanClientPromise = null;
}

export async function scanForMalware(buf: Buffer, filename: string, logger: Logger): Promise<ScanResult> {
  try {
    const client = await getClamscanClient();
    // Wrap the buffer in a proper Readable (push once, then end) rather than
    // Readable.from(buffer), which iterates a Buffer BYTE-BY-BYTE by default — fine for
    // correctness, disastrous for a 50MB video (millions of 1-byte stream reads).
    const stream = new Readable();
    stream.push(buf);
    stream.push(null);

    const { isInfected, viruses } = await client.scanStream(stream);
    if (isInfected === null || isInfected === undefined) {
      // An inconclusive result must never be treated as "clean".
      logger.warn('ClamAV returned an inconclusive scan result — rejecting upload (fail-closed)');
      return { clean: false, reason: SCAN_INCONCLUSIVE_REASON };
    }
    if (isInfected) {
      const found = Array.isArray(viruses) && viruses.length ? viruses.join(', ') : 'unrecognized threat';
      return { clean: false, reason: found };
    }
    return { clean: true };
  } catch (e: any) {
    clamscanClientPromise = null; // scanStream() can fail after a previously-successful init (e.g. the daemon went down mid-session) — always allow a fresh retry next time
    logger.warn(`ClamAV scan failed for ${filename || 'upload'}: ${e.message} — rejecting upload (fail-closed)`);
    return { clean: false, reason: SCAN_UNAVAILABLE_REASON };
  }
}

function clientIp(req: any): string | undefined {
  const fwd = req?.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req?.ip;
}

/**
 * Single, reusable guard against every upload route (image/video/lead-photo) — content-type
 * validation, dangerous-signature blocking, the image megapixel ceiling, and malware
 * scanning all happen here exactly once, never duplicated per-route. Must be listed AFTER
 * FileInterceptor(...) in @UseInterceptors() so req.file is already populated. A rejected
 * file is never forwarded to Cloudinary or written to disk — it only ever exists in the
 * in-memory Multer buffer already in use, and this interceptor throws before the route
 * handler (which is what actually calls Cloudinary) ever runs.
 */
@Injectable()
export class UploadSecurityInterceptor implements NestInterceptor {
  private readonly logger = new Logger(UploadSecurityInterceptor.name);
  constructor(private prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const req = context.switchToHttp().getRequest();
    const file = req.file as Express.Multer.File | undefined;

    // No file on the request at all — nothing for this interceptor to validate; the route
    // handler's own "No file uploaded" check produces the error, unchanged from before.
    if (!file || !file.buffer) return next.handle();

    const sig = detectFileSignature(file.buffer);

    if (sig.kind === 'dangerous') {
      await this.logRejection(req, file, 'UPLOAD_REJECTED_DANGEROUS_SIGNATURE', sig.dangerLabel, { dangerLabel: sig.dangerLabel });
      throw new BadRequestException(
        `This file was rejected: its actual content is ${sig.dangerLabel}, not an image or video, regardless of its file name.`,
      );
    }
    if (sig.kind === 'svg') {
      await this.logRejection(req, file, 'UPLOAD_REJECTED_SVG_DISABLED', 'SVG upload attempted');
      throw new BadRequestException('SVG uploads are not supported — SVG files can contain embedded scripts.');
    }
    if (sig.kind === 'unknown') {
      await this.logRejection(req, file, 'UPLOAD_REJECTED_UNKNOWN_TYPE', 'Unrecognized file signature');
      throw new BadRequestException('File content was not recognized as an allowed image or video format.');
    }

    const declaredKind = file.mimetype?.startsWith('image/') ? 'image' : file.mimetype?.startsWith('video/') ? 'video' : 'unknown';
    if (declaredKind !== sig.kind) {
      await this.logRejection(req, file, 'UPLOAD_REJECTED_MIME_MISMATCH', 'Declared type does not match actual content', {
        declared: file.mimetype, detected: sig.format,
      });
      throw new BadRequestException("The uploaded file's content does not match its declared type.");
    }

    if (sig.kind === 'image') {
      try {
        await assertWithinMegapixelCap(file.buffer);
      } catch (e: any) {
        await this.logRejection(req, file, 'UPLOAD_REJECTED_TOO_LARGE', e.message);
        throw e;
      }
    }

    const scan = await scanForMalware(file.buffer, file.originalname, this.logger);
    if (!scan.clean) {
      await this.logRejection(req, file, 'UPLOAD_REJECTED_MALWARE', scan.reason, { reason: scan.reason });
      throw new BadRequestException('This file was flagged by malware scanning and cannot be uploaded.');
    }

    return next.handle();
  }

  /** Never throws — a failure to write the audit entry must not itself block (or bypass) a
   *  rejection decision that's already been made. */
  private async logRejection(req: any, file: Express.Multer.File, action: string, reason?: string, extra?: Record<string, unknown>) {
    const user = req.user;
    if (!user?.sub) return; // shouldn't happen — every upload route requires JwtAuthGuard
    try {
      await logAudit(this.prisma, {
        actorId: user.sub,
        actorRole: user.role,
        action,
        targetType: 'UPLOAD',
        metadata: { filename: file.originalname, mimetype: file.mimetype, size: file.size, reason, ...extra },
        ip: clientIp(req),
      });
    } catch (e: any) {
      this.logger.error(`Failed to write upload security audit log: ${e.message}`);
    }
  }
}
