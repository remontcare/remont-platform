import sharp from 'sharp';

// Same hoisting-safe clamscan mock as upload-security.interceptor.spec.ts.
jest.mock('clamscan', () => {
  const scanStream = jest.fn();
  const init = jest.fn().mockImplementation(async () => ({ scanStream }));
  const Ctor: any = jest.fn().mockImplementation(() => ({ init }));
  Ctor.__mocks = { init, scanStream };
  return Ctor;
});

import NodeClamMocked from 'clamscan';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { __resetClamscanClientForTests } from './upload-security.interceptor';
import { assertSafeKycDocument } from './kyc-document';

const { init: mockInit, scanStream: mockScanStream } = (NodeClamMocked as any).__mocks;
const dataUrl = (mime: string, buf: Buffer) => `data:${mime};base64,${buf.toString('base64')}`;

let png: Buffer;
beforeAll(async () => {
  png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
});
beforeEach(() => {
  __resetClamscanClientForTests();
  mockInit.mockReset().mockImplementation(async () => ({ scanStream: mockScanStream }));
  mockScanStream.mockReset().mockResolvedValue({ isInfected: false, viruses: [] });
});

describe('assertSafeKycDocument', () => {
  it('accepts a real, clean PNG and a real PDF', async () => {
    await expect(assertSafeKycDocument('doc', dataUrl('image/png', png))).resolves.toBeUndefined();
    await expect(assertSafeKycDocument('doc', dataUrl('application/pdf', Buffer.from('%PDF-1.4\n%%EOF')))).resolves.toBeUndefined();
  });

  it.each([
    ['an EXE relabelled as JPEG', 'image/jpeg', Buffer.from('MZ\x90\x00rest-of-pe', 'binary')],
    ['an APK/ZIP relabelled as PNG', 'image/png', Buffer.from('PK\x03\x04apk', 'binary')],
    ['a script relabelled as PDF', 'application/pdf', Buffer.from('#!/bin/sh\nrm -rf /')],
    ['an SVG declared as image/svg+xml', 'image/svg+xml', Buffer.from('<svg onload="alert(1)"/>')],
    ['a PNG declared as JPEG (type mismatch)', 'image/jpeg', Buffer.alloc(0)],
  ])('rejects %s', async (_label, mime, buf) => {
    const body = buf.length ? buf : png;
    await expect(assertSafeKycDocument('doc', dataUrl(mime, body))).rejects.toBeInstanceOf(BadRequestException);
    expect(mockScanStream).not.toHaveBeenCalled();
  });

  it('rejects non-string / non-data-URL values and PDFs where only images are allowed', async () => {
    await expect(assertSafeKycDocument('doc', { not: null })).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertSafeKycDocument('doc', 'https://evil.example/x.png')).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertSafeKycDocument('doc', dataUrl('application/pdf', Buffer.from('%PDF-1.4')), { allowPdf: false }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects files over 5MB before scanning', async () => {
    const big = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);
    await expect(assertSafeKycDocument('doc', dataUrl('image/png', big))).rejects.toBeInstanceOf(BadRequestException);
    expect(mockScanStream).not.toHaveBeenCalled();
  });

  it('rejects an image whose bytes do not decode', async () => {
    const corrupt = Buffer.concat([png.subarray(0, 16), Buffer.alloc(64)]);
    await expect(assertSafeKycDocument('doc', dataUrl('image/png', corrupt))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects malware and fails closed when ClamAV is unavailable', async () => {
    mockScanStream.mockResolvedValueOnce({ isInfected: true, viruses: ['Eicar-Test-Signature'] });
    await expect(assertSafeKycDocument('doc', dataUrl('image/png', png))).rejects.toBeInstanceOf(BadRequestException);

    mockScanStream.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(assertSafeKycDocument('doc', dataUrl('image/png', png))).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
