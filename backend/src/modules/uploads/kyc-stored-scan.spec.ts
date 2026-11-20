import sharp from 'sharp';

jest.mock('clamscan', () => {
  const scanStream = jest.fn();
  const init = jest.fn().mockImplementation(async () => ({ scanStream }));
  const Ctor: any = jest.fn().mockImplementation(() => ({ init }));
  Ctor.__mocks = { init, scanStream };
  return Ctor;
});

import NodeClamMocked from 'clamscan';
import { __resetClamscanClientForTests } from './upload-security.interceptor';
import { scanStoredKycDocuments } from './kyc-stored-scan';

const { init: mockInit, scanStream: mockScanStream } = (NodeClamMocked as any).__mocks;
const dataUrl = (mime: string, buf: Buffer) => `data:${mime};base64,${buf.toString('base64')}`;

/** A Prisma double that serves `rows` per model with cursor pagination and has NO write methods. */
function readOnlyPrisma(rowsByModel: Record<string, any[]>) {
  const prisma: any = {};
  for (const model of ['vendorDocument', 'sellerDocument', 'partnerRegistration', 'sellerRegistration']) {
    const rows = rowsByModel[model] ?? [];
    prisma[model] = {
      findMany: jest.fn(async ({ take, cursor }: any) => {
        const start = cursor ? rows.findIndex((r) => r.id === cursor.id) + 1 : 0;
        return rows.slice(start, start + take);
      }),
    };
  }
  return prisma;
}

describe('scanStoredKycDocuments (read-only audit)', () => {
  let png: Buffer;
  beforeAll(async () => { png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).png().toBuffer(); });
  beforeEach(() => {
    __resetClamscanClientForTests();
    mockInit.mockReset().mockImplementation(async () => ({ scanStream: mockScanStream }));
    mockScanStream.mockReset().mockResolvedValue({ isInfected: false, viruses: [] });
  });

  it('reports bad documents across all KYC tables, skips hosted URLs, and paginates', async () => {
    const exeAsJpeg = dataUrl('image/jpeg', Buffer.from('MZ\x90\x00payload', 'binary'));
    const prisma = readOnlyPrisma({
      vendorDocument: [
        { id: 'v1', url: dataUrl('image/png', png) },
        { id: 'v2', url: exeAsJpeg },
        { id: 'v3', url: 'https://res.cloudinary.com/x.webp' },
      ],
      sellerRegistration: [{ id: 's1', panCardUrl: dataUrl('image/png', png), warehouseImages: [exeAsJpeg] }],
    });

    const report = await scanStoredKycDocuments(prisma, { batchSize: 2 });

    expect(report.scanned).toBe(4);
    expect(report.skippedNotInline).toBe(1);
    expect(report.flagged.map((f) => `${f.model}#${f.id}.${f.field}`)).toEqual([
      'vendorDocument#v2.url', 'sellerRegistration#s1.warehouseImages',
    ]);
    expect(prisma.vendorDocument.findMany).toHaveBeenCalledTimes(3); // 2 + 1 + empty page
  });

  it('flags malware found by ClamAV', async () => {
    mockScanStream.mockResolvedValueOnce({ isInfected: true, viruses: ['Eicar-Test-Signature'] });
    const prisma = readOnlyPrisma({ sellerDocument: [{ id: 'd1', url: dataUrl('image/png', png) }] });
    const report = await scanStoredKycDocuments(prisma);
    expect(report.flagged).toEqual([expect.objectContaining({ model: 'sellerDocument', id: 'd1', field: 'url' })]);
  });

  it('aborts (never reports "clean") when the scanner is unreachable', async () => {
    mockScanStream.mockRejectedValue(new Error('ECONNREFUSED'));
    const prisma = readOnlyPrisma({ vendorDocument: [{ id: 'v1', url: dataUrl('image/png', png) }] });
    await expect(scanStoredKycDocuments(prisma)).rejects.toThrow(/scanner unavailable/);
  });
});
