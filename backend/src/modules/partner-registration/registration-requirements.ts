// What a partner application must contain before it can be submitted, and before an admin may
// approve it. These are exactly the items partner-register.html marks mandatory (*) — kept in
// one place so submit(), admin approval and the admin checklist can never disagree.

/** Documents the KYC step requires, plus the optional ones an admin may still review. */
export const REGISTRATION_DOCUMENTS = [
  { key: 'idProofFront', label: 'ID proof (front)', required: true },
  { key: 'profilePhotoUrl', label: 'Profile photo', required: true },
  { key: 'idProofBack', label: 'ID proof (back)', required: false },
  { key: 'panCardUrl', label: 'PAN card', required: false },
  { key: 'skillCertificateUrl', label: 'Skill certificate', required: false },
  { key: 'policeVerificationUrl', label: 'Police verification', required: false },
  { key: 'cancelledChequeUrl', label: 'Cancelled cheque', required: false },
] as const;
export type RegistrationDocumentKey = (typeof REGISTRATION_DOCUMENTS)[number]['key'];
export const REGISTRATION_DOCUMENT_KEYS = REGISTRATION_DOCUMENTS.map((d) => d.key) as readonly string[];

const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^\d{6,18}$/;
const MOBILE = /^(?:\+?91)?[6-9]\d{9}$/;

/** Mandatory non-document details, step by step as the form asks for them. */
const REQUIRED_FIELDS: Array<{ key: string; label: string; ok: (r: any) => boolean }> = [
  { key: 'fullName', label: 'Full name', ok: (r) => nonEmpty(r.fullName) },
  { key: 'gender', label: 'Gender', ok: (r) => nonEmpty(r.gender) },
  { key: 'dateOfBirth', label: 'Date of birth', ok: (r) => nonEmpty(r.dateOfBirth) && !isNaN(Date.parse(r.dateOfBirth)) },
  { key: 'city', label: 'City', ok: (r) => nonEmpty(r.city) },
  { key: 'categories', label: 'At least one service category', ok: (r) => Array.isArray(r.categories) && r.categories.some(nonEmpty) },
  { key: 'experienceYears', label: 'Experience', ok: (r) => nonEmpty(r.experienceYears) },
  { key: 'idProofType', label: 'ID proof type', ok: (r) => nonEmpty(r.idProofType) },
  { key: 'bankAccountName', label: 'Bank account holder name', ok: (r) => nonEmpty(r.bankAccountName) },
  { key: 'bankAccountNumber', label: 'Valid bank account number', ok: (r) => ACCOUNT.test(String(r.bankAccountNumber || '').trim()) },
  { key: 'bankIfsc', label: 'Valid IFSC code', ok: (r) => IFSC.test(String(r.bankIfsc || '').trim().toUpperCase()) },
  { key: 'emergencyName', label: 'Emergency contact name', ok: (r) => nonEmpty(r.emergencyName) },
  { key: 'emergencyRelation', label: 'Emergency contact relation', ok: (r) => nonEmpty(r.emergencyRelation) },
  { key: 'emergencyPhone', label: 'Valid emergency contact number', ok: (r) => MOBILE.test(String(r.emergencyPhone || '').replace(/[\s-]/g, '')) },
  { key: 'location', label: 'GPS location', ok: (r) => r.latitude != null && r.longitude != null },
  { key: 'agreements', label: 'All partner agreements', ok: (r) => !!(r.agreedBackground && r.agreedCommission && r.agreedStandards) },
];

/**
 * A stored document counts only if it is an actual file: a data URL of an allowed type (what
 * saveStep stores after assertSafeKycDocument() content-checked and virus-scanned it), or a
 * hosted https URL from an older application. A filename, '[uploaded]' marker or any other
 * client-supplied flag never counts.
 */
export function isStoredDocument(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  return /^data:(image\/(jpeg|jpg|png|webp)|application\/pdf);base64,[A-Za-z0-9+/=]{16,}$/.test(v) || /^https:\/\/\S+$/.test(v);
}

export type DocumentReviewEntry = { status: 'VERIFIED' | 'REJECTED'; reason?: string | null; byUserId: string; byName?: string | null; at: string };
export type DocumentReviewMap = Partial<Record<string, DocumentReviewEntry>>;

export interface RegistrationAssessment {
  /** Every mandatory detail and document is present (what submit() requires). */
  complete: boolean;
  missingFields: string[];
  missingDocuments: string[];
  documents: Array<{ key: string; label: string; required: boolean; uploaded: boolean; review: DocumentReviewEntry | null }>;
  /** Everything an admin approval additionally requires: complete + required documents verified. */
  readyForApproval: boolean;
  approvalBlockers: string[];
}

export function assessRegistration(rec: any): RegistrationAssessment {
  const missingFields = REQUIRED_FIELDS.filter((f) => !f.ok(rec)).map((f) => f.label);
  const review: DocumentReviewMap = (rec?.documentReview && typeof rec.documentReview === 'object') ? rec.documentReview : {};
  const documents = REGISTRATION_DOCUMENTS.map((d) => ({
    key: d.key, label: d.label, required: d.required,
    uploaded: isStoredDocument(rec?.[d.key]),
    review: review[d.key] ?? null,
  }));
  const missingDocuments = documents.filter((d) => d.required && !d.uploaded).map((d) => d.label);
  const complete = !missingFields.length && !missingDocuments.length;

  const approvalBlockers: string[] = [];
  if (!rec?.agreedTerms) approvalBlockers.push('The applicant has not submitted the application');
  for (const f of missingFields) approvalBlockers.push(`Missing: ${f}`);
  for (const d of missingDocuments) approvalBlockers.push(`Missing document: ${d}`);
  for (const d of documents) {
    if (!d.required || !d.uploaded) continue;
    if (d.review?.status === 'REJECTED') approvalBlockers.push(`Rejected document: ${d.label}`);
    else if (d.review?.status !== 'VERIFIED') approvalBlockers.push(`Not yet verified: ${d.label}`);
  }
  return { complete, missingFields, missingDocuments, documents, readyForApproval: approvalBlockers.length === 0, approvalBlockers };
}
