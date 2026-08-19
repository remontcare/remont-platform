import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.module';
import { Public, JwtAuthGuard, RolesGuard, Roles, normalizeSkillKey } from '../../common';
import { UserRole } from '@prisma/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateRegistrationId(): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PR-${date}-${rand}`;
}

// Rough India bounding box (mainland + Andaman/Nicobar + Lakshadweep), with a small margin —
// good enough to reject an obviously-wrong/spoofed location without misclassifying a real
// border-area applicant. Not a precise polygon; that's an acceptable trade-off for this check.
function isWithinIndiaBounds(lat: number, lng: number): boolean {
  return lat >= 6 && lat <= 38 && lng >= 68 && lng <= 98;
}

// Every document field is a client-supplied base64 data URL (see partner-register.html's
// FileReader-based upload) — the frontend's file-type/size check is JS-only and trivially
// bypassed by calling this public API directly, so it must be re-verified server-side.
// Checking real magic bytes (not just the claimed data: URL mime prefix, which is also
// entirely client-controlled) is what actually stops a renamed/relabeled file from passing.
const DOCUMENT_FIELDS = [
  'idProofFront', 'idProofBack', 'panCardUrl', 'profilePhotoUrl',
  'skillCertificateUrl', 'policeVerificationUrl', 'cancelledChequeUrl',
] as const;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const DOCUMENT_MAGIC_BYTES: Record<string, Buffer> = {
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'application/pdf': Buffer.from([0x25, 0x50, 0x44, 0x46]),
};

function validateDocumentDataUrl(field: string, value: string): void {
  const match = /^data:([\w./+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new BadRequestException(`${field}: invalid file — only JPG, PNG, or PDF uploads are allowed`);
  const mime = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const magic = DOCUMENT_MAGIC_BYTES[mime];
  if (!magic) throw new BadRequestException(`${field}: only JPG, PNG, or PDF files are allowed`);
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > MAX_DOCUMENT_BYTES) throw new BadRequestException(`${field}: file must be under 5MB`);
  if (!buf.subarray(0, magic.length).equals(magic)) {
    throw new BadRequestException(`${field}: file content does not match its declared type — upload rejected`);
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class PartnerRegistrationService {
  private readonly logger = new Logger(PartnerRegistrationService.name);

  constructor(private prisma: PrismaService, private events: EventEmitter2) {}

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

  // Phase 2 — an agency owner invites a team member by phone. Creates the same kind of
  // draft initRegistration() does (so the member completes KYC through the existing
  // partner-register.html flow and admin approves through the existing admin screen),
  // just pre-filled and tagged with invitedByAgencyId so _activatePartner() links the
  // resulting ServiceVendor to this agency once approved.
  async inviteAgencyMember(agencyOwnerVendorId: string, phone: string, fullName?: string, skills?: string[]) {
    const normalized = phone.startsWith('+91') ? phone : `+91${phone.replace(/\D/g, '')}`;
    const existing = await this.prisma.partnerRegistration.findFirst({ where: { phone: normalized }, orderBy: { createdAt: 'desc' } });
    if (existing && existing.status === 'APPROVED') throw new BadRequestException('This phone number is already an active partner');
    if (existing && existing.agreedTerms && existing.status === 'PENDING') throw new BadRequestException('This phone number already has a pending application');
    if (existing && !existing.agreedTerms) {
      const updated = await this.prisma.partnerRegistration.update({
        where: { id: existing.id },
        data: { invitedByAgencyId: agencyOwnerVendorId, ...(fullName ? { fullName } : {}), ...(skills?.length ? { categories: skills } : {}) },
      });
      return { registrationId: updated.registrationId, isNew: false };
    }
    const draft = await this.prisma.partnerRegistration.create({
      data: {
        registrationId: generateRegistrationId(), phone: normalized, currentStep: 1,
        invitedByAgencyId: agencyOwnerVendorId, fullName: fullName || undefined, categories: skills?.length ? skills : undefined,
      },
    });
    return { registrationId: draft.registrationId, isNew: true };
  }

  /** Save step data (autosave) — accepts any partial step payload */
  async saveStep(registrationId: string, step: number, data: Record<string, any>) {
    const rec = await this.prisma.partnerRegistration.findUnique({ where: { registrationId } });
    if (!rec) throw new NotFoundException('Registration not found');
    // MORE_DOCS/HOLD are exactly "admin sent this back for a fix" states — the applicant must
    // be able to edit and resubmit, or "request more docs" is a dead end with no way out.
    const reopenedForEdit = rec.status === 'MORE_DOCS' || rec.status === 'HOLD';
    if (rec.agreedTerms && rec.currentStep >= 8 && !reopenedForEdit) {
      throw new BadRequestException('Registration already submitted');
    }

    // Sanitize: strip status/id/trust fields from client payload. agreedTerms/agreedAt are
    // the legal-consent flags — only submit() may set them. invitedByAgencyId is an
    // agency-membership grant and must only come from inviteAgencyMember() (an authenticated
    // agency owner's own action) — never from the applicant's own self-served draft, or any
    // applicant could link themselves into an arbitrary agency by guessing/copying its id.
    // userId is set only by _activatePartner() once an application is actually approved.
    const { id, status, createdAt, updatedAt, registrationId: _rid, userId, agreedTerms, agreedAt, invitedByAgencyId, ...safe } = data;

    for (const field of DOCUMENT_FIELDS) {
      const value = safe[field];
      if (value && value !== '[uploaded]') validateDocumentDataUrl(field, value);
    }

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
    // agreedTerms itself is never persisted via saveStep (stripped there — see its comment);
    // calling submit() is the only way to set it, so reaching this line is the consent. The
    // other three are ordinary step-8 fields saveStep does persist, so they're checked as-is.
    if (!rec.agreedBackground || !rec.agreedCommission || !rec.agreedStandards) {
      throw new BadRequestException('All agreements must be accepted');
    }

    // GPS is mandatory, not optional — DispatchService can never find this partner without a
    // real location, and a location outside India is rejected outright (a cheap, meaningful
    // fraud/spoofing check on top of that).
    if (rec.latitude == null || rec.longitude == null) {
      throw new BadRequestException('Location is required — please allow GPS access to complete registration.');
    }
    if (!isWithinIndiaBounds(rec.latitude, rec.longitude)) {
      throw new BadRequestException('Registration is only available for locations within India.');
    }

    // This is the one server-side proof that OTP was actually verified (see auth.module.ts's
    // verifyOtp — real or DEV_OTP_OVERRIDE, both set isVerified:true the same way) — every
    // endpoint up to this point (init/save-step) is @Public() with no such check, so without
    // this a client could POST straight to /submit and create an application for a phone
    // number nobody ever proved they controlled.
    const verifiedUser = await this.prisma.user.findUnique({ where: { phone: rec.phone } });
    if (!verifiedUser || !verifiedUser.isVerified) {
      throw new BadRequestException('Phone number is not verified — please verify OTP before submitting.');
    }

    await this.prisma.partnerRegistration.update({
      where: { registrationId },
      // A MORE_DOCS/HOLD applicant resubmitting after fixing what admin flagged goes back to
      // PENDING for a fresh review — same transition a first-time submission makes.
      data: { status: 'PENDING', currentStep: 8, agreedTerms: true, agreedAt: new Date() },
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

  // Full edit of an applicant's submitted details — e.g. correcting a mistyped phone/category
  // before approving, without forcing the applicant to redo the whole form. Deliberately
  // separate from adminUpdateStatus(): editing data never itself changes status/approval, an
  // admin still takes that as its own explicit action.
  async adminUpdateDetails(id: string, data: Record<string, any>) {
    const rec = await this.prisma.partnerRegistration.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('Registration not found');

    // Same trust-boundary sanitization as saveStep() — an admin edits applicant-submitted
    // data, never these system-owned fields directly through this endpoint.
    const { id: _id, status, createdAt, updatedAt, registrationId, userId, agreedTerms, agreedAt, invitedByAgencyId, ...safe } = data;

    for (const field of DOCUMENT_FIELDS) {
      const value = safe[field];
      if (value && value !== '[uploaded]') validateDocumentDataUrl(field, value);
    }

    return this.prisma.partnerRegistration.update({ where: { id }, data: safe });
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

    // Agency-invited member rejected — approval's own 'member.approved' emit happens
    // inside _activatePartner() once the ServiceVendor row actually exists.
    if (status === 'REJECTED' && reg.invitedByAgencyId) {
      const owner = await this.prisma.serviceVendor.findUnique({ where: { id: reg.invitedByAgencyId }, select: { userId: true } });
      if (owner) this.events.emit('member.rejected', { agencyOwnerUserId: owner.userId, memberName: reg.fullName || 'Applicant' });
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
        // Never downgrade an existing ADMIN/SUPER_ADMIN (or any non-CUSTOMER role) just
        // because a partner-registration application with their phone number got approved —
        // this previously force-set role: SERVICE_VENDOR unconditionally, which could silently
        // lock an admin out of their own panel if the same phone was ever used to submit one.
        const newRole = user.role === UserRole.CUSTOMER ? UserRole.SERVICE_VENDOR : user.role;
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            role: newRole,
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
      // Normalize onto real ServiceCategory.key values — see normalizeSkillKey() for why.
      const skills = (reg.categories || []).map(normalizeSkillKey);
      // Phase 2 — set when an agency owner invited this person: activation links the new
      // ServiceVendor to the agency instead of leaving it an unaffiliated individual.
      const agencyFields = reg.invitedByAgencyId
        ? { agencyOwnerId: reg.invitedByAgencyId, memberStatus: 'ACTIVE' as const }
        : {};
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
          // Was captured during onboarding but never copied onto the live ServiceVendor
          // profile — photoUrl stayed null (only saved as a VendorDocument below) and
          // experienceYears was unreachable outside the pre-approval registration record.
          photoUrl:         reg.profilePhotoUrl || null,
          experienceYears:  reg.experienceYears || null,
          ...agencyFields,
        },
        update: {
          fullName: reg.fullName || 'Partner',
          baseCity: reg.city    || '',
          skills,
          status:   'ACTIVE',
          ...(reg.latitude  ? { currentLatitude:  reg.latitude  } : {}),
          ...(reg.longitude ? { currentLongitude: reg.longitude } : {}),
          ...(reg.profilePhotoUrl ? { photoUrl: reg.profilePhotoUrl } : {}),
          ...(reg.experienceYears ? { experienceYears: reg.experienceYears } : {}),
          ...agencyFields,
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

      if (reg.invitedByAgencyId && sv) {
        const owner = await this.prisma.serviceVendor.findUnique({ where: { id: reg.invitedByAgencyId }, select: { userId: true } });
        if (owner) this.events.emit('member.approved', { agencyOwnerUserId: owner.userId, memberName: reg.fullName || 'New member', vendorId: sv.id });
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

  @Patch(':id')
  updateDetails(@Param('id') id: string, @Body() body: Record<string, any>) {
    return this.svc.adminUpdateDetails(id, body);
  }
}

// ─── Module ───────────────────────────────────────────────────────────────────

@Module({
  controllers: [PartnerRegistrationController, AdminPartnerRegistrationController],
  providers:   [PartnerRegistrationService],
  exports:     [PartnerRegistrationService],
})
export class PartnerRegistrationModule {}
