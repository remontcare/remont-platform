import { Injectable, BadRequestException, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';

// Phase 6 — picks the LOWEST-COST eligible LogisticsProvider for a RETURN/RTO/WARRANTY
// pickup shipment. Deliberately separate from ShipmentProviderAdapter (implemented by
// MockDeliveryProvider) — that interface backs the untouchable OUTBOUND flow only; this is a
// pure cost-comparison step over admin-managed config data (LogisticsProvider rows), reused by
// ReturnsService.initiate()/initiateRto(). The actual shipment simulation still goes through
// the existing MockDeliveryProvider/findNearestDeliveryPartner() unchanged — this only decides
// which provider record gets billed/tracked for the pickup.
const SEED_PROVIDERS = [
  { name: 'Mock Economy', baseCost: 55, etaDays: 5, priority: 30 },
  { name: 'Mock Standard', baseCost: 70, etaDays: 4, priority: 20 },
  { name: 'Mock Express', baseCost: 80, etaDays: 3, priority: 10 },
];

@Injectable()
export class ReverseLogisticsRateEngine implements OnModuleInit {
  private readonly logger = new Logger(ReverseLogisticsRateEngine.name);
  constructor(private prisma: PrismaService) {}

  // Idempotent boot-time seed (same "upsert defaults, never overwrite an admin's later edits"
  // spirit as SUPPORT_SETTING_DEFAULTS/MOCK_SETTING_DEFAULTS elsewhere) so lowest-cost
  // selection has real, comparable options to choose between from day one.
  async onModuleInit(): Promise<void> {
    const existing = await this.prisma.logisticsProvider.count();
    if (existing > 0) return;
    await this.prisma.logisticsProvider.createMany({ data: SEED_PROVIDERS });
    this.logger.log(`Seeded ${SEED_PROVIDERS.length} default logistics providers`);
  }

  // Never defaults to fastest/express — orders by cost first, priority only as a tiebreaker.
  async pickCheapest(opts: { requiresCod?: boolean } = {}) {
    const candidate = await this.prisma.logisticsProvider.findFirst({
      where: { isActive: true, ...(opts.requiresCod ? { supportsCod: true } : {}) },
      orderBy: [{ baseCost: 'asc' }, { priority: 'asc' }],
    });
    if (!candidate) throw new BadRequestException('No active logistics provider available');
    return candidate;
  }
}
