import {
  Module, Injectable, Controller, Get, Post, Body, UseGuards, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { UserRole, TransactionReason, AiFeatureType, AiFeatureStatus, MediaEntityType, MediaSource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload } from '../../common';
import { WalletService, WalletModule } from '../wallet/wallet.module';
import { openAiComplete, parseAiJson } from '../ai-agent/openai-client';
import { MediaModule } from '../media/media.module';
import { MediaService } from '../media/media.service';
import { generateImages } from '../ai-images/openai-images';
import { tavilySearch } from '../ai-images/product-search';

// Seller-facing, wallet-gated, optional paid AI features for the Add Product form
// (frontend/seller.html) — see plan doc "Seller-Facing Paid AI Product Enrichment".
// Deliberately separate from the free, admin-only text AI Generate tab
// (AdminService.generateAiContent) and from the free, automatic
// ProductsService.runAiEnhancement() placeholder that already runs on every product save —
// neither of those charges anything or touches AiFeatureUsage.
//
// Pricing is admin-configurable via the existing generic SiteSetting screen
// (frontend/admin/settings.html, group 'ai') — same getSettingNumber-with-defaults idiom
// PartnerLedgerService already uses for wallet_lead_cost_amount etc.
const AI_SETTING_DEFAULTS: Record<string, number> = {
  ai_web_search_cost: 15,
  ai_image_search_cost: 10,
  ai_image_generation_cost: 20,
};

const FEATURE_SETTING_KEY: Record<AiFeatureType, string> = {
  WEB_SEARCH: 'ai_web_search_cost',
  IMAGE_SEARCH: 'ai_image_search_cost',
  IMAGE_GENERATION: 'ai_image_generation_cost',
};

interface ExecuteBody {
  productId?: string;
  name: string;
  category?: string;
  brand?: string;
  imageUrl?: string; // seller's own uploaded photo, used as the source for IMAGE_GENERATION if provided
  features: AiFeatureType[];
}

@Injectable()
export class AiEnrichmentService {
  private readonly logger = new Logger(AiEnrichmentService.name);
  private readonly tavilyKey: string;
  private readonly openaiKey: string;
  private readonly openaiModel: string;

  constructor(private prisma: PrismaService, private config: ConfigService, private wallet: WalletService, private media: MediaService) {
    this.tavilyKey = config.get('TAVILY_API_KEY', '');
    this.openaiKey = config.get('OPENAI_API_KEY', '');
    this.openaiModel = config.get('OPENAI_MODEL', 'gpt-4o-mini');
  }

  private async getSettingNumber(key: string): Promise<number> {
    const row = await this.prisma.siteSetting.findUnique({ where: { key } });
    const parsed = row ? Number(row.value) : NaN;
    return Number.isFinite(parsed) ? parsed : AI_SETTING_DEFAULTS[key];
  }

  private isFeatureAvailable(feature: AiFeatureType): boolean {
    if (feature === 'IMAGE_GENERATION') return !!this.openaiKey;
    return !!this.tavilyKey; // WEB_SEARCH, IMAGE_SEARCH
  }

  async getSellerId(userId: string): Promise<string> {
    const vendor = await this.prisma.productVendor.findUnique({ where: { userId } });
    if (!vendor) throw new ForbiddenException();
    return vendor.id;
  }

  async getPricing() {
    const [webSearchCost, imageSearchCost, imageGenerationCost] = await Promise.all([
      this.getSettingNumber('ai_web_search_cost'),
      this.getSettingNumber('ai_image_search_cost'),
      this.getSettingNumber('ai_image_generation_cost'),
    ]);
    return {
      prices: { WEB_SEARCH: webSearchCost, IMAGE_SEARCH: imageSearchCost, IMAGE_GENERATION: imageGenerationCost },
      available: {
        WEB_SEARCH: this.isFeatureAvailable('WEB_SEARCH'),
        IMAGE_SEARCH: this.isFeatureAvailable('IMAGE_SEARCH'),
        IMAGE_GENERATION: this.isFeatureAvailable('IMAGE_GENERATION'),
      },
    };
  }

  private async costFor(features: AiFeatureType[]): Promise<{ items: { feature: AiFeatureType; cost: number }[]; total: number }> {
    const items = await Promise.all(features.map(async (f) => ({ feature: f, cost: await this.getSettingNumber(FEATURE_SETTING_KEY[f]) })));
    return { items, total: items.reduce((sum, i) => sum + i.cost, 0) };
  }

  async estimate(userId: string, features: AiFeatureType[]) {
    if (!features?.length) throw new BadRequestException('Select at least one feature');
    const unavailable = features.filter((f) => !this.isFeatureAvailable(f));
    if (unavailable.length) throw new BadRequestException(`Feature not available yet: ${unavailable.join(', ')}`);
    const { items, total } = await this.costFor(features);
    const walletBalance = await this.wallet.balance(userId);
    return { items, totalCost: total, walletBalance: Number(walletBalance), balanceAfter: Number(walletBalance) - total };
  }

  // Charges first (WalletService.debit throws + charges nothing if the balance is
  // insufficient — see wallet.module.ts), THEN runs each selected feature. A feature that
  // fails after its own slice of the charge succeeded is auto-refunded (WalletService.credit,
  // reason REFUND) before this returns — synchronous within one request, so a plain
  // try/catch is a sufficient once-only boundary (no webhook race to guard against, unlike
  // the async lead-cost-refund precedent in partner-ledger.module.ts).
  async execute(userId: string, sellerId: string, body: ExecuteBody) {
    const features = body.features || [];
    if (!features.length) throw new BadRequestException('Select at least one feature');
    const unavailable = features.filter((f) => !this.isFeatureAvailable(f));
    if (unavailable.length) throw new BadRequestException(`Feature not available yet: ${unavailable.join(', ')}`);

    const { items, total } = await this.costFor(features);
    // total<=0 (admin has priced every selected feature at ₹0 — e.g. a promotional period,
    // or a not-yet-configured SiteSetting row) means there's nothing to charge. WalletService
    // .debit() rejects a zero/negative amount outright, so skip it rather than crash — the
    // feature still runs, it's just free, with no wallet transaction to point at.
    const debitTx = total > 0 ? await this.wallet.debit(userId, total, TransactionReason.AI_FEATURE_CHARGE) : null;

    const result: any = { refunded: [] as AiFeatureType[] };
    for (const { feature, cost } of items) {
      const usage = await this.prisma.aiFeatureUsage.create({
        data: {
          sellerId, productId: body.productId || null, feature,
          costCharged: cost, walletTransactionId: debitTx ? debitTx.id : null, status: AiFeatureStatus.SUCCESS,
        },
      });
      try {
        let resultJson: any;
        if (feature === 'WEB_SEARCH') resultJson = await this.runWebSearch(body.name, body.category, body.brand);
        else if (feature === 'IMAGE_SEARCH') resultJson = await this.runImageSearch(body.name, body.category, body.brand);
        else resultJson = await this.runImageGeneration(userId, body.name, body.category, body.brand);

        await this.prisma.aiFeatureUsage.update({ where: { id: usage.id }, data: { resultJson } });
        result[feature] = resultJson;
      } catch (e) {
        this.logger.warn(`AI feature ${feature} failed for seller ${sellerId}: ${e.message}`);
        if (cost > 0) await this.wallet.credit(userId, cost, TransactionReason.REFUND, undefined, `AI feature ${feature} failed — auto-refund`);
        await this.prisma.aiFeatureUsage.update({
          where: { id: usage.id },
          data: { status: AiFeatureStatus.REFUNDED, errorMessage: String(e.message || e) },
        });
        result.refunded.push(feature);
      }
    }
    return result;
  }

  // ─── Providers ───────────────────────────────────────────────────────

  // Same Tavily request as before (advanced depth, 5 results); the HTTP call itself now
  // lives in ai-images/product-search.ts so the admin product generator reuses this exact
  // search instead of having its own.
  private async tavilySearch(query: string, includeImages: boolean) {
    return tavilySearch({ apiKey: this.tavilyKey, query, includeImages });
  }

  private async runWebSearch(name: string, category?: string, brand?: string) {
    const query = [name, category, brand, 'specifications brand manufacturer dimensions warranty country of origin'].filter(Boolean).join(' ');
    const search = await this.tavilySearch(query, false);
    const snippets = (search.results || []).slice(0, 5).map((r: any) => `${r.title}: ${r.content}`).join('\n\n');
    if (!snippets) throw new Error('No search results found for this product');

    const prompt = `Based ONLY on the following real web search results, extract accurate product details for "${name}".
If a field genuinely cannot be determined from the search results, use null for that field — never invent a value.

Search results:
${snippets}

Return JSON with: brand, manufacturer, modelNumber, weightKg (number or null), lengthCm (number or null), widthCm (number or null), heightCm (number or null), warranty, countryOfOrigin, material, description (2-3 sentences), specifications (a short object of key facts).`;
    if (!this.openaiKey) throw new Error('OPENAI_API_KEY not configured');
    const raw = await openAiComplete(this.openaiKey, this.openaiModel, [
      { role: 'system', content: 'You extract structured product data strictly from provided search text. Return only valid JSON. Never fabricate values not present in the source text.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 600, jsonMode: true });
    return parseAiJson(raw);
  }

  private async runImageSearch(name: string, category?: string, brand?: string) {
    const query = [brand, name, category, 'product photo'].filter(Boolean).join(' ');
    const search = await this.tavilySearch(query, true);
    const images: string[] = (search.images || []).slice(0, 8);
    if (!images.length) throw new Error('No product images found');
    return { images };
  }

  private async runImageGeneration(userId: string, name: string, category?: string, brand?: string) {
    if (!this.openaiKey) throw new Error('OPENAI_API_KEY not configured');
    const prompt = `Professional e-commerce product photograph of ${[brand, name].filter(Boolean).join(' ')}${category ? ` (${category})` : ''}, clean white background, studio lighting, multiple angle mockup, high detail. Illustrative — not a photo of the seller's actual unit.`;
    // Same request as before (gpt-image-1, 2 images, 1024x1024) — the HTTP call itself now
    // lives in ai-images/openai-images.ts so the admin generator shares one implementation.
    const b64Images = await generateImages({ apiKey: this.openaiKey, prompt, count: 2, size: '1024x1024' });

    // AI-generated images are ordinary media: same central pipeline as a seller upload
    // (signature check, ClamAV, sharp re-encode, Cloudinary under remont/products/generated/,
    // Media row). Filed as unattached PRODUCT media owned by the seller — the link to a product is made
    // (with an ownership check) when the seller saves the product with one of these URLs,
    // never from the client-supplied productId here. A pipeline failure throws, which the
    // caller turns into an automatic refund for this feature — so it is all-or-nothing: if any
    // image fails, the ones already stored are removed rather than left behind unpaid-for.
    const actor = { id: userId, role: UserRole.PRODUCT_VENDOR };
    const settled = await Promise.allSettled(b64Images.map((b64, i) => this.media.ingestImage({
      buffer: Buffer.from(b64, 'base64'),
      originalName: `ai-generated-${i + 1}.png`,
      entityType: MediaEntityType.PRODUCT,
      source: MediaSource.AI_GENERATED,
      actor,
    })));
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    const stored = settled.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<MediaService['ingestImage']>>> => r.status === 'fulfilled').map((r) => r.value);
    if (failed) {
      await Promise.all(stored.map((m) => this.media.remove(m.id, actor).catch(() => undefined)));
      throw failed.reason;
    }
    // The 1200px "full" variant — the same size a seller-uploaded product photo is saved at, so
    // product detail pages get a consistent high-resolution Cloudinary image.
    return { images: stored.map((m) => m.variants?.full ?? m.deliveryUrl), mediaIds: stored.map((m) => m.id) };
  }
}

@ApiTags('AI Enrichment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PRODUCT_VENDOR)
@Controller('products/ai')
export class AiEnrichmentController {
  constructor(private ai: AiEnrichmentService) {}

  @Get('pricing')
  pricing() { return this.ai.getPricing(); }

  @Post('estimate')
  async estimate(@CurrentUser() u: JwtPayload, @Body() b: { features: AiFeatureType[] }) {
    return this.ai.estimate(u.sub, b.features);
  }

  @Post('execute')
  async execute(@CurrentUser() u: JwtPayload, @Body() b: ExecuteBody) {
    const sellerId = await this.ai.getSellerId(u.sub);
    return this.ai.execute(u.sub, sellerId, b);
  }
}

@Module({
  imports: [WalletModule, MediaModule],
  controllers: [AiEnrichmentController],
  providers: [AiEnrichmentService],
  exports: [AiEnrichmentService],
})
export class AiEnrichmentModule {}
