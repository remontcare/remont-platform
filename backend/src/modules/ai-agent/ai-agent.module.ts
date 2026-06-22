import {
  Module, Injectable, Controller, Get, Post, Body, Param, Query, UseGuards, NotFoundException, Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { BookingChannel, LeadSource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, Public, CurrentUser, JwtPayload } from '../../common';
import { CrmService, CrmModule } from '../crm/crm.module';
import { detectIntent, detectLanguage, getReply, getSuggestions } from './intent-engine';
import { openAiComplete, parseAiJson, OpenAiMessage } from './openai-client';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

const REMI_SYSTEM_PROMPT = `You are Remi, the friendly AI assistant for Remont India — a premium home services platform covering AC repair, plumbing, electrical, appliance repair, interior design, renovation, construction, deep cleaning, and AMC plans.

Your job:
1. Understand the customer's problem and collect key details: city/area, preferred time slot, problem description.
2. Be warm, confident, and professional.
3. Always respond in the SAME language the customer uses (English, Hindi, or Hinglish).
4. Keep replies under 80 words — concise and action-oriented.
5. After collecting details, confirm you will connect them with the best expert.
6. For pricing queries, mention prices range by city and service, and offer to share exact pricing.
7. For order tracking, ask for their order number (starts with REM-) or registered phone.

Available services: AC Repair/Service, Plumbing, Electrical, Appliance Repair, Interior Design, Home Renovation, Construction, Deep Cleaning, AMC Plans (Home Essentials ₹6,999/yr, Home Complete ₹12,999/yr), Corporate Services.

Always end with a question that moves the conversation forward.`;


@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);
  private readonly aiProvider: string;
  private readonly openaiKey: string;
  private readonly openaiModel: string;

  constructor(private prisma: PrismaService, private crm: CrmService, private config: ConfigService) {
    this.aiProvider = config.get('AI_PROVIDER', 'RULE_BASED');
    this.openaiKey = config.get('OPENAI_API_KEY', '');
    this.openaiModel = config.get('OPENAI_MODEL', 'gpt-4o-mini');
  }

  async chat(input: {
    sessionId?: string;
    userId?: string;
    message: string;
    channel?: BookingChannel;
    customerPhone?: string;
    customerName?: string;
    city?: string;
  }) {
    const lang = detectLanguage(input.message);
    const { intent, confidence } = detectIntent(input.message);
    const suggestions = getSuggestions(intent);

    // Load existing session (single fetch — reused for both context and upsert)
    let session = input.sessionId
      ? await this.prisma.aiSession.findUnique({ where: { id: input.sessionId } })
      : null;

    const existingMessages: ChatMessage[] = session?.messages
      ? (Array.isArray(session.messages) ? (session.messages as unknown as ChatMessage[]) : [])
      : [];

    // Generate reply — OpenAI if configured, otherwise rule-based
    let replyText: string;
    if (this.aiProvider === 'OPENAI' && this.openaiKey) {
      try {
        const msgs: OpenAiMessage[] = [
          { role: 'system', content: REMI_SYSTEM_PROMPT },
          ...existingMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          { role: 'user', content: input.message },
        ];
        replyText = await openAiComplete(this.openaiKey, this.openaiModel, msgs, { maxTokens: 200, temperature: 0.7 });
      } catch (e) {
        this.logger.warn(`OpenAI chat failed, falling back to rule-based: ${e.message}`);
        replyText = getReply(intent, lang);
      }
    } else {
      replyText = getReply(intent, lang);
    }

    // Build new message pair
    const userMsg: ChatMessage = {
      role: 'user', content: input.message, timestamp: new Date().toISOString(),
    };
    const assistantMsg: ChatMessage = {
      role: 'assistant', content: replyText, timestamp: new Date().toISOString(),
    };

    // Upsert session
    if (!session) {
      session = await this.prisma.aiSession.create({
        data: {
          userId: input.userId,
          channel: input.channel || BookingChannel.AI_CHAT,
          messages: [userMsg, assistantMsg] as any[],
          resolvedIntent: intent !== 'UNKNOWN' ? intent : null,
          languageDetected: lang,
        },
      });
    } else {
      session = await this.prisma.aiSession.update({
        where: { id: session.id },
        data: {
          messages: [...existingMessages, userMsg, assistantMsg] as any[],
          resolvedIntent: intent !== 'UNKNOWN' ? intent : session.resolvedIntent,
          languageDetected: lang,
        },
      });
    }

    // Capture lead if customer info present and intent is actionable
    let lead;
    if (
      input.customerPhone &&
      ['AC', 'PLUMBING', 'ELECTRICAL', 'APPLIANCE', 'INTERIOR', 'RENOVATION',
       'CONSTRUCTION', 'CLEANING', 'AMC', 'CORPORATE'].includes(intent) &&
      !session.resultLeadId
    ) {
      try {
        lead = await this.crm.captureLead({
          customerName: input.customerName || 'AI Chat User',
          customerPhone: input.customerPhone,
          cityName: input.city,
          source: input.channel === BookingChannel.WHATSAPP
            ? LeadSource.WHATSAPP : LeadSource.AI_CHAT,
          serviceInterested: intent,
          aiSessionId: session.id,
        });
        await this.prisma.aiSession.update({
          where: { id: session.id },
          data: { resultLeadId: lead.id },
        });
      } catch (e) {
        this.logger.warn(`Lead capture failed: ${e.message}`);
      }
    }

    return {
      sessionId: session.id,
      reply: replyText,
      intent,
      confidence,
      language: lang,
      suggestions,
      leadId: lead?.id,
    };
  }

  async endSession(sessionId: string, convertedOrderId?: string) {
    return this.prisma.aiSession.update({
      where: { id: sessionId },
      data: {
        endedAt: new Date(),
        ...(convertedOrderId
          ? { convertedToBooking: true, resultOrderId: convertedOrderId }
          : {}),
      },
    });
  }

  async mySessions(userId: string) {
    return this.prisma.aiSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  async getSession(sessionId: string) {
    const session = await this.prisma.aiSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException();
    return session;
  }
}

@ApiTags('AI Agent')
@Controller('ai')
export class AiAgentController {
  constructor(private ai: AiAgentService) {}

  @Public() @Post('chat')
  chat(@Body() body: any) { return this.ai.chat(body); }

  @Public() @Post('session/end')
  end(@Body() b: { sessionId: string; orderId?: string }) {
    return this.ai.endSession(b.sessionId, b.orderId);
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Get('sessions/mine')
  mine(@CurrentUser() u: JwtPayload) { return this.ai.mySessions(u.sub); }

  @Public() @Get('sessions/:id')
  one(@Param('id') id: string) { return this.ai.getSession(id); }
}

// ─── AI Tools (descriptions, qualification, insights, recommendations) ───────

@Injectable()
export class AiToolsService {
  private readonly logger = new Logger(AiToolsService.name);
  private readonly enabled: boolean;
  private readonly key: string;
  private readonly model: string;

  constructor(private prisma: PrismaService, private config: ConfigService) {
    this.key = config.get('OPENAI_API_KEY', '');
    this.model = config.get('OPENAI_MODEL', 'gpt-4o-mini');
    this.enabled = config.get('AI_PROVIDER') === 'OPENAI' && !!this.key;
  }

  private async call(msgs: OpenAiMessage[], opts: { maxTokens?: number; jsonMode?: boolean } = {}): Promise<string> {
    if (!this.enabled) throw new Error('AI provider not configured');
    return openAiComplete(this.key, this.model, msgs, { maxTokens: opts.maxTokens || 400, jsonMode: opts.jsonMode });
  }

  // ── Content generation ───────────────────────────────────────────────────

  async generateServiceDescription(name: string, category: string, duration?: number): Promise<{ description: string; shortSummary: string; benefits: string[] }> {
    const prompt = `Generate marketing content for a home service:
Service: ${name}
Category: ${category}
${duration ? `Duration: ${duration} minutes` : ''}

Return JSON with:
- description: 2-3 sentence professional description (60-80 words)
- shortSummary: one catchy line (max 12 words)
- benefits: array of 4 customer benefits (each max 8 words)

Focus on: quality, trust, convenience, certified technicians. Target audience: Indian homeowners.`;

    const raw = await this.call([
      { role: 'system', content: 'You are a marketing copywriter for Remont India home services. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 300, jsonMode: true });
    return parseAiJson(raw);
  }

  async generateProductDescription(name: string, category: string, specs?: string): Promise<{ description: string; shortSummary: string; keyFeatures: string[] }> {
    const prompt = `Generate product listing content for a home product:
Product: ${name}
Category: ${category}
${specs ? `Specs: ${specs}` : ''}

Return JSON with:
- description: 2-3 sentence product description (50-70 words)
- shortSummary: one catchy tagline (max 10 words)
- keyFeatures: array of 4 key features/benefits (each max 8 words)

Target audience: Indian homeowners buying through a home services app.`;

    const raw = await this.call([
      { role: 'system', content: 'You are a product copywriter for Remont India. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 300, jsonMode: true });
    return parseAiJson(raw);
  }

  async generateSeoContent(type: 'service' | 'blog' | 'city-page', subject: string, keywords?: string): Promise<{ metaTitle: string; metaDescription: string; h1: string; suggestedTags: string[] }> {
    const prompt = `Generate SEO metadata for Remont India:
Type: ${type}
Subject: ${subject}
${keywords ? `Target keywords: ${keywords}` : ''}

Return JSON with:
- metaTitle: SEO title (50-60 chars, include main keyword)
- metaDescription: meta description (140-155 chars, compelling, includes CTA)
- h1: page heading (30-50 chars)
- suggestedTags: array of 5-8 relevant tags/keywords

Context: Indian home services platform, cities like Mumbai/Delhi/Bangalore.`;

    const raw = await this.call([
      { role: 'system', content: 'You are an SEO expert for Indian home services websites. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 300, jsonMode: true });
    return parseAiJson(raw);
  }

  // ── Lead qualification ───────────────────────────────────────────────────

  async qualifyLead(lead: { customerName: string; customerPhone: string; notes?: string; serviceInterested?: string; city?: string; budget?: number }): Promise<{ score: number; tier: 'HOT' | 'WARM' | 'COLD'; reason: string; nextAction: string; estimatedValue: number }> {
    const prompt = `Qualify this sales lead for Remont India home services:

Customer: ${lead.customerName}
Phone: ${lead.customerPhone}
City: ${lead.city || 'Unknown'}
Service interested: ${lead.serviceInterested || 'General enquiry'}
Budget indicated: ${lead.budget ? '₹' + lead.budget : 'Not mentioned'}
Notes: ${lead.notes || 'None'}

Return JSON with:
- score: 0-100 qualification score
- tier: "HOT" (>70), "WARM" (40-70), or "COLD" (<40)
- reason: 1-2 sentence explanation of score
- nextAction: specific recommended next step for sales team
- estimatedValue: estimated order value in INR (number only)`;

    const raw = await this.call([
      { role: 'system', content: 'You are a sales qualification AI for Remont India. Analyze leads and return only valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 250, jsonMode: true });
    return parseAiJson(raw);
  }

  // ── Smart recommendations ────────────────────────────────────────────────

  async getServiceRecommendations(orderHistory: string[], city: string, season?: string): Promise<{ recommended: string[]; reason: string; urgencyFlag?: string }> {
    const month = new Date().toLocaleString('en-IN', { month: 'long' });
    const prompt = `Recommend home services for a Remont India customer:

Past services used: ${orderHistory.join(', ') || 'None'}
City: ${city}
Current month: ${season || month}

Available services: AC Repair, Plumbing, Electrical, Appliance Repair, Interior Design, Renovation, Construction, Deep Cleaning, AMC Plan

Return JSON with:
- recommended: array of 2-3 service names (most relevant)
- reason: 1-2 sentences explaining why these are recommended now
- urgencyFlag: optional string if any service is time-sensitive (e.g. "AC servicing before summer")`;

    const raw = await this.call([
      { role: 'system', content: 'You are a home services recommendation engine for Remont India. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 200, jsonMode: true });
    return parseAiJson(raw);
  }

  // ── AI Insights ──────────────────────────────────────────────────────────

  async generateInsightReport(stats: Record<string, any>): Promise<{ summary: string; highlights: string[]; risks: string[]; suggestions: string[] }> {
    const prompt = `Analyze this Remont India platform data and generate business insights:

${JSON.stringify(stats, null, 2)}

Return JSON with:
- summary: 2-3 sentence executive summary of platform health
- highlights: array of 3 positive metrics/trends
- risks: array of 2-3 areas needing attention
- suggestions: array of 3 actionable recommendations to grow revenue

Keep language business-friendly and specific to a home services platform in India.`;

    const raw = await this.call([
      { role: 'system', content: 'You are a business intelligence analyst for Remont India. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 500, jsonMode: true });
    return parseAiJson(raw);
  }

  // ── Auto reply suggestion for vendor ────────────────────────────────────

  async suggestVendorReply(customerMessage: string, context: { service?: string; orderStatus?: string }): Promise<{ reply: string; tone: string }> {
    const prompt = `Suggest a professional reply for a Remont India service vendor:

Customer message: "${customerMessage}"
Service type: ${context.service || 'General'}
Order status: ${context.orderStatus || 'Active'}

Return JSON with:
- reply: professional, friendly reply (max 50 words, in same language as customer message)
- tone: "reassuring" | "informative" | "apologetic" | "confirmatory"`;

    const raw = await this.call([
      { role: 'system', content: 'You are helping Remont India service vendors respond to customers professionally. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 150, jsonMode: true });
    return parseAiJson(raw);
  }
}

@ApiTags('AI Tools')
@Controller('ai/tools')
export class AiToolsController {
  private readonly logger = new Logger(AiToolsController.name);
  constructor(private tools: AiToolsService, private prisma: PrismaService) {}

  @UseGuards(JwtAuthGuard) @ApiBearerAuth()
  @Post('generate/service-description')
  async serviceDesc(@Body() b: { name: string; category: string; duration?: number }) {
    try { return await this.tools.generateServiceDescription(b.name, b.category, b.duration); }
    catch (e) { this.logger.error(`serviceDesc: ${e.message}`); throw new InternalServerErrorException('AI generation failed'); }
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth()
  @Post('generate/product-description')
  async productDesc(@Body() b: { name: string; category: string; specs?: string }) {
    try { return await this.tools.generateProductDescription(b.name, b.category, b.specs); }
    catch (e) { this.logger.error(`productDesc: ${e.message}`); throw new InternalServerErrorException('AI generation failed'); }
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth()
  @Post('generate/seo')
  async seo(@Body() b: { type: 'service' | 'blog' | 'city-page'; subject: string; keywords?: string }) {
    try { return await this.tools.generateSeoContent(b.type, b.subject, b.keywords); }
    catch (e) { this.logger.error(`seo: ${e.message}`); throw new InternalServerErrorException('AI generation failed'); }
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth()
  @Post('qualify-lead')
  async qualify(@Body() b: any) {
    try { return await this.tools.qualifyLead(b); }
    catch (e) { this.logger.error(`qualifyLead: ${e.message}`); throw new InternalServerErrorException('AI generation failed'); }
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth()
  @Post('recommendations')
  async recommend(@Body() b: { orderHistory: string[]; city: string; season?: string }) {
    try { return await this.tools.getServiceRecommendations(b.orderHistory, b.city, b.season); }
    catch (e) { this.logger.error(`recommendations: ${e.message}`); throw new InternalServerErrorException('AI generation failed'); }
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth()
  @Get('insights')
  async insights() {
    try {
      const [orders, vendors, leads, reviews] = await Promise.all([
        this.prisma.order.count(),
        this.prisma.serviceVendor.count(),
        this.prisma.lead.count(),
        this.prisma.review.aggregate({ _avg: { rating: true }, _count: { id: true } }),
      ]);
      return await this.tools.generateInsightReport({ orders, vendors, leads, avgRating: reviews._avg?.rating, reviewCount: reviews._count?.id });
    } catch (e) {
      this.logger.error(`insights: ${e.message}`);
      throw new InternalServerErrorException('AI generation failed');
    }
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth()
  @Post('vendor-reply')
  async vendorReply(@Body() b: { message: string; service?: string; orderStatus?: string }) {
    try { return await this.tools.suggestVendorReply(b.message, { service: b.service, orderStatus: b.orderStatus }); }
    catch (e) { this.logger.error(`vendorReply: ${e.message}`); throw new InternalServerErrorException('AI generation failed'); }
  }
}

@Module({
  imports: [CrmModule],
  controllers: [AiAgentController, AiToolsController],
  providers: [AiAgentService, AiToolsService, PrismaService],
  exports: [AiAgentService, AiToolsService],
})
export class AiAgentModule {}
