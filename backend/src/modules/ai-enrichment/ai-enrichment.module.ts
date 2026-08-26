import {
  Module, Injectable, Controller, Get, Post, Body, UseGuards, BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { UserRole, TransactionReason, AiFeatureType, AiFeatureStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload } from '../../common';
import { WalletService, WalletModule } from '../wallet/wallet.module';
import { openAiComplete, parseAiJson } from '../ai-agent/openai-client';
import { uploadBuffer } from '../uploads/uploads.module';

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

  constructor(private prisma: PrismaService, private config: ConfigService, private wallet: WalletService) {
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
    const debitTx = await this.wallet.debit(userId, total, TransactionReason.AI_FEATURE_CHARGE);

    const result: any = { refunded: [] as AiFeatureType[] };
    for (const { feature, cost } of items) {
      const usage = await this.prisma.aiFeatureUsage.create({
        data: {
          sellerId, productId: body.productId || null, feature,
          costCharged: cost, walletTransactionId: debitTx.id, status: AiFeatureStatus.SUCCESS,
        },
      });
      try {
        let resultJson: any;
        if (feature === 'WEB_SEARCH') resultJson = await this.runWebSearch(body.name, body.category, body.brand);
        else if (feature === 'IMAGE_SEARCH') resultJson = await this.runImageSearch(body.name, body.category, body.brand);
        else resultJson = await this.runImageGeneration(body.name, body.category, body.brand);

        await this.prisma.aiFeatureUsage.update({ where: { id: usage.id }, data: { resultJson } });
        result[feature] = resultJson;
      } catch (e) {
        this.logger.warn(`AI feature ${feature} failed for seller ${sellerId}: ${e.message}`);
        await this.wallet.credit(userId, cost, TransactionReason.REFUND, undefined, `AI feature ${feature} failed — auto-refund`);
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

  private async tavilySearch(query: string, includeImages: boolean) {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.tavilyKey, query, search_depth: 'advanced',
        include_images: includeImages, max_results: 5,
      }),
    });
    if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    return res.json();
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

  private async runImageGeneration(name: string, category?: string, brand?: string) {
    if (!this.openaiKey) throw new Error('OPENAI_API_KEY not configured');
    const prompt = `Professional e-commerce product photograph of ${[brand, name].filter(Boolean).join(' ')}${category ? ` (${category})` : ''}, clean white background, studio lighting, multiple angle mockup, high detail. Illustrative — not a photo of the seller's actual unit.`;
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.openaiKey}` },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 2, size: '1024x1024' }),
    });
    if (!res.ok) throw new Error(`OpenAI image generation ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    const data: any = await res.json();
    const b64Images: string[] = (data.data || []).map((d: any) => d.b64_json).filter(Boolean);
    if (!b64Images.length) throw new Error('Image generation returned no results');

    const uploaded = await Promise.all(b64Images.map(async (b64) => {
      const result = await uploadBuffer(Buffer.from(b64, 'base64'), 'image');
      return result.secure_url;
    }));
    return { images: uploaded };
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
  imports: [WalletModule],
  controllers: [AiEnrichmentController],
  providers: [AiEnrichmentService],
  exports: [AiEnrichmentService],
})
export class AiEnrichmentModule {}
