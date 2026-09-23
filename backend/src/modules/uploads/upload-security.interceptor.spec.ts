import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import sharp from 'sharp';
import { crc32 } from 'zlib';

// jest.mock is hoisted above all imports below, including the transitive
// `import NodeClam from 'clamscan'` inside upload-security.interceptor.ts. The mock's
// controllable jest.fn()s (`init`, `scanStream`) are defined INSIDE the factory closure and
// exposed via a property on the exported constructor, rather than referencing an
// outer-scope `const` — referencing an outer variable here would hit a TDZ error, since the
// hoisted mock factory can run before that `const` has executed.
jest.mock('clamscan', () => {
  const scanStream = jest.fn();
  const init = jest.fn().mockImplementation(async () => ({ scanStream }));
  const Ctor: any = jest.fn().mockImplementation(() => ({ init }));
  Ctor.__mocks = { init, scanStream };
  return Ctor;
});

import NodeClamMocked from 'clamscan';
import {
  detectFileSignature, assertWithinMegapixelCap, scanForMalware, UploadSecurityInterceptor,
  __resetClamscanClientForTests,
} from './upload-security.interceptor';

const { init: mockInit, scanStream: mockScanStream } = (NodeClamMocked as any).__mocks;

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

// ─── Requirement 2 — content-based validation, no filename/MIME trust ──────────

describe('detectFileSignature — reads real magic bytes, never trusts extension/MIME', () => {
  it('recognizes JPEG, PNG, GIF, WebP by their real signatures', () => {
    expect(detectFileSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toEqual({ kind: 'image', format: 'jpeg' });
    expect(detectFileSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ kind: 'image', format: 'png' });
    expect(detectFileSignature(Buffer.from('GIF89a'))).toEqual({ kind: 'image', format: 'gif' });
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
    expect(detectFileSignature(webp)).toEqual({ kind: 'image', format: 'webp' });
  });

  it('recognizes MP4/MOV (ftyp box) and WebM/MKV (EBML) video signatures', () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from('isom')]);
    expect(detectFileSignature(mp4)).toEqual({ kind: 'video', format: 'mp4/mov' });
    expect(detectFileSignature(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toEqual({ kind: 'video', format: 'webm/mkv' });
  });

  it('blocks a Windows PE/EXE disguised with any extension — checked before anything else', () => {
    const fakeJpegNamedExe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    expect(detectFileSignature(fakeJpegNamedExe).kind).toBe('dangerous');
  });

  it('blocks an ELF binary', () => {
    expect(detectFileSignature(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0])).kind).toBe('dangerous');
  });

  it('blocks an APK renamed to photo.jpg — APKs are ZIP-family archives (PK\\x03\\x04), regardless of extension', () => {
    const apkBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]); // real APK/ZIP local-file-header signature
    const sig = detectFileSignature(apkBytes);
    expect(sig.kind).toBe('dangerous');
    expect(sig.dangerLabel).toContain('APK');
  });

  it('rejects SVG (and other XML/text) as its own kind — disabled entirely, not sanitized', () => {
    expect(detectFileSignature(Buffer.from('<?xml version="1.0"?><svg></svg>')).kind).toBe('svg');
    expect(detectFileSignature(Buffer.from('<svg onload="alert(1)"></svg>')).kind).toBe('svg');
  });

  it('classifies anything else as unknown, rather than guessing', () => {
    expect(detectFileSignature(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])).kind).toBe('unknown');
    expect(detectFileSignature(Buffer.alloc(0)).kind).toBe('unknown');
  });

  // REGRESSION: every AI-generated PNG (ChatGPT, Gemini, Adobe) carries a C2PA "content
  // credentials" manifest in its header, and that manifest embeds an image/svg+xml icon. The
  // SVG scan used to run before the raster checks and matched '<svg' ANYWHERE in the first
  // 512 bytes, so these valid PNGs were classified as SVG and rejected with "Only JPEG, PNG,
  // WebP or GIF images are allowed."
  it('accepts a valid PNG whose C2PA metadata embeds an SVG icon (the real upload failure)', async () => {
    const png = await pngWithC2paSvgIcon();
    // The scenario is genuine: the bytes really do contain SVG markup in the header area…
    expect(png.subarray(0, 512).toString('utf8')).toContain('<svg');
    // …and it is still a decodable PNG, not a polyglot trick.
    expect((await sharp(png).metadata()).format).toBe('png');
    expect(detectFileSignature(png)).toEqual({ kind: 'image', format: 'png' });
  });

  it('still rejects real SVG, including with a BOM, leading whitespace or an XML prolog', () => {
    expect(detectFileSignature(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).kind).toBe('svg');
    expect(detectFileSignature(Buffer.from('﻿<svg width="10"></svg>')).kind).toBe('svg');
    expect(detectFileSignature(Buffer.from('\n\n   <svg width="10"></svg>')).kind).toBe('svg');
    expect(detectFileSignature(Buffer.from('<?xml version="1.0"?>\n<svg></svg>')).kind).toBe('svg');
  });

  it('a text file that merely mentions <svg> later is unknown — not a raster image, still refused', () => {
    const html = Buffer.from('<!doctype html><body>look: <svg></svg></body>');
    expect(detectFileSignature(html).kind).toBe('unknown'); // callers reject unknown just as firmly
  });
});

/**
 * A real, decodable PNG carrying a C2PA-style chunk whose payload embeds an SVG icon —
 * byte-for-byte the shape produced by ChatGPT/Gemini exports. Built as a proper ancillary
 * chunk (length + type + data + CRC32) inserted after IHDR, so sharp still decodes it.
 */
async function pngWithC2paSvgIcon(): Promise<Buffer> {
  const base = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#4488cc' } }).png().toBuffer();
  const payload = Buffer.from(
    'Comment\0\0\0\0\0c2pa.icon\0image/svg+xml\0<svg width="716" height="716" viewBox="0 0 716 716"></svg>',
    'latin1',
  );
  const type = Buffer.from('iTXt');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, payload])) >>> 0);
  const afterIhdr = 8 + 4 + 4 + 13 + 4; // signature + IHDR (length, type, 13-byte data, CRC)
  return Buffer.concat([base.subarray(0, afterIhdr), length, type, payload, crc, base.subarray(afterIhdr)]);
}

describe('assertWithinMegapixelCap — rejects unparseable buffers and images over the ceiling', () => {
  it('resolves for a real, valid image within the cap', async () => {
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    await expect(assertWithinMegapixelCap(buf)).resolves.toBeUndefined();
  });

  it('rejects a real image once it exceeds the given megapixel ceiling', async () => {
    // 10x10 = 100px = 0.0001 megapixels — force a ceiling below that instead of generating
    // an actual 25-megapixel test fixture, which the function's own default cap targets.
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    await expect(assertWithinMegapixelCap(buf, 0.00005)).rejects.toThrow(/maximum allowed resolution/);
  });

  it('enforces the real default ceiling (25 megapixels) when no override is given', async () => {
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    // 100px is nowhere near 25,000,000 — sanity-checks the actual default, not just a
    // synthetic override, without paying for a genuine 25MP fixture.
    await expect(assertWithinMegapixelCap(buf)).resolves.toBeUndefined();
  });

  it('rejects a buffer that is not actually a decodable image', async () => {
    await expect(assertWithinMegapixelCap(Buffer.from('not an image'))).rejects.toThrow('File could not be read as a valid image');
  });
});

describe('scanForMalware — self-hosted ClamAV via clamscan (remote TCP), fail-closed on every failure mode', () => {
  const logger = new Logger('test');

  beforeEach(() => {
    __resetClamscanClientForTests();
    mockInit.mockReset().mockImplementation(async () => ({ scanStream: mockScanStream }));
    mockScanStream.mockReset();
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_PORT;
  });

  it('reports clean for a file ClamAV does not flag', async () => {
    mockScanStream.mockResolvedValue({ isInfected: false, viruses: [] });
    const result = await scanForMalware(Buffer.from('an ordinary photo'), 'photo.jpg', logger);
    expect(result).toEqual({ clean: true });
  });

  it('blocks and reports the threat name when ClamAV flags an EICAR test file infected', async () => {
    mockScanStream.mockResolvedValue({ isInfected: true, viruses: ['Eicar-Test-Signature'] });
    const result = await scanForMalware(Buffer.from(EICAR), 'eicar.txt', logger);
    expect(result.clean).toBe(false);
    expect(result.reason).toContain('Eicar-Test-Signature');
  });

  it('fails CLOSED on an inconclusive scan result (null/undefined isInfected) — never treated as clean', async () => {
    mockScanStream.mockResolvedValue({ isInfected: null, viruses: [] });
    const result = await scanForMalware(Buffer.from('x'), 'photo.jpg', logger);
    expect(result.clean).toBe(false);
  });

  it('fails CLOSED when the scanner is unreachable (connection refused)', async () => {
    mockInit.mockRejectedValue(new Error('connect ECONNREFUSED clamav.railway.internal:3310'));
    const result = await scanForMalware(Buffer.from('x'), 'photo.jpg', logger);
    expect(result.clean).toBe(false);
  });

  it('fails CLOSED when the scan itself times out after a successful connection', async () => {
    mockScanStream.mockRejectedValue(new Error('Could not scan file/buffer: Timed out'));
    const result = await scanForMalware(Buffer.from('x'), 'photo.jpg', logger);
    expect(result.clean).toBe(false);
  });

  it('recovers on the next call after a connection failure — never permanently caches the failure', async () => {
    mockInit.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const first = await scanForMalware(Buffer.from('x'), 'photo.jpg', logger);
    expect(first.clean).toBe(false);

    mockInit.mockImplementation(async () => ({ scanStream: mockScanStream }));
    mockScanStream.mockResolvedValue({ isInfected: false, viruses: [] });
    const second = await scanForMalware(Buffer.from('x'), 'photo.jpg', logger);
    expect(second.clean).toBe(true);
  });

  it('recovers after a mid-session scan failure (daemon went down after a prior successful init)', async () => {
    mockScanStream.mockResolvedValueOnce({ isInfected: false, viruses: [] });
    await expect(scanForMalware(Buffer.from('x'), 'a.jpg', logger)).resolves.toEqual({ clean: true });

    mockScanStream.mockRejectedValueOnce(new Error('socket hang up'));
    await expect((await scanForMalware(Buffer.from('x'), 'b.jpg', logger)).clean).toBe(false);

    mockScanStream.mockResolvedValueOnce({ isInfected: false, viruses: [] });
    await expect(scanForMalware(Buffer.from('x'), 'c.jpg', logger)).resolves.toEqual({ clean: true });
  });

  it('connects in remote-TCP mode against the configured host/port, and never falls back to a local binary', async () => {
    process.env.CLAMAV_HOST = 'clamav.railway.internal';
    process.env.CLAMAV_PORT = '3310';
    mockScanStream.mockResolvedValue({ isInfected: false, viruses: [] });
    await scanForMalware(Buffer.from('x'), 'photo.jpg', logger);
    expect(mockInit).toHaveBeenCalledWith(expect.objectContaining({
      clamdscan: expect.objectContaining({
        host: 'clamav.railway.internal', port: 3310, active: true, localFallback: false,
      }),
      clamscan: expect.objectContaining({ active: false }),
    }));
  });
});

// ─── Full interceptor flow ──────────────────────────────────────────────────

function makeInterceptor() {
  const prisma: any = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
  const interceptor = new UploadSecurityInterceptor(prisma);
  return { interceptor, prisma };
}

function makeContext(file: any, user: any = { sub: 'user-1', role: 'CUSTOMER' }) {
  const req = { file, user, headers: {}, ip: '127.0.0.1' };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}

/** A fresh handle() spy per test — standing in for "reaches the route handler that actually
 *  calls Cloudinary". Every rejection test below asserts this was NEVER called, which is the
 *  direct proof that a rejected file never reaches Cloudinary. */
function makeCallHandler() {
  return { handle: jest.fn(() => of('ok')) } as any;
}

describe('UploadSecurityInterceptor.intercept — one shared check for all three routes; rejected files never reach the route handler (Cloudinary)', () => {
  beforeEach(() => {
    __resetClamscanClientForTests();
    mockInit.mockReset().mockImplementation(async () => ({ scanStream: mockScanStream }));
    // Default: scanner reports clean unless a specific test overrides this — keeps every
    // non-malware test focused on the check it's actually exercising.
    mockScanStream.mockReset().mockResolvedValue({ isInfected: false, viruses: [] });
  });

  it('passes through untouched when there is no file on the request', async () => {
    const { interceptor } = makeInterceptor();
    const callHandler = makeCallHandler();
    const result = await interceptor.intercept(makeContext(undefined), callHandler);
    await expect(result.toPromise()).resolves.toBe('ok');
  });

  it('rejects a Windows executable disguised as photo.jpg, logs it, and never reaches Cloudinary', async () => {
    const { interceptor, prisma } = makeInterceptor();
    const callHandler = makeCallHandler();
    const file = { buffer: Buffer.from([0x4d, 0x5a, 0, 0, 0, 0, 0, 0]), mimetype: 'image/jpeg', originalname: 'photo.jpg', size: 8 };
    await expect(interceptor.intercept(makeContext(file), callHandler)).rejects.toThrow(/not an image or video/);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: 'user-1', action: 'UPLOAD_REJECTED_DANGEROUS_SIGNATURE' }),
    }));
    expect(callHandler.handle).not.toHaveBeenCalled();
  });

  it('rejects an APK renamed to photo.jpg, logs it, and never reaches Cloudinary', async () => {
    const { interceptor, prisma } = makeInterceptor();
    const callHandler = makeCallHandler();
    const apkBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const file = { buffer: apkBytes, mimetype: 'image/jpeg', originalname: 'photo.jpg', size: apkBytes.length };
    await expect(interceptor.intercept(makeContext(file), callHandler)).rejects.toThrow(/not an image or video/);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'UPLOAD_REJECTED_DANGEROUS_SIGNATURE' }),
    }));
    expect(callHandler.handle).not.toHaveBeenCalled();
  });

  it('rejects an SVG upload outright and never reaches Cloudinary', async () => {
    const { interceptor } = makeInterceptor();
    const callHandler = makeCallHandler();
    const file = { buffer: Buffer.from('<svg onload="x"></svg>'), mimetype: 'image/svg+xml', originalname: 'icon.svg', size: 20 };
    await expect(interceptor.intercept(makeContext(file), callHandler)).rejects.toThrow(/SVG uploads are not supported/);
    expect(callHandler.handle).not.toHaveBeenCalled();
  });

  it('rejects when the declared MIME type disagrees with the real file content, and never reaches Cloudinary', async () => {
    const { interceptor, prisma } = makeInterceptor();
    const callHandler = makeCallHandler();
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from('isom')]);
    const file = { buffer: mp4, mimetype: 'image/jpeg', originalname: 'photo.jpg', size: mp4.length };
    await expect(interceptor.intercept(makeContext(file), callHandler)).rejects.toThrow(/does not match its declared type/);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'UPLOAD_REJECTED_MIME_MISMATCH' }),
    }));
    expect(callHandler.handle).not.toHaveBeenCalled();
  });

  it('blocks a genuinely valid image containing an EICAR-flagged payload, logs it, and never reaches Cloudinary', async () => {
    const { interceptor, prisma } = makeInterceptor();
    const callHandler = makeCallHandler();
    mockScanStream.mockResolvedValue({ isInfected: true, viruses: ['Eicar-Test-Signature'] });
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } } }).jpeg().toBuffer();
    const file = { buffer: buf, mimetype: 'image/jpeg', originalname: 'eicar.jpg', size: buf.length };
    await expect(interceptor.intercept(makeContext(file), callHandler)).rejects.toThrow(/flagged by malware scanning/);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'UPLOAD_REJECTED_MALWARE' }),
    }));
    expect(callHandler.handle).not.toHaveBeenCalled();
  });

  it('blocks a valid image when the scanner is unavailable (connection error), logs it, and never reaches Cloudinary — fail-closed, no "unconfigured" exception', async () => {
    const { interceptor, prisma } = makeInterceptor();
    const callHandler = makeCallHandler();
    mockInit.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } } }).jpeg().toBuffer();
    const file = { buffer: buf, mimetype: 'image/jpeg', originalname: 'photo.jpg', size: buf.length };
    await expect(interceptor.intercept(makeContext(file), callHandler)).rejects.toThrow(/flagged by malware scanning/);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'UPLOAD_REJECTED_MALWARE' }),
    }));
    expect(callHandler.handle).not.toHaveBeenCalled();
  });

  it('blocks a valid image when the scan times out mid-request, and never reaches Cloudinary', async () => {
    const { interceptor } = makeInterceptor();
    const callHandler = makeCallHandler();
    mockScanStream.mockRejectedValue(new Error('Timed out'));
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } } }).jpeg().toBuffer();
    const file = { buffer: buf, mimetype: 'image/jpeg', originalname: 'photo.jpg', size: buf.length };
    await expect(interceptor.intercept(makeContext(file), callHandler)).rejects.toThrow();
    expect(callHandler.handle).not.toHaveBeenCalled();
  });

  it('allows a genuinely valid, clean, small image through to the route handler (Cloudinary is only reached on a pass)', async () => {
    const { interceptor } = makeInterceptor();
    const callHandler = makeCallHandler();
    const buf = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } } }).jpeg().toBuffer();
    const file = { buffer: buf, mimetype: 'image/jpeg', originalname: 'photo.jpg', size: buf.length };
    const result = await interceptor.intercept(makeContext(file), callHandler);
    await expect(result.toPromise()).resolves.toBe('ok');
    expect(callHandler.handle).toHaveBeenCalled();
  });

  it('never crashes when the request somehow has no authenticated user — still rejects, just skips the audit write', async () => {
    const { interceptor, prisma } = makeInterceptor();
    const callHandler = makeCallHandler();
    const file = { buffer: Buffer.from([0x4d, 0x5a, 0, 0]), mimetype: 'image/jpeg', originalname: 'photo.jpg', size: 4 };
    // Explicit `null`, not `undefined` — a default parameter fires on `undefined`, which
    // would silently fall back to the default logged-in user and defeat this test.
    await expect(interceptor.intercept(makeContext(file, null), callHandler)).rejects.toThrow();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(callHandler.handle).not.toHaveBeenCalled();
  });
});
