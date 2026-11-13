import { BadRequestException } from '@nestjs/common';
import { sanitizePublicLead } from './crm.module';

describe('sanitizePublicLead (public POST /crm/leads/capture)', () => {
  const base = { customerName: ' Asha ', customerPhone: '9876543210', source: 'WEBSITE' };

  it('keeps only the allowed fields (no status / agent / conversion injection)', () => {
    const out: any = sanitizePublicLead({
      ...base, status: 'CONVERTED', assignedAgentId: 'agent1', convertedOrderId: 'o1',
      customerUserId: 'u1', createdAt: '2020-01-01', unknownField: 'x',
    });
    expect(out.customerName).toBe('Asha');
    for (const k of ['status', 'assignedAgentId', 'convertedOrderId', 'customerUserId', 'createdAt', 'unknownField']) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it('stores utm fields (capped) and appends a clean landing page to notes', () => {
    const out = sanitizePublicLead({
      ...base, notes: 'Budget: 5L', utmSource: 'facebook', utmMedium: 'paid_social',
      utmCampaign: 'x'.repeat(300), landingPage: '/cities/bhopal',
    });
    expect(out.utmSource).toBe('facebook');
    expect(out.utmMedium).toBe('paid_social');
    expect(out.utmCampaign).toHaveLength(100);
    expect(out.notes).toBe('Budget: 5L | Landing page: /cities/bhopal');
  });

  it('drops a landing page that is not a plain path', () => {
    expect(sanitizePublicLead({ ...base, landingPage: 'https://evil.example/x?a=1' }).notes).toBeUndefined();
    expect(sanitizePublicLead({ ...base, landingPage: '/x?phone=98' }).notes).toBeUndefined();
  });

  it('falls back to WEBSITE for an unknown source and keeps valid ones', () => {
    expect(sanitizePublicLead({ ...base, source: 'HACK' }).source).toBe('WEBSITE');
    expect(sanitizePublicLead({ ...base, source: 'WHATSAPP' }).source).toBe('WHATSAPP');
  });

  it('rejects a body without name or phone with 400, and ignores a bad estimate', () => {
    expect(() => sanitizePublicLead({ customerName: 'A' })).toThrow(BadRequestException);
    expect(() => sanitizePublicLead(null)).toThrow(BadRequestException);
    expect(sanitizePublicLead({ ...base, estimatedValue: 'abc' }).estimatedValue).toBeUndefined();
    expect(sanitizePublicLead({ ...base, estimatedValue: 250000 }).estimatedValue).toBe(250000);
  });
});
