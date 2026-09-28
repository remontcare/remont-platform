import {
  CanActivate, Controller, ExecutionContext, Get, Injectable, Logger, Module,
  ServiceUnavailableException, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.module';
import { normalizeSkillKey } from '../../common';

/**
 * PARTNER NETWORK — READ-ONLY SUMMARY FOR THE REMONT ONE CRM
 *
 * GET /api/v1/partner-ops/summary
 *
 * The CRM's "Partner Intelligence" screen reads this through the company's own
 * Website & API connection (scope partners.read). It is AGGREGATE ONLY: counts
 * per status, per city and per service category. No names, phones, documents,
 * bank details, addresses or ids ever leave this endpoint.
 *
 * Status definitions reuse the website's own fields (nothing new is stored):
 *   onboarding  PartnerRegistration PENDING | HOLD | MORE_DOCS (not yet approved, and
 *               the phone is not already a vendor) + ServiceVendor PENDING_VERIFICATION
 *   onboarded   ServiceVendor ACTIVE                      (= live + offline)
 *   live        ServiceVendor ACTIVE and isOnline
 *   offline     ServiceVendor ACTIVE and not isOnline
 *   inactive    ServiceVendor SUSPENDED
 * Sellers use the same shape: SellerRegistration PENDING | HOLD | MORE_INFO and
 * ProductVendor (isOpen is the seller's own online toggle).
 * REJECTED applications/vendors are not part of the network and are not counted.
 *
 * Categories are real ServiceCategory keys (vendor skills / registration
 * categories normalised with normalizeSkillKey, like approval does). A partner
 * with several skills is counted once in EACH of its categories, so category
 * rows can add up to more than the overall total. Keys that are not a
 * ServiceCategory (e.g. subcategory keys) are not shown as categories.
 *
 * AUTH: header `x-api-key` must equal env PARTNER_OPS_API_KEY (min 32 chars,
 * constant-time compare). Unset env => every call is refused (fail closed).
 * Read-only: this module never writes.
 */

const KEY_HEADER = 'x-api-key';
const MAX_ROWS = 50_000;                 // safety cap per query; `truncated` reports it
const NOT_SET = 'Not set';

const PENDING_PARTNER_APPLICATION = ['PENDING', 'HOLD', 'MORE_DOCS'];
const PENDING_SELLER_APPLICATION = ['PENDING', 'HOLD', 'MORE_INFO'];
const NETWORK_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED'] as const;

function digest(v: string) {
  return createHash('sha256').update(v, 'utf8').digest();
}

@Injectable()
export class PartnerOpsKeyGuard implements CanActivate {
  private readonly logger = new Logger('PartnerOpsKeyGuard');

  canActivate(context: ExecutionContext): boolean {
    const expected = (process.env.PARTNER_OPS_API_KEY || '').trim();
    if (expected.length < 32) {
      this.logger.error('Partner ops refused: PARTNER_OPS_API_KEY is not configured (min 32 chars)');
      throw new ServiceUnavailableException('Partner data API is not configured');
    }
    const req = context.switchToHttp().getRequest();
    const presented = String(req.headers[KEY_HEADER] || '');
    if (!presented || !timingSafeEqual(digest(presented), digest(expected))) {
      throw new UnauthorizedException('Invalid API key');
    }
    return true;
  }
}

export type NetworkCounts = { onboarding: number; onboarded: number; live: number; offline: number; inactive: number };
type Bucket = 'onboarding' | 'live' | 'offline' | 'inactive';

const zero = (): NetworkCounts => ({ onboarding: 0, onboarded: 0, live: 0, offline: 0, inactive: 0 });

function add(c: NetworkCounts, b: Bucket) {
  c[b] += 1;
  if (b === 'live' || b === 'offline') c.onboarded += 1;
}

/** Last 10 digits — the same person as a registration and as a vendor user. */
function phoneKey(phone?: string | null): string {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

function cityLabel(raw?: string | null): { key: string; label: string } {
  const label = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return label ? { key: label.toLowerCase(), label } : { key: '', label: NOT_SET };
}

class Tally {
  summary = zero();
  private cities = new Map<string, { city: string; counts: NetworkCounts; cats: Map<string, NetworkCounts> }>();
  private cats = new Map<string, NetworkCounts>();

  constructor(private readonly categoryNames: Map<string, string> | null) {}

  add(bucket: Bucket, city: string | null | undefined, categoryKeys: string[] = []) {
    add(this.summary, bucket);
    const c = cityLabel(city);
    let row = this.cities.get(c.key);
    if (!row) { row = { city: c.label, counts: zero(), cats: new Map() }; this.cities.set(c.key, row); }
    add(row.counts, bucket);
    if (!this.categoryNames) return;
    const known = new Set(categoryKeys.map(normalizeSkillKey).filter((k) => this.categoryNames!.has(k)));
    for (const k of known) {
      if (!this.cats.has(k)) this.cats.set(k, zero());
      add(this.cats.get(k)!, bucket);
      if (!row.cats.has(k)) row.cats.set(k, zero());
      add(row.cats.get(k)!, bucket);
    }
  }

  cityRows() {
    return [...this.cities.values()]
      .sort((a, b) => b.counts.onboarded + b.counts.onboarding - (a.counts.onboarded + a.counts.onboarding)
        || a.city.localeCompare(b.city))
      .map((r) => ({
        city: r.city, ...r.counts,
        ...(this.categoryNames ? {
          categories: [...r.cats.entries()].map(([k, v]) => ({ key: k, category: this.categoryNames!.get(k)!, ...v }))
            .sort((a, b) => b.onboarded - a.onboarded || a.category.localeCompare(b.category)),
        } : {}),
      }));
  }

  categoryRows() {
    return [...this.cats.entries()]
      .map(([k, v]) => ({ key: k, category: this.categoryNames!.get(k)!, ...v }))
      .sort((a, b) => b.onboarded - a.onboarded || a.category.localeCompare(b.category));
  }
}

@Injectable()
export class PartnerOpsService {
  constructor(private prisma: PrismaService) {}

  async summary() {
    const p: any = this.prisma;
    const [vendors, applications, categories, sellers, sellerApplications] = await Promise.all([
      p.serviceVendor.findMany({
        where: { status: { in: NETWORK_STATUSES as unknown as string[] } },
        select: { status: true, isOnline: true, baseCity: true, skills: true, user: { select: { phone: true } } },
        take: MAX_ROWS,
      }),
      p.partnerRegistration.findMany({
        where: { status: { in: PENDING_PARTNER_APPLICATION } },
        select: { phone: true, city: true, categories: true },
        take: MAX_ROWS,
      }),
      p.serviceCategory.findMany({ select: { key: true, name: true } }),
      p.productVendor.findMany({
        where: { status: { in: NETWORK_STATUSES as unknown as string[] } },
        select: { status: true, isOpen: true, city: true, user: { select: { phone: true } } },
        take: MAX_ROWS,
      }),
      p.sellerRegistration.findMany({
        where: { status: { in: PENDING_SELLER_APPLICATION } },
        select: { phone: true, city: true },
        take: MAX_ROWS,
      }),
    ]);

    const names = new Map<string, string>(
      (categories as { key: string; name: string }[]).map((c) => [normalizeSkillKey(c.key), c.name]));

    // ── service partners ──
    const partners = new Tally(names);
    const vendorPhones = new Set<string>();
    for (const v of vendors as any[]) {
      const ph = phoneKey(v.user?.phone);
      if (ph) vendorPhones.add(ph);
      const bucket: Bucket = v.status === 'ACTIVE' ? (v.isOnline ? 'live' : 'offline')
        : v.status === 'SUSPENDED' ? 'inactive' : 'onboarding';
      partners.add(bucket, v.baseCity, v.skills || []);
    }
    for (const a of applications as any[]) {
      const ph = phoneKey(a.phone);
      if (ph && vendorPhones.has(ph)) continue;          // already counted as a vendor
      partners.add('onboarding', a.city, a.categories || []);
    }

    // ── product sellers (no service categories) ──
    const sellerTally = new Tally(null);
    const sellerPhones = new Set<string>();
    for (const s of sellers as any[]) {
      const ph = phoneKey(s.user?.phone);
      if (ph) sellerPhones.add(ph);
      const bucket: Bucket = s.status === 'ACTIVE' ? (s.isOpen ? 'live' : 'offline')
        : s.status === 'SUSPENDED' ? 'inactive' : 'onboarding';
      sellerTally.add(bucket, s.city);
    }
    for (const a of sellerApplications as any[]) {
      const ph = phoneKey(a.phone);
      if (ph && sellerPhones.has(ph)) continue;
      sellerTally.add('onboarding', a.city);
    }

    const truncated = [vendors, applications, sellers, sellerApplications].some((rows: any[]) => rows.length >= MAX_ROWS);

    return {
      version: 1,
      generated_at: new Date().toISOString(),
      truncated,
      partners: {
        summary: partners.summary,
        cities: partners.cityRows(),
        categories: partners.categoryRows(),
      },
      sellers: {
        summary: sellerTally.summary,
        cities: sellerTally.cityRows(),
      },
    };
  }
}

@ApiExcludeController()
@UseGuards(PartnerOpsKeyGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller('partner-ops')
export class PartnerOpsController {
  constructor(private svc: PartnerOpsService) {}

  @Get('summary') summary() { return this.svc.summary(); }
}

@Module({
  controllers: [PartnerOpsController],
  providers: [PartnerOpsService, PartnerOpsKeyGuard],
})
export class PartnerOpsModule {}
