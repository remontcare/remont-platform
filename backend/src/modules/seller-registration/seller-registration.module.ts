import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.module';
import { Public, JwtAuthGuard, RolesGuard, Roles } from '../../common';
import { UserRole } from '@prisma/client';
import { WhatsappService, WhatsappModule } from '../whatsapp/whatsapp.module';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateRegistrationId(): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `SR-${date}-${rand}`;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class SellerRegistrationService {
  private readonly logger = new Logger(SellerRegistrationService.name);

  constructor(private prisma: PrismaService, private wa: WhatsappService) {}

  /** Create/resume a draft application — mirrors PartnerRegistrationService.initRegistration() */
  async initRegistration(phone: string) {
    const normalized = phone.startsWith('+91') ? phone : `+91${phone.replace(/\D/g, '')}`;

    const existing = await this.prisma.sellerRegistration.findFirst({
      where: { phone: normalized },
      orderBy: { createdAt: 'desc' },
    });

    if (existing && existing.status === 'APPROVED') {
      return { registrationId: existing.registrationId, alreadyApproved: true, status: 'APPROVED' };
    }
    if (existing && existing.agreedTerms && existing.status === 'PENDING') {
      return { registrationId: existing.registrationId, alreadySubmitted: true, status: 'PENDING' };
    }
    if (existing && !existing.agreedTerms) {
      return { registrationId: existing.registrationId, isNew: false };
    }

    const draft = await this.prisma.sellerRegistration.create({
      data: { registrationId: generateRegistrationId(), phone: normalized, currentStep: 1 },
    });
    return { registrationId: draft.registrationId, isNew: true };
  }

  /** Save step data (autosave) — accepts any partial step payload, same pattern as partner registration */
  async saveStep(registrationId: string, step: number, data: Record<string, any>) {
    const rec = await this.prisma.sellerRegistration.findUnique({ where: { registrationId } });
    if (!rec) throw new NotFoundException('Registration not found');
    if (rec.agreedTerms && rec.status !== 'MORE_INFO') {
      throw new BadRequestException('Registration already submitted');
    }

    // Sanitize: strip status/id/relation fields the client must never set directly
    const { id, status, createdAt, updatedAt, registrationId: _rid, pickupLocations, ...safe } = data;

    await this.prisma.sellerRegistration.update({
      where: { registrationId },
      data: { ...safe, currentStep: Math.max(rec.currentStep, step) },
    });
    return { saved: true, step };
  }

  /** Replace-semantics pickup-location save for a draft registration (same idea as
   * products.module.ts's syncCityCoverage — full replace, not accumulate, so re-saving a
   * step never duplicates locations). */
  async savePickupLocations(registrationId: string, locations: any[]) {
    const rec = await this.prisma.sellerRegistration.findUnique({ where: { registrationId } });
    if (!rec) throw new NotFoundException('Registration not found');
    if (!locations?.length) throw new BadRequestException('At least one pickup location is required');

    const primaryCount = locations.filter((l) => l.isPrimary).length;
    if (primaryCount === 0) locations[0].isPrimary = true;

    await this.prisma.sellerRegistrationPickup.deleteMany({ where: { registrationId: rec.id } });
    await this.prisma.sellerRegistrationPickup.createMany({
      data: locations.map((l) => ({
        registrationId: rec.id,
        name: l.name, contactPerson: l.contactPerson || null, mobile: l.mobile || null,
        alternateMobile: l.alternateMobile || null, address: l.address, landmark: l.landmark || null,
        city: l.city, state: l.state, pincode: l.pincode,
        latitude: l.latitude, longitude: l.longitude,
        placeId: l.placeId || null, formattedAddress: l.formattedAddress || null,
        isPrimary: !!l.isPrimary,
      })),
    });
    return { saved: true, count: locations.length };
  }

  async getPickupLocations(registrationId: string) {
    const rec = await this.prisma.sellerRegistration.findUnique({ where: { registrationId } });
    if (!rec) throw new NotFoundException('Registration not found');
    return this.prisma.sellerRegistrationPickup.findMany({ where: { registrationId: rec.id }, orderBy: { isPrimary: 'desc' } });
  }

  /** Final submit — validate required fields and mark as submitted */
  async submit(registrationId: string) {
    const rec = await this.prisma.sellerRegistration.findUnique({
      where: { registrationId },
      include: { pickupLocations: true },
    });
    if (!rec) throw new NotFoundException('Registration not found');

    if (!rec.businessName) throw new BadRequestException('Business name is required');
    if (!rec.ownerName) throw new BadRequestException('Owner name is required');
    if (!rec.phone) throw new BadRequestException('Phone number is required');
    if (!rec.pickupLocations.length) throw new BadRequestException('At least one pickup location is required');
    if (!rec.bankAccountNumber || !rec.bankIfsc) throw new BadRequestException('Bank account details are required');
    if (!rec.agreedTerms) throw new BadRequestException('You must accept the terms and policies to continue');

    await this.prisma.sellerRegistration.update({
      where: { registrationId },
      data: { status: 'PENDING', currentStep: 8, agreedAt: new Date() },
    });

    this.logger.log(`Seller registration submitted: ${registrationId} — ${rec.businessName} (${rec.phone})`);
    this.notify(rec.phone, `Thanks for applying to sell on Remont India! Your application ${registrationId} is under review. We'll notify you within 24-48 hours.`).catch(() => undefined);

    return {
      registrationId: rec.registrationId,
      status: 'PENDING',
      message: 'Application submitted! Our team will review your documents and contact you within 24-48 hours.',
    };
  }

  async checkStatus(phone: string) {
    const normalized = phone.startsWith('+91') ? phone : `+91${phone.replace(/\D/g, '')}`;
    const rec = await this.prisma.sellerRegistration.findFirst({
      where: { phone: normalized },
      select: {
        registrationId: true, status: true, businessName: true, currentStep: true,
        city: true, createdAt: true, adminNotes: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!rec) throw new NotFoundException('No registration found for this phone number');
    return rec;
  }

  async getDraft(registrationId: string) {
    const rec = await this.prisma.sellerRegistration.findUnique({
      where: { registrationId },
      include: { pickupLocations: true },
    });
    if (!rec) throw new NotFoundException('Registration not found');
    // Strip large binary fields — frontend re-shows previews from its own memory during a session
    return {
      ...rec,
      gstCertificateUrl: rec.gstCertificateUrl ? '[uploaded]' : null,
      panCardUrl: rec.panCardUrl ? '[uploaded]' : null,
      cancelledChequeUrl: rec.cancelledChequeUrl ? '[uploaded]' : null,
      bankPassbookUrl: rec.bankPassbookUrl ? '[uploaded]' : null,
      businessProofUrl: rec.businessProofUrl ? '[uploaded]' : null,
      addressProofUrl: rec.addressProofUrl ? '[uploaded]' : null,
      ownerPhotoUrl: rec.ownerPhotoUrl ? '[uploaded]' : null,
      ownerAadhaarUrl: rec.ownerAadhaarUrl ? '[uploaded]' : null,
    };
  }

  // ─── Admin methods ───────────────────────────────────────────────────────

  async adminList(status?: string, city?: string, q?: string, page = 1) {
    const take = 20;
    const skip = (page - 1) * take;
    const where: any = {};
    if (status) where.status = status;
    if (city) where.city = { contains: city, mode: 'insensitive' };
    if (q) {
      where.OR = [
        { businessName: { contains: q, mode: 'insensitive' } },
        { ownerName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { registrationId: { contains: q } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.sellerRegistration.count({ where }),
      this.prisma.sellerRegistration.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip, take,
        select: {
          id: true, registrationId: true, businessName: true, ownerName: true, phone: true, email: true,
          city: true, gstNumber: true, status: true, currentStep: true, adminNotes: true,
          createdAt: true, updatedAt: true,
        },
      }),
    ]);
    return { total, page, pages: Math.ceil(total / take), items };
  }

  async adminDetail(id: string) {
    const rec = await this.prisma.sellerRegistration.findUnique({
      where: { id },
      include: { pickupLocations: true },
    });
    if (!rec) throw new NotFoundException('Registration not found');
    return rec;
  }

  async adminUpdateStatus(id: string, status: string, adminNotes?: string) {
    const allowed = ['PENDING', 'APPROVED', 'REJECTED', 'HOLD', 'MORE_INFO'];
    if (!allowed.includes(status)) throw new BadRequestException('Invalid status');

    const reg = await this.prisma.sellerRegistration.findUnique({ where: { id }, include: { pickupLocations: true } });
    if (!reg) throw new NotFoundException('Registration not found');

    const updated = await this.prisma.sellerRegistration.update({
      where: { id },
      data: { status, adminNotes: adminNotes || undefined },
    });

    if (status === 'APPROVED') await this._activateSeller(reg);

    const notifyMsg: Record<string, string> = {
      APPROVED: `Congratulations! Your Remont India seller application (${reg.registrationId}) has been approved. Log in at the Seller Portal with your registered mobile number to get started.`,
      REJECTED: `Your Remont India seller application (${reg.registrationId}) could not be approved.${adminNotes ? ' Reason: ' + adminNotes : ''}`,
      HOLD: `Your Remont India seller application (${reg.registrationId}) is on hold. ${adminNotes || 'Our team will contact you shortly.'}`,
      MORE_INFO: `We need more information for your Remont India seller application (${reg.registrationId}). ${adminNotes || 'Please check your application and update the requested details.'}`,
    };
    if (notifyMsg[status]) this.notify(reg.phone, notifyMsg[status]).catch(() => undefined);

    return updated;
  }

  /** Best-effort WhatsApp notification — no email/SMS provider is configured, so this is the
   * only real channel today. Never throws; a notification failure must not block the review action. */
  private async notify(phone: string, message: string) {
    try {
      await this.wa.sendCustom(phone, message);
    } catch (e) {
      this.logger.warn(`Notify failed for ${phone}: ${e.message}`);
    }
  }

  private async _activateSeller(reg: any) {
    try {
      // 1. Find or create the User and set role to PRODUCT_VENDOR — never downgrade an
      // existing ADMIN/SUPER_ADMIN/other role, same safeguard as _activatePartner().
      let user = await this.prisma.user.findFirst({ where: { phone: reg.phone } });
      if (!user) {
        user = await this.prisma.user.create({
          data: { phone: reg.phone, name: reg.ownerName || reg.businessName || 'Seller', email: reg.email || undefined, role: UserRole.PRODUCT_VENDOR, isVerified: true },
        });
      } else {
        const newRole = user.role === UserRole.CUSTOMER ? UserRole.PRODUCT_VENDOR : user.role;
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { role: newRole, isVerified: true, name: reg.ownerName || user.name, ...(reg.email ? { email: reg.email } : {}) },
        });
      }

      await this.prisma.sellerRegistration.update({ where: { id: reg.id }, data: { userId: user.id } });

      // 2. Create or update the ProductVendor record from the application
      const vendor = await this.prisma.productVendor.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          businessName: reg.businessName,
          ownerName: reg.ownerName,
          businessType: reg.businessType,
          gstNumber: reg.gstNumber,
          panNumber: reg.panNumber,
          aadhaarNumber: reg.aadhaarNumber,
          cin: reg.cin,
          msmeNumber: reg.msmeNumber,
          alternatePhone: reg.alternatePhone,
          whatsappNumber: reg.whatsappNumber,
          email: reg.email,
          city: reg.city,
          address: reg.registeredAddress,
          officeAddress: reg.officeAddress,
          warehouseAddress: reg.warehouseAddress,
          bankAccountHolder: reg.bankAccountHolder,
          bankName: reg.bankName,
          bankAccountNumber: reg.bankAccountNumber,
          bankIfsc: reg.bankIfsc,
          bankBranch: reg.bankBranch,
          upiId: reg.upiId,
          status: 'ACTIVE',
        },
        update: {
          businessName: reg.businessName, ownerName: reg.ownerName, businessType: reg.businessType,
          gstNumber: reg.gstNumber, panNumber: reg.panNumber, aadhaarNumber: reg.aadhaarNumber,
          cin: reg.cin, msmeNumber: reg.msmeNumber, alternatePhone: reg.alternatePhone,
          whatsappNumber: reg.whatsappNumber, email: reg.email, city: reg.city,
          address: reg.registeredAddress, officeAddress: reg.officeAddress, warehouseAddress: reg.warehouseAddress,
          bankAccountHolder: reg.bankAccountHolder, bankName: reg.bankName, bankAccountNumber: reg.bankAccountNumber,
          bankIfsc: reg.bankIfsc, bankBranch: reg.bankBranch, upiId: reg.upiId, status: 'ACTIVE',
        },
      });

      // 3. Provision real PickupLocation rows from the application's draft locations
      // (replace-semantics: clear any previous set from an earlier approval-then-reapply cycle)
      await this.prisma.pickupLocation.deleteMany({ where: { vendorId: vendor.id } });
      if (reg.pickupLocations?.length) {
        await this.prisma.pickupLocation.createMany({
          data: reg.pickupLocations.map((l: any) => ({
            vendorId: vendor.id, name: l.name, contactPerson: l.contactPerson, mobile: l.mobile,
            alternateMobile: l.alternateMobile, address: l.address, landmark: l.landmark,
            city: l.city, state: l.state, pincode: l.pincode, latitude: l.latitude, longitude: l.longitude,
            placeId: l.placeId, formattedAddress: l.formattedAddress, isPrimary: l.isPrimary,
          })),
        });
      }

      // 4. Save documents to SellerDocument
      const docFields: Array<[string, string]> = [
        ['gstCertificateUrl', 'GST_CERTIFICATE'], ['panCardUrl', 'PAN_CARD'],
        ['cancelledChequeUrl', 'CANCELLED_CHEQUE'], ['bankPassbookUrl', 'BANK_PASSBOOK'],
        ['businessProofUrl', 'BUSINESS_PROOF'], ['addressProofUrl', 'ADDRESS_PROOF'],
        ['ownerPhotoUrl', 'OWNER_PHOTO'], ['ownerAadhaarUrl', 'OWNER_AADHAAR'],
      ];
      for (const [field, docType] of docFields) {
        const url = (reg as any)[field];
        if (url && url !== '[uploaded]') {
          await this.prisma.sellerDocument.deleteMany({ where: { vendorId: vendor.id, type: docType } });
          await this.prisma.sellerDocument.create({ data: { vendorId: vendor.id, type: docType, url, verified: true } });
        }
      }
      for (const url of reg.warehouseImages || []) {
        await this.prisma.sellerDocument.create({ data: { vendorId: vendor.id, type: 'WAREHOUSE_IMAGE', url, verified: true } });
      }
      for (const url of reg.storeImages || []) {
        await this.prisma.sellerDocument.create({ data: { vendorId: vendor.id, type: 'STORE_IMAGE', url, verified: true } });
      }

      this.logger.log(`✅ Seller activated: ${reg.businessName} (${reg.phone}) → userId ${user.id}, vendorId ${vendor.id}`);
    } catch (e) {
      this.logger.error(`Failed to activate seller ${reg.registrationId}: ${e.message}`);
    }
  }
}

// ─── Public Controller ────────────────────────────────────────────────────────

@ApiTags('Seller Registration')
@Controller('seller-registration')
export class SellerRegistrationController {
  constructor(private svc: SellerRegistrationService) {}

  @Public() @Post('init')
  init(@Body() body: { phone: string }) {
    if (!body.phone) throw new BadRequestException('Phone is required');
    return this.svc.initRegistration(body.phone);
  }

  @Public() @Post('save-step')
  saveStep(@Body() body: { registrationId: string; step: number; data: Record<string, any> }) {
    if (!body.registrationId) throw new BadRequestException('registrationId is required');
    return this.svc.saveStep(body.registrationId, body.step || 1, body.data || {});
  }

  @Public() @Post('pickup-locations')
  savePickups(@Body() body: { registrationId: string; locations: any[] }) {
    if (!body.registrationId) throw new BadRequestException('registrationId is required');
    return this.svc.savePickupLocations(body.registrationId, body.locations || []);
  }

  @Public() @Get('pickup-locations/:registrationId')
  getPickups(@Param('registrationId') id: string) {
    return this.svc.getPickupLocations(id);
  }

  @Public() @Post('submit')
  submit(@Body() body: { registrationId: string }) {
    if (!body.registrationId) throw new BadRequestException('registrationId is required');
    return this.svc.submit(body.registrationId);
  }

  @Public() @Get('status')
  status(@Query('phone') phone: string) {
    if (!phone) throw new BadRequestException('phone is required');
    return this.svc.checkStatus(phone);
  }

  @Public() @Get('draft/:registrationId')
  draft(@Param('registrationId') id: string) {
    return this.svc.getDraft(id);
  }
}

// ─── Admin Controller ─────────────────────────────────────────────────────────

@ApiTags('Seller Registration')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin/seller-registrations')
export class AdminSellerRegistrationController {
  constructor(private svc: SellerRegistrationService) {}

  @Get() list(
    @Query('status') status?: string,
    @Query('city') city?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
  ) {
    return this.svc.adminList(status, city, q, page ? Number(page) : 1);
  }

  @Get(':id') detail(@Param('id') id: string) { return this.svc.adminDetail(id); }

  @Patch(':id/status') updateStatus(@Param('id') id: string, @Body() body: { status: string; adminNotes?: string }) {
    return this.svc.adminUpdateStatus(id, body.status, body.adminNotes);
  }
}

// ─── Module ───────────────────────────────────────────────────────────────────

@Module({
  imports: [WhatsappModule],
  controllers: [SellerRegistrationController, AdminSellerRegistrationController],
  providers: [SellerRegistrationService],
  exports: [SellerRegistrationService],
})
export class SellerRegistrationModule {}
