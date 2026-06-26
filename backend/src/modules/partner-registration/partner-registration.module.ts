import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.module';
import { Public, JwtAuthGuard, RolesGuard, Roles } from '../../common';
import { UserRole } from '@prisma/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateRegistrationId(): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PR-${date}-${rand}`;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class PartnerRegistrationService {
  private readonly logger = new Logger(PartnerRegistrationService.name);

  constructor(private prisma: PrismaService) {}

  /** Send/resend OTP — delegates to auth flow, here we just create the draft record */
  async initRegistration(phone: string, language: string) {
    const normalized = phone.startsWith('+91') ? phone : `+91${phone.replace(/\D/g, '')}`;

    // Find most recent non-rejected registration for this phone
    const existing = await this.prisma.partnerRegistration.findFirst({
      where: { phone: normalized },
      orderBy: { createdAt: 'desc' },
    });

    // If already approved, return status info
    if (existing && existing.status === 'APPROVED') {
      return { registrationId: existing.registrationId, alreadyApproved: true, status: 'APPROVED' };
    }

    // If submitted and pending review, return existing
    if (existing && existing.agreedTerms && existing.status === 'PENDING') {
      return { registrationId: existing.registrationId, alreadySubmitted: true, status: 'PENDING' };
    }

    // Use existing draft or create new one
    if (existing && !existing.agreedTerms) {
      // Resume existing draft
      await this.prisma.partnerRegistration.update({
        where: { id: existing.id },
        data: { language },
      });
      return { registrationId: existing.registrationId, isNew: false };
    }

    const draft = await this.prisma.partnerRegistration.create({
      data: {
        registrationId: generateRegistrationId(),
        phone: normalized,
        language,
        currentStep: 1,
      },
    });

    return { registrationId: draft.registrationId, isNew: true };
  }

  /** Save step data (autosave) — accepts any partial step payload */
  async saveStep(registrationId: string, step: number, data: Record<string, any>) {
    const rec = await this.prisma.partnerRegistration.findUnique({ where: { registrationId } });
    if (!rec) throw new NotFoundException('Registration not found');
    if (rec.agreedTerms && rec.currentStep >= 8) {
      throw new BadRequestException('Registration already submitted');
    }

    // Sanitize: strip any status/id fields from client payload
    const { id, status, createdAt, updatedAt, registrationId: _rid, ...safe } = data;

    await this.prisma.partnerRegistration.update({
      where: { registrationId },
      data: { ...safe, currentStep: Math.max(rec.currentStep, step) },
    });

    return { saved: true, step };
  }

  /** Final submit — validate required fields and mark as submitted */
  async submit(registrationId: string) {
    const rec = await this.prisma.partnerRegistration.findUnique({ where: { registrationId } });
    if (!rec) throw new NotFoundException('Registration not found');

    // Core required validations
    if (!rec.fullName || rec.fullName === '') throw new BadRequestException('Full name is required');
    if (!rec.phone) throw new BadRequestException('Phone number is required');
    if (!rec.categories || rec.categories.length === 0) throw new BadRequestException('At least one service category is required');
    if (!rec.agreedTerms || !rec.agreedBackground || !rec.agreedCommission || !rec.agreedStandards) {
      throw new BadRequestException('All agreements must be accepted');
    }

    await this.prisma.partnerRegistration.update({
      where: { registrationId },
      data: { status: 'PENDING', currentStep: 8, agreedAt: new Date() },
    });

    this.logger.log(`Partner registration submitted: ${registrationId} — ${rec.fullName} (${rec.phone})`);

    return {
      registrationId: rec.registrationId,
      status: 'PENDING',
      message: 'Registration submitted successfully! Our team will review and contact you within 24-48 hours.',
    };
  }

  /** Check registration status by phone */
  async checkStatus(phone: string) {
    const normalized = phone.startsWith('+91') ? phone : `+91${phone.replace(/\D/g, '')}`;
    const rec = await this.prisma.partnerRegistration.findFirst({
      where: { phone: normalized },
      select: {
        registrationId: true, status: true, fullName: true, currentStep: true,
        categories: true, city: true, createdAt: true, adminNotes: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!rec) throw new NotFoundException('No registration found for this phone number');
    return rec;
  }

  /** Get draft by registration ID (for resuming) */
  async getDraft(registrationId: string) {
    const rec = await this.prisma.partnerRegistration.findUnique({ where: { registrationId } });
    if (!rec) throw new NotFoundException('Registration not found');
    // Strip large binary fields for the draft fetch (frontend will re-show previews from its own memory)
    return {
      ...rec,
      idProofFront: rec.idProofFront ? '[uploaded]' : null,
      idProofBack:  rec.idProofBack  ? '[uploaded]' : null,
      panCardUrl:   rec.panCardUrl   ? '[uploaded]' : null,
      profilePhotoUrl: rec.profilePhotoUrl ? '[uploaded]' : null,
      skillCertificateUrl: rec.skillCertificateUrl ? '[uploaded]' : null,
      policeVerificationUrl: rec.policeVerificationUrl ? '[uploaded]' : null,
      cancelledChequeUrl: rec.cancelledChequeUrl ? '[uploaded]' : null,
    };
  }

  // ─── Admin methods ───────────────────────────────────────────────────────

  async adminList(status?: string, city?: string, q?: string, page = 1) {
    const take = 20;
    const skip = (page - 1) * take;
    const where: any = {};
    if (status) where.status = status;
    if (city)   where.city   = { contains: city, mode: 'insensitive' };
    if (q) {
      where.OR = [
        { fullName:  { contains: q, mode: 'insensitive' } },
        { phone:     { contains: q } },
        { registrationId: { contains: q } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.partnerRegistration.count({ where }),
      this.prisma.partnerRegistration.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip, take,
        select: {
          id: true, registrationId: true, fullName: true, phone: true, email: true,
          city: true, categories: true, experienceYears: true, status: true,
          currentStep: true, adminNotes: true, createdAt: true, updatedAt: true,
          profilePhotoUrl: false, // skip large binaries in list
          idProofFront: false,    // load in detail view only
        },
      }),
    ]);

    return { total, page, pages: Math.ceil(total / take), items };
  }

  async adminDetail(id: string) {
    const rec = await this.prisma.partnerRegistration.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('Registration not found');
    return rec;
  }

  async adminUpdateStatus(id: string, status: string, adminNotes?: string) {
    const allowed = ['PENDING', 'APPROVED', 'REJECTED', 'HOLD', 'MORE_DOCS'];
    if (!allowed.includes(status)) throw new BadRequestException('Invalid status');

    const reg = await this.prisma.partnerRegistration.findUnique({ where: { id } });
    if (!reg) throw new NotFoundException('Registration not found');

    const updated = await this.prisma.partnerRegistration.update({
      where: { id },
      data: { status, adminNotes: adminNotes || undefined },
    });

    // On APPROVED: ensure User has SERVICE_VENDOR role + create/update ServiceVendor profile
    if (status === 'APPROVED') {
      await this._activatePartner(reg);
    }

    return updated;
  }

  private async _activatePartner(reg: any) {
    try {
      // 1. Find or create the User and set role to SERVICE_VENDOR
      let user = await this.prisma.user.findFirst({ where: { phone: reg.phone } });
      if (!user) {
        user = await this.prisma.user.create({
          data: {
            phone: reg.phone,
            name: reg.fullName || 'Partner',
            email: reg.email || undefined,
            role: UserRole.SERVICE_VENDOR,
            isVerified: true,
          },
        });
      } else {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            role: UserRole.SERVICE_VENDOR,
            isVerified: true,
            name: reg.fullName || user.name,
            ...(reg.email ? { email: reg.email } : {}),
          },
        });
      }

      // 2. Link userId back to the registration
      await this.prisma.partnerRegistration.update({
        where: { id: reg.id },
        data: { userId: user.id },
      });

      // 3. Create or update ServiceVendor record from registration data
      const skills = reg.categories || [];
      await this.prisma.serviceVendor.upsert({
        where: { userId: user.id },
        create: {
          userId:           user.id,
          fullName:         reg.fullName || 'Partner',
          baseCity:         reg.city     || '',
          skills,
          preferredLanguage: reg.language === 'HI' ? 'HI' : 'EN',
          currentLatitude:  reg.latitude  || null,
          currentLongitude: reg.longitude || null,
          status:           'ACTIVE',
        },
        update: {
          fullName: reg.fullName || 'Partner',
          baseCity: reg.city    || '',
          skills,
          status:   'ACTIVE',
          ...(reg.latitude  ? { currentLatitude:  reg.latitude  } : {}),
          ...(reg.longitude ? { currentLongitude: reg.longitude } : {}),
        },
      });

      // 4. Save key documents to VendorDocument table
      const sv = await this.prisma.serviceVendor.findUnique({ where: { userId: user.id } });
      if (sv) {
        const docFields: Array<[string, string]> = [
          ['idProofFront', reg.idProofType ? `${reg.idProofType}_FRONT` : 'ID_FRONT'],
          ['idProofBack',  reg.idProofType ? `${reg.idProofType}_BACK`  : 'ID_BACK'],
          ['panCardUrl',   'PAN'],
          ['profilePhotoUrl', 'PHOTO'],
          ['policeVerificationUrl', 'POLICE_CERT'],
          ['cancelledChequeUrl', 'CHEQUE'],
        ];
        for (const [field, docType] of docFields) {
          const url = (reg as any)[field];
          if (url && url !== '[uploaded]') {
            // Delete old doc of same type then re-create (avoid duplicate upsert issues)
            await this.prisma.vendorDocument.deleteMany({ where: { vendorId: sv.id, type: docType } });
            await this.prisma.vendorDocument.create({
              data: { vendorId: sv.id, type: docType, url, verified: true },
            });
          }
        }
      }

      this.logger.log(`✅ Partner activated: ${reg.fullName} (${reg.phone}) → userId ${user.id}`);
    } catch (e) {
      this.logger.error(`Failed to activate partner ${reg.registrationId}: ${e.message}`);
    }
  }
}

// ─── Public Controller ────────────────────────────────────────────────────────

@ApiTags('Partner Registration')
@Controller('partner-registration')
export class PartnerRegistrationController {
  constructor(private svc: PartnerRegistrationService) {}

  @Public()
  @Post('init')
  init(@Body() body: { phone: string; language?: string }) {
    if (!body.phone) throw new BadRequestException('Phone is required');
    return this.svc.initRegistration(body.phone, body.language || 'EN');
  }

  @Public()
  @Post('save-step')
  saveStep(@Body() body: { registrationId: string; step: number; data: Record<string, any> }) {
    if (!body.registrationId) throw new BadRequestException('registrationId is required');
    return this.svc.saveStep(body.registrationId, body.step || 1, body.data || {});
  }

  @Public()
  @Post('submit')
  submit(@Body() body: { registrationId: string }) {
    if (!body.registrationId) throw new BadRequestException('registrationId is required');
    return this.svc.submit(body.registrationId);
  }

  @Public()
  @Get('status')
  status(@Query('phone') phone: string) {
    if (!phone) throw new BadRequestException('phone is required');
    return this.svc.checkStatus(phone);
  }

  @Public()
  @Get('draft/:registrationId')
  draft(@Param('registrationId') id: string) {
    return this.svc.getDraft(id);
  }
}

// ─── Admin Controller ─────────────────────────────────────────────────────────

@ApiTags('Partner Registration')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin/partner-registrations')
export class AdminPartnerRegistrationController {
  constructor(private svc: PartnerRegistrationService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('city')   city?: string,
    @Query('q')      q?: string,
    @Query('page')   page?: string,
  ) {
    return this.svc.adminList(status, city, q, page ? Number(page) : 1);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.svc.adminDetail(id);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() body: { status: string; adminNotes?: string }) {
    return this.svc.adminUpdateStatus(id, body.status, body.adminNotes);
  }
}

// ─── Module ───────────────────────────────────────────────────────────────────

@Module({
  controllers: [PartnerRegistrationController, AdminPartnerRegistrationController],
  providers:   [PartnerRegistrationService],
  exports:     [PartnerRegistrationService],
})
export class PartnerRegistrationModule {}
