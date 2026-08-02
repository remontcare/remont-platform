import { BadRequestException } from '@nestjs/common';
import { ServiceVendorsService } from './vendors.module';

/**
 * Attendance security regressions: fake/implausible GPS, duplicate check-in overwriting the
 * original timestamp, and checking out without ever having checked in.
 */
function makeService() {
  const prisma: any = {
    serviceVendor: { findUnique: jest.fn() },
    vendorAttendance: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  };
  const whatsapp: any = {};
  const events: any = { emit: jest.fn() };
  const ledger: any = {};
  const service = new ServiceVendorsService(prisma, whatsapp, events, ledger);
  return { service, prisma };
}

const vendor = { id: 'vendor-1', userId: 'vendor-user-1' };

describe('ServiceVendorsService attendance security', () => {
  describe('checkIn', () => {
    it('rejects coordinates far outside plausible India bounds', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(vendor);

      await expect(service.checkIn('vendor-user-1', 0, 0)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.vendorAttendance.upsert).not.toHaveBeenCalled();
    });

    it('accepts a check-in with no GPS coordinates at all', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(vendor);
      prisma.vendorAttendance.findUnique.mockResolvedValue(null);
      prisma.vendorAttendance.upsert.mockResolvedValue({ id: 'att-1', checkInAt: new Date() });

      await expect(service.checkIn('vendor-user-1')).resolves.toBeDefined();
      expect(prisma.vendorAttendance.upsert).toHaveBeenCalled();
    });

    it('rejects a second check-in the same day instead of overwriting the first timestamp', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(vendor);
      const firstCheckIn = new Date('2026-08-01T03:00:00Z');
      prisma.vendorAttendance.findUnique.mockResolvedValue({ id: 'att-1', checkInAt: firstCheckIn });

      await expect(service.checkIn('vendor-user-1', 23.2599, 77.4126)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.vendorAttendance.upsert).not.toHaveBeenCalled();
    });

    it('allows a valid first check-in of the day with plausible coordinates', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(vendor);
      prisma.vendorAttendance.findUnique.mockResolvedValue(null);
      prisma.vendorAttendance.upsert.mockResolvedValue({ id: 'att-1', checkInAt: new Date() });

      await expect(service.checkIn('vendor-user-1', 23.2599, 77.4126)).resolves.toBeDefined();
      expect(prisma.vendorAttendance.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ checkInLat: 23.2599, checkInLng: 77.4126 }),
      }));
    });
  });

  describe('checkOut', () => {
    it('rejects a check-out with no prior check-in for the day', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(vendor);
      prisma.vendorAttendance.findUnique.mockResolvedValue(null);

      await expect(service.checkOut('vendor-user-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.vendorAttendance.update).not.toHaveBeenCalled();
    });

    it('rejects a duplicate check-out for a day already checked out', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(vendor);
      prisma.vendorAttendance.findUnique.mockResolvedValue({
        id: 'att-1', checkInAt: new Date(), checkOutAt: new Date(),
      });

      await expect(service.checkOut('vendor-user-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.vendorAttendance.update).not.toHaveBeenCalled();
    });

    it('allows check-out once checked in and not yet checked out', async () => {
      const { service, prisma } = makeService();
      prisma.serviceVendor.findUnique.mockResolvedValue(vendor);
      prisma.vendorAttendance.findUnique.mockResolvedValue({ id: 'att-1', checkInAt: new Date(), checkOutAt: null });
      prisma.vendorAttendance.update.mockResolvedValue({ id: 'att-1', checkOutAt: new Date() });

      await expect(service.checkOut('vendor-user-1')).resolves.toBeDefined();
      expect(prisma.vendorAttendance.update).toHaveBeenCalled();
    });
  });
});
