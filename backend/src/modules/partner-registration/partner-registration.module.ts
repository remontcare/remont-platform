import {
  Module, Injectable, Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, BadRequestException, NotFoundException, ForbiddenException, ConflictException,
  InternalServerErrorException, Logger,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ApiTags } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, normalizeSkillKey, logAudit } from '../../common';
import { assessRegistration, REGISTRATION_DOCUMENTS, REGISTRATION_DOCUMENT_KEYS, type DocumentReviewMap } from './registration-requirements';
import { samePhone } from '../../common/phone';
import { recordPolicyAcceptances } from '../legal/legal.module';
import { Prisma, UserRole } from '@prisma/client';
import { assertSafeKycDocument, UPLOADED_PLACEHOLDER } from '../uploads/kyc-document';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// The id is the only key the public draft-save endpoints take, so it must not be guessable —
// the old 4-digit Math.random suffix gave only 9000 ids per day.
function generateRegistrationId(): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = randomBytes(5).toString('hex').toUpperCase();
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
// The shared KYC check (uploads/kyc-document.ts) is the gate: real signature must match the
// declared type, 5MB cap, images must decode, and a fail-closed ClamAV scan — the same
// pipeline partner/seller KYC uploads use everywhere else.
const DOCUMENT_FIELDS = [
  'idProofFront', 'idProofBack', 'panCardUrl', 'profilePhotoUrl',
  'skillCertificateUrl', 'policeVerificationUrl', 'cancelledChequeUrl',
] as const;

async function validateDocumentFields(data: Record<string, any>): Promise<void> {
  for (const field of DOCUMENT_FIELDS) {
    const value = data[field];
    if (value && value !== UPLOADED_PLACEHOLDER) await assertSafeKycDocument(field, value);
  }
}

/** An admin's review of a document no longer applies once that document is replaced/removed. */
function reviewAfterDocumentChanges(current: unknown, changed: Record<string, any>): DocumentReviewMap | undefined {
  const review: DocumentReviewMap = current && typeof current === 'object' ? { ...(current as DocumentReviewMap) } : {};
  let touched = false;
  for (const key of DOCUMENT_FIELDS) {
    if (key in changed && review[key]) { delete review[key]; touched = true; }
  }
  return touched ? review : undefined;
}

const PARTNER_REG_AUDIT_TARGET = 'PartnerRegistration';
const STATUS_AUDIT_ACTION: Record<string, string> = {
  APPROVED: 'PARTNER_REGISTRATION_APPROVED',
  REJECTED: 'PARTNER_REGISTRATION_REJECTED',
  MORE_DOCS: 'PARTNER_REGISTRATION_RETURNED_FOR_CORRECTION',
  HOLD: 'PARTNER_REGISTRATION_ON_HOLD',
  PENDING: 'PARTNER_REGISTRATION_SET_PENDING',
};

// ─── Service ──────────────────────────────────────────────────────────────────

/** Whoever is acting on a registration — the JWT payload of the logged-in applicant. */
type RegistrationActor = Pick<JwtPayload, 'phone'> | null | undefined;

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

    // Admin sent a submitted application back (MORE_DOCS/HOLD) — resume that same record so the
    // applicant fixes and resubmits it (saveStep() allows edits in exactly these states), rather
    // than falling through to a fresh empty draft that orphans the one under review.
    if (existing && existing.agreedTerms && (existing.status === 'MORE_DOCS' || existing.status === 'HOLD')) {
      return { registrationId: existing.registrationId, isNew: false, reopened: true, status: existing.status, adminNotes: existing.adminNotes };
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

  /**
   * Loads a registration only if it belongs to `actor` — the phone in the caller's OTP-issued
   * JWT. Not-found and not-yours are deliberately the same error, so a registration id (or a
   * phone number that init() resolved to one) reveals nothing about anyone else's application.
   */
  private async findOwned(registrationId: string, actor: RegistrationActor) {
    if (typeof registrationId !== 'string') throw new BadRequestException('registrationId is required');
    const rec = await this.prisma.partnerRegistration.findUnique({ where: { registrationId } });
    if (!rec || !samePhone(actor?.phone, rec.phone)) throw new NotFoundException('Registration not found');
    return rec;
  }

  /** Save step data (autosave) — accepts any partial step payload */
  async saveStep(registrationId: string, step: number, data: Record<string, any>, actor: RegistrationActor) {
    const rec = await this.findOwned(registrationId, actor);
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
    // documentReview/adminNotes are the admin's KYC verdicts — an applicant must never be able
    // to write (e.g. self-verify) them.
    const { id, status, createdAt, updatedAt, registrationId: _rid, userId, agreedTerms, agreedAt, invitedByAgencyId, documentReview: _dr, adminNotes: _an, ...safe } = data;

    // '[uploaded]' is what getDraft() shows for a document already on file (a resumed
    // MORE_DOCS/HOLD application) — it means "keep the stored one", never a value to write.
    for (const field of DOCUMENT_FIELDS) {
      if (safe[field] === UPLOADED_PLACEHOLDER) delete safe[field];
    }

    await validateDocumentFields(safe);

    // A replaced document must be re-verified by admin — drop its previous review.
    const review = reviewAfterDocumentChanges(rec.documentReview, safe);

    await this.prisma.partnerRegistration.update({
      where: { registrationId },
      data: { ...safe, ...(review ? { documentReview: review as any } : {}), currentStep: Math.max(rec.currentStep, step) },
    });

    return { saved: true, step };
  }

  /** Final submit — validate required fields and mark as submitted */
  async submit(registrationId: string, actor: RegistrationActor) {
    const rec = await this.findOwned(registrationId, actor);
    if (rec.agreedTerms && rec.status !== 'MORE_DOCS' && rec.status !== 'HOLD') {
      throw new BadRequestException('Registration already submitted');
    }
    if (!rec.phone) throw new BadRequestException('Phone number is required');

    // GPS is mandatory, not optional — DispatchService can never find this partner without a
    // real location, and a location outside India is rejected outright (a cheap, meaningful
    // fraud/spoofing check on top of that).
    if (rec.latitude == null || rec.longitude == null) {
      throw new BadRequestException('Location is required — please allow GPS access to complete registration.');
    }
    if (!isWithinIndiaBounds(rec.latitude, rec.longitude)) {
      throw new BadRequestException('Registration is only available for locations within India.');
    }

    // Every mandatory detail and document (the form's * items — registration-requirements.ts)
    // is enforced here, so calling this API directly with a half-filled draft can never put
    // an incomplete application into the admin queue: it stays an unsubmitted draft.
    // agreedTerms itself is never persisted via saveStep (stripped there — see its comment);
    // calling submit() is the only way to set it, so reaching the end of this is the consent.
    const assessment = assessRegistration(rec);
    if (!assessment.complete) {
      const missing = [...assessment.missingFields, ...assessment.missingDocuments];
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `Your application is incomplete. Please provide: ${missing.join(', ')}.`,
        missingFields: assessment.missingFields,
        missingDocuments: assessment.missingDocuments,
      });
    }

    // This is the one server-side proof that OTP was actually verified (see auth.module.ts's
    // verifyOtp — real or DEV_OTP_OVERRIDE, both set isVerified:true the same way). The JWT
    // guard on /submit already implies a verified user, but this stays as defense in depth so
    // no caller can ever create an application for a phone nobody proved they controlled.
    const verifiedUser = await this.prisma.user.findUnique({ where: { phone: rec.phone } });
    if (!verifiedUser || !verifiedUser.isVerified) {
      throw new BadRequestException('Phone number is not verified — please verify OTP before submitting.');
    }

    const wasSubmitted = rec.agreedTerms;
    const fromStatus = wasSubmitted ? rec.status : 'DRAFT';
    await this.prisma.partnerRegistration.update({
      where: { registrationId },
      // A MORE_DOCS/HOLD applicant resubmitting after fixing what admin flagged goes back to
      // PENDING for a fresh review — same transition a first-time submission makes.
      data: { status: 'PENDING', currentStep: 8, agreedTerms: true, agreedAt: new Date() },
    });
    await logAudit(this.prisma, {
      actorId: verifiedUser.id, actorRole: verifiedUser.role,
      action: wasSubmitted ? 'PARTNER_REGISTRATION_RESUBMITTED' : 'PARTNER_REGISTRATION_SUBMITTED',
      targetType: PARTNER_REG_AUDIT_TARGET, targetId: rec.id,
      metadata: { registrationId, fromStatus, toStatus: 'PENDING' },
    }).catch((e) => this.logger.warn(`audit log failed for ${registrationId}: ${e?.message}`));

    // Record exactly which published policy versions this submission accepted (no-op for
    // policies not yet published in Legal & Policies; never throws).
    await recordPolicyAcceptances(this.prisma, {
      policySlugs: ['terms-and-conditions', 'privacy-policy', 'partner-policy'],
      subjectType: 'PARTNER_REGISTRATION', subjectId: registrationId, userId: verifiedUser.id,
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
  async getDraft(registrationId: string, actor: JwtPayload) {
    const rec = await this.prisma.partnerRegistration.findUnique({ where: { registrationId } });
    // Owner only; not-found and not-yours are indistinguishable.
    if (!rec || !samePhone(actor?.phone, rec.phone)) throw new NotFoundException('Registration not found');
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
    // Only submitted applications. A draft is created (status defaults to PENDING) as soon as
    // the applicant verifies their phone; agreedTerms is set only by submit().
    const where: any = { agreedTerms: true };
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
    // The full record plus the approval checklist and the complete decision history.
    return { ...rec, assessment: assessRegistration(rec), decisionHistory: await this.decisionHistory([rec.id]) };
  }

  /** Every audited action on these applications, oldest first, with who did it. Append-only. */
  async decisionHistory(registrationRowIds: string[]) {
    if (!registrationRowIds.length) return [];
    const rows = await this.prisma.auditLog.findMany({
      where: { targetType: PARTNER_REG_AUDIT_TARGET, targetId: { in: registrationRowIds } },
      include: { actor: { select: { id: true, name: true, email: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id, action: r.action, at: r.createdAt, actorRole: r.actorRole,
      actor: r.actor ? { id: r.actor.id, name: r.actor.name, email: r.actor.email, phone: r.actor.phone } : { id: r.actorId },
      details: r.metadata,
    }));
  }

  /** Who approved this live partner, and every earlier decision on their application(s). */
  async historyForVendor(vendorId: string) {
    const vendor = await this.prisma.serviceVendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
    if (!vendor) throw new NotFoundException('Partner not found');
    const regs = await this.prisma.partnerRegistration.findMany({
      where: { userId: vendor.userId }, select: { id: true, registrationId: true, status: true, createdAt: true }, orderBy: { createdAt: 'asc' },
    });
    const history = await this.decisionHistory(regs.map((r) => r.id));
    const approval = [...history].reverse().find((h) => h.action === STATUS_AUDIT_ACTION.APPROVED) || null;
    return { registrations: regs, approvedBy: approval ? { ...approval.actor, at: approval.at } : null, history };
  }

  /** Server-side snapshot of the acting admin — from their JWT + User row, never the request body. */
  private async adminIdentity(admin: JwtPayload) {
    if (!admin?.sub) throw new ForbiddenException('Admin identity required');
    const u = await this.prisma.user.findUnique({ where: { id: admin.sub }, select: { id: true, name: true, email: true, phone: true, role: true } });
    if (!u || (u.role !== UserRole.ADMIN && u.role !== UserRole.SUPER_ADMIN)) throw new ForbiddenException('Admin identity required');
    return u;
  }

  /** Admin marks one document VERIFIED or REJECTED (rejection needs a reason the applicant can act on). */
  async adminReviewDocument(id: string, documentKey: string, decision: string, reason: string | undefined, admin: JwtPayload) {
    if (!REGISTRATION_DOCUMENT_KEYS.includes(documentKey)) throw new BadRequestException('Unknown document');
    if (decision !== 'VERIFIED' && decision !== 'REJECTED') throw new BadRequestException('decision must be VERIFIED or REJECTED');
    const note = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    if (decision === 'REJECTED' && !note) throw new BadRequestException('Give a reason so the applicant knows what to fix');
    const me = await this.adminIdentity(admin);
    const rec = await this.prisma.partnerRegistration.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('Registration not found');
    if (!rec.agreedTerms) throw new BadRequestException('This application has not been submitted yet');
    if (rec.status === 'APPROVED') throw new BadRequestException('This application is already approved');
    const doc = assessRegistration(rec).documents.find((d) => d.key === documentKey)!;
    if (!doc.uploaded) throw new BadRequestException(`${doc.label} has not been uploaded`);

    const review: DocumentReviewMap = rec.documentReview && typeof rec.documentReview === 'object' ? { ...(rec.documentReview as DocumentReviewMap) } : {};
    const previous = review[documentKey]?.status || null;
    review[documentKey] = { status: decision, reason: note || null, byUserId: me.id, byName: me.name || me.email || me.phone, at: new Date().toISOString() };
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.partnerRegistration.update({ where: { id }, data: { documentReview: review as any } });
      await logAudit(tx, {
        actorId: me.id, actorRole: me.role, action: decision === 'VERIFIED' ? 'PARTNER_DOCUMENT_VERIFIED' : 'PARTNER_DOCUMENT_REJECTED',
        targetType: PARTNER_REG_AUDIT_TARGET, targetId: id,
        metadata: { registrationId: rec.registrationId, document: documentKey, documentLabel: doc.label, fromStatus: previous, toStatus: decision, reason: note || null, adminName: me.name, adminEmail: me.email, adminPhone: me.phone },
      });
      return u;
    });
    return { documentReview: updated.documentReview, assessment: assessRegistration(updated) };
  }

  // Full edit of an applicant's submitted details — e.g. correcting a mistyped phone/category
  // before approving, without forcing the applicant to redo the whole form. Deliberately
  // separate from adminUpdateStatus(): editing data never itself changes status/approval, an
  // admin still takes that as its own explicit action.
  async adminUpdateDetails(id: string, data: Record<string, any>) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BadRequestException('Invalid details');
    const rec = await this.prisma.partnerRegistration.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('Registration not found');

    // Same trust-boundary sanitization as saveStep() — an admin edits applicant-submitted
    // data, never these system-owned fields directly through this endpoint.
    const { id: _id, status, createdAt, updatedAt, registrationId, userId, agreedTerms, agreedAt, invitedByAgencyId, documentReview: _dr, ...safe } = data;

    await validateDocumentFields(safe);

    const review = reviewAfterDocumentChanges(rec.documentReview, safe);
    return this.prisma.partnerRegistration.update({ where: { id }, data: { ...safe, ...(review ? { documentReview: review as any } : {}) } });
  }

  async adminUpdateStatus(id: string, status: string, adminNotes: string | undefined, admin: JwtPayload) {
    const allowed = ['PENDING', 'APPROVED', 'REJECTED', 'HOLD', 'MORE_DOCS'];
    if (!allowed.includes(status)) throw new BadRequestException('Invalid status');
    const notes = typeof adminNotes === 'string' ? adminNotes.trim() : '';
    // Rejecting or returning an application needs a reason — it is what the applicant acts on.
    if ((status === 'REJECTED' || status === 'MORE_DOCS') && !notes) {
      throw new BadRequestException(status === 'REJECTED' ? 'Give a reason for rejecting this application' : 'Say what the applicant must correct or upload');
    }
    // The identity recorded on the decision comes from the authenticated session only.
    const me = await this.adminIdentity(admin);

    const reg = await this.prisma.partnerRegistration.findUnique({ where: { id } });
    if (!reg) throw new NotFoundException('Registration not found');
    const fromStatus = reg.agreedTerms ? reg.status : 'DRAFT'; // captured before any write
    const audit = (client: any, toStatus: string) => logAudit(client, {
      actorId: me.id, actorRole: me.role, action: STATUS_AUDIT_ACTION[toStatus],
      targetType: PARTNER_REG_AUDIT_TARGET, targetId: id,
      metadata: {
        registrationId: reg.registrationId, fromStatus, toStatus,
        reason: notes || null, adminName: me.name, adminEmail: me.email, adminPhone: me.phone,
      },
    });

    // On APPROVED: the status flip and the activation (User role + ServiceVendor + documents)
    // commit together or not at all — previously the status was saved first and activation
    // errors were only logged, leaving an APPROVED application with no vendor behind it.
    if (status === 'APPROVED') {
      // A draft the applicant never submitted is not an application to approve.
      if (!reg.agreedTerms) {
        throw new BadRequestException('This application has not been submitted yet — it can only be approved after the applicant submits it.');
      }
      if (reg.status === 'APPROVED') throw new BadRequestException('This application is already approved');
      // Returned for correction — the applicant must fix and resubmit before it can be approved.
      if (reg.status === 'MORE_DOCS' || reg.status === 'REJECTED') {
        throw new BadRequestException(`This application is ${reg.status === 'MORE_DOCS' ? 'waiting for the applicant to correct and resubmit it' : 'rejected'} — it cannot be approved now.`);
      }
      // Every mandatory detail present and every required document verified by an admin.
      const assessment = assessRegistration(reg);
      if (!assessment.readyForApproval) {
        throw new BadRequestException({
          statusCode: 400, error: 'Bad Request',
          message: `Cannot approve yet: ${assessment.approvalBlockers.join('; ')}.`,
          approvalBlockers: assessment.approvalBlockers,
        });
      }
      await this._assertEmailAvailable(reg);
      let activated: { sv: { id: string } };
      let updated: any;
      try {
        ({ updated, activated } = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.partnerRegistration.update({
            where: { id },
            data: { status, adminNotes: notes || undefined },
          });
          const activated = await this._activatePartner(tx, reg);
          // Inside the same transaction: an approval without its audit record cannot exist.
          await audit(tx, 'APPROVED');
          return { updated, activated };
        }, { timeout: 30000 }));
      } catch (e) {
        this.logger.error(`Failed to activate partner ${reg.registrationId}: ${e.message}`);
        // Lost a race with another account taking the same email between the check and the write.
        if (e?.code === 'P2002') throw this._emailConflict(reg);
        throw new InternalServerErrorException('Partner activation failed — the application was not approved. Please try again.');
      }
      this.logger.log(`✅ Partner activated: ${reg.fullName} (${reg.phone})`);
      if (reg.invitedByAgencyId) {
        const owner = await this.prisma.serviceVendor.findUnique({ where: { id: reg.invitedByAgencyId }, select: { userId: true } });
        if (owner) this.events.emit('member.approved', { agencyOwnerUserId: owner.userId, memberName: reg.fullName || 'New member', vendorId: activated.sv.id });
      }
      return updated;
    }

    // A draft never submitted is not in review — there's nothing to reject, hold or return yet.
    if (!reg.agreedTerms) throw new BadRequestException('This application has not been submitted yet');
    // Taking an APPROVED partner back to review here would leave a live partner account
    // behind — suspensions/blocks are done on the partner record instead.
    if (reg.status === 'APPROVED') throw new BadRequestException('This partner is already approved — manage the live partner account instead');

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.partnerRegistration.update({
        where: { id },
        data: { status, adminNotes: notes || undefined },
      });
      await audit(tx, status);
      return u;
    });

    // Agency-invited member rejected — approval's own 'member.approved' emit happens above,
    // once the activation transaction has committed.
    if (status === 'REJECTED' && reg.invitedByAgencyId) {
      const owner = await this.prisma.serviceVendor.findUnique({ where: { id: reg.invitedByAgencyId }, select: { userId: true } });
      if (owner) this.events.emit('member.rejected', { agencyOwnerUserId: owner.userId, memberName: reg.fullName || 'Applicant' });
    }

    return updated;
  }

  /**
   * User.email is unique. Approval writes the application's email onto the applicant's User, so
   * an email already held by a different account would fail the whole activation — report it to
   * the admin up front, with what to do about it, instead of a raw constraint error.
   */
  private async _assertEmailAvailable(reg: { email?: string | null; phone: string }) {
    if (!reg.email) return;
    const holder = await this.prisma.user.findUnique({ where: { email: reg.email }, select: { phone: true } });
    if (holder && holder.phone !== reg.phone) throw this._emailConflict(reg);
  }

  private _emailConflict(reg: { email?: string | null }) {
    return new ConflictException(
      `Cannot approve: the email ${reg.email} is already used by another account. ` +
      'Edit this application to correct or clear the email, then approve again. Nothing was changed.',
    );
  }

  /**
   * Runs inside adminUpdateStatus()'s approval transaction — every write goes through `tx`, and
   * any failure throws so the transaction (including the APPROVED status) rolls back.
   */
  private async _activatePartner(tx: Prisma.TransactionClient, reg: any) {
    // 1. Find or create the User and set role to SERVICE_VENDOR
    let user = await tx.user.findFirst({ where: { phone: reg.phone } });
    if (!user) {
      user = await tx.user.create({
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
      user = await tx.user.update({
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
    await tx.partnerRegistration.update({
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
    const sv = await tx.serviceVendor.upsert({
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
      select: { id: true },
    });

    // 4. Save key documents to VendorDocument table
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
      if (url && url !== UPLOADED_PLACEHOLDER) {
        // Delete old doc of same type then re-create (avoid duplicate upsert issues)
        await tx.vendorDocument.deleteMany({ where: { vendorId: sv.id, type: docType } });
        await tx.vendorDocument.create({
          data: { vendorId: sv.id, type: docType, url, verified: true },
        });
      }
    }

    return { sv };
  }
}

// ─── Applicant Controller ────────────────────────────────────────────────────────

@ApiTags('Partner Registration')
@Controller('partner-registration')
export class PartnerRegistrationController {
  constructor(private svc: PartnerRegistrationService) {}

  // init/save-step/submit require the OTP-issued JWT (partner-register.html keeps the token
  // /auth/verify-otp returns), the same model as seller registration. The applicant's phone
  // always comes from that token; a phone in the body is accepted only when it matches it.
  @UseGuards(JwtAuthGuard)
  @Post('init')
  init(@CurrentUser() u: JwtPayload, @Body() body: { phone?: string; language?: string }) {
    if (!u?.phone) throw new ForbiddenException('Verify your mobile number first');
    if (body?.phone && (typeof body.phone !== 'string' || !samePhone(body.phone, u.phone))) {
      throw new ForbiddenException('You can only register with your own verified mobile number');
    }
    return this.svc.initRegistration(u.phone, typeof body?.language === 'string' ? body.language : 'EN');
  }

  @UseGuards(JwtAuthGuard)
  @Post('save-step')
  saveStep(@CurrentUser() u: JwtPayload, @Body() body: { registrationId: string; step: number; data: Record<string, any> }) {
    if (!body.registrationId) throw new BadRequestException('registrationId is required');
    return this.svc.saveStep(body.registrationId, body.step || 1, body.data || {}, u);
  }

  @UseGuards(JwtAuthGuard)
  @Post('submit')
  submit(@CurrentUser() u: JwtPayload, @Body() body: { registrationId: string }) {
    if (!body.registrationId) throw new BadRequestException('registrationId is required');
    return this.svc.submit(body.registrationId, u);
  }

  // status/draft expose the registration id, PAN and bank account number, so they answer only
  // for the phone in the caller's OTP-issued JWT — never for a bare phone number or id. No
  // client calls either today (partner-register.html and the app never read them).
  @UseGuards(JwtAuthGuard)
  @Get('status')
  status(@CurrentUser() u: JwtPayload, @Query('phone') phone?: string) {
    if (phone && !samePhone(phone, u?.phone)) throw new ForbiddenException('You can only view the application for your own verified mobile number');
    return this.svc.checkStatus(u.phone);
  }

  @UseGuards(JwtAuthGuard)
  @Get('draft/:registrationId')
  draft(@CurrentUser() u: JwtPayload, @Param('registrationId') id: string) {
    return this.svc.getDraft(id, u);
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

  /** Who approved a live partner and every decision on their application(s). */
  @Get('vendor/:vendorId/history')
  vendorHistory(@Param('vendorId') vendorId: string) {
    return this.svc.historyForVendor(vendorId);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.svc.adminDetail(id);
  }

  // The deciding admin is always the authenticated caller (JWT) — any id/name in the body is ignored.
  @Patch(':id/status')
  updateStatus(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() body: { status: string; adminNotes?: string }) {
    return this.svc.adminUpdateStatus(id, body?.status, body?.adminNotes, u);
  }

  @Patch(':id/documents/:documentKey')
  reviewDocument(
    @CurrentUser() u: JwtPayload, @Param('id') id: string, @Param('documentKey') documentKey: string,
    @Body() body: { decision: string; reason?: string },
  ) {
    return this.svc.adminReviewDocument(id, documentKey, body?.decision, body?.reason, u);
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
