import { OrdersService } from './orders.module';

/**
 * Before-work evidence photos: only the assigned partner, only while the job runs, only fresh
 * camera images (never URLs), append-only (pushed, never replaced) and capped.
 */
const IMG = 'data:image/jpeg;base64,AAAA';

function makeService(order: any) {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn().mockResolvedValue({ id: 'vendor-1' }) },
    order: {
      findUnique: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'order-1', photosBefore: [...(order?.photosBefore ?? []), ...data.photosBefore.push] })),
    },
  };
  let n = 0;
  const media: any = {
    ingestDataUrl: jest.fn().mockImplementation(() => Promise.resolve({ id: `m${++n}`, deliveryUrl: `https://cdn/x/${n}.jpg` })),
    remove: jest.fn().mockResolvedValue(undefined),
    linkByUrls: jest.fn().mockResolvedValue(undefined),
  };
  const none = {} as any;
  const svc = new OrdersService(prisma, none, none, none, none, none, none, none, none, none, none, media);
  return { svc, prisma, media };
}

const running = { id: 'order-1', vendorId: 'vendor-1', status: 'STARTED', photosBefore: [] as string[] };

describe('OrdersService.addBeforePhotos', () => {
  it('stores camera images through the media pipeline and appends their URLs', async () => {
    const { svc, prisma, media } = makeService({ ...running, photosBefore: ['https://cdn/x/old.jpg'] });
    const res = await svc.addBeforePhotos('vendor-user-1', 'order-1', [IMG, IMG]);
    expect(media.ingestDataUrl).toHaveBeenCalledTimes(2);
    expect(prisma.order.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'order-1' },
      data: { photosBefore: { push: ['https://cdn/x/1.jpg', 'https://cdn/x/2.jpg'] } },
    }));
    expect(res.photosBefore).toEqual(['https://cdn/x/old.jpg', 'https://cdn/x/1.jpg', 'https://cdn/x/2.jpg']);
    expect(media.linkByUrls).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'order-1' }));
  });

  it('rejects a URL (evidence must be a fresh photo, not a link to any image)', async () => {
    const { svc, prisma } = makeService(running);
    await expect(svc.addBeforePhotos('vendor-user-1', 'order-1', ['https://elsewhere/photo.jpg'])).rejects.toThrow(/camera/);
    await expect(svc.addBeforePhotos('vendor-user-1', 'order-1', [])).rejects.toThrow(/camera/);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('rejects another partner and a job that is not running', async () => {
    await expect(makeService({ ...running, vendorId: 'vendor-2' }).svc.addBeforePhotos('vendor-user-1', 'order-1', [IMG])).rejects.toThrow();
    await expect(makeService({ ...running, status: 'COMPLETED' }).svc.addBeforePhotos('vendor-user-1', 'order-1', [IMG])).rejects.toThrow(/in progress/);
    await expect(makeService({ ...running, status: 'VENDOR_ASSIGNED' }).svc.addBeforePhotos('vendor-user-1', 'order-1', [IMG])).rejects.toThrow(/in progress/);
  });

  it('caps the total at 10 photos', async () => {
    const { svc, media } = makeService({ ...running, photosBefore: Array(9).fill('https://cdn/x/old.jpg') });
    await expect(svc.addBeforePhotos('vendor-user-1', 'order-1', [IMG, IMG])).rejects.toThrow(/At most 10/);
    expect(media.ingestDataUrl).not.toHaveBeenCalled();
  });

  it('removes the uploaded photos when saving them on the order fails', async () => {
    const { svc, prisma, media } = makeService(running);
    prisma.order.update.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.addBeforePhotos('vendor-user-1', 'order-1', [IMG])).rejects.toThrow('db down');
    expect(media.remove).toHaveBeenCalledWith('m1', expect.anything());
  });
});
