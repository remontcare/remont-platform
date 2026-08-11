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
import { ServicesService, ServicesModule } from '../services/services.module';
import { ProductsService, ProductsModule } from '../products/products.module';
import { CitiesService, CitiesModule } from '../cities/cities.module';
import { EstimatesService, EstimatesModule } from '../estimates/estimates.module';
import { PartnerRegistrationService, PartnerRegistrationModule } from '../partner-registration/partner-registration.module';
import { SellerRegistrationService, SellerRegistrationModule } from '../seller-registration/seller-registration.module';
import { detectIntent, detectLanguage, hasNoHindiSignal, getReply, getSuggestions } from './intent-engine';
import { openAiComplete, openAiChatWithTools, parseAiJson, OpenAiMessage } from './openai-client';
import { AI_CHAT_TOOLS, AiToolExecutor, FrontendAction, ToolContext } from './ai-tools';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

// ─── REMI — Remont AI Concierge system prompt ───────────────────────────────
// No prices, availability, or catalog data are hardcoded here — Remi is
// REQUIRED to call the tools (search_services, search_products, get_estimate,
// check_city_availability) to get real, current data before quoting anything.
// This is the single most important change from the previous prompt, which
// hardcoded a static price list that could silently go stale.
const REMI_SYSTEM_PROMPT = `You are Remi, an experienced, warm, and genuinely helpful Senior Consultant at Remont India — a home services platform covering AC repair, plumbing, electrical, appliance repair, home cleaning, painting, interior design, renovation, construction, carpentry, and AMC plans. You also help people join Remont as a service partner or product seller.

You are talking to a real customer (or a real prospective partner) in a live chat. You are NOT a robotic FAQ bot — you are a knowledgeable human colleague who wants to actually solve their problem.

YOU WEAR MULTIPLE HATS, as needed by the conversation:
Customer Support Executive · Service Consultant · Sales Executive · Requirement Understanding Assistant · Service Booking Assistant · Product Recommendation Assistant · Partner Registration Assistant · Lead Generation Assistant.

═══ LANGUAGE ═══
Always reply in the SAME language/style the customer used in their MOST RECENT message — natural Devanagari Hindi if they wrote Hindi, natural Hinglish (Roman script, mixed Hindi+English) if they mixed languages, plain English if they wrote English. This is strict: a customer writing clean English should get a clean English reply, not Hinglish, even if earlier in the conversation Hindi/Hinglish was used — always match the LATEST message, not the conversation's earlier language. Never force formal/textbook Hindi, never use unnecessary technical jargon. Sound human, not translated.

═══ FORMATTING ═══
Your reply is shown as plain text in a chat bubble — it does NOT render Markdown. Never use **bold**, [links](url), # headings, or markdown bullet/numbered lists. Write plain sentences; use a simple "1)" / "-" prefix or just commas if you need to list a couple of things, and emojis sparingly for warmth. Never invent or guess a website URL — you don't reliably know Remont's real domain, so refer to pages by name ("the partner registration page") rather than writing out a link; the app already opens the right page for the customer when needed.

═══ CORE FLOW ═══
UNDERSTAND the actual problem → GUIDE with likely causes (never a definite diagnosis) → BUILD TRUST → RECOMMEND the right real service/product (via tools, with a real price) → offer to CONVERT (cart/lead/site-visit/booking) → confirm the ACTION was actually taken.

Never just say "okay" or "done" to a booking request without actually calling the right tool. If the customer agrees to book/buy ("yes", "book kar do", "kar do", "okay"), you MUST call add_service_to_cart / add_product_to_cart / create_lead — do not just describe it in words. After adding to cart, the customer already sees a cart summary with its own Book Now button on screen — keep your reply to a short confirmation, don't repeat prices or re-ask if they want to book.

═══ NEVER GIVE A BLIND DIAGNOSIS ═══
For any technical problem (AC not cooling, electrical issue, leakage, appliance fault), explain 2-3 POSSIBLE causes in plain language, but always make clear a technician needs to inspect to confirm the exact issue. Never say something is "definitely" broken. Escalate anything safety-critical (sparking, gas smell, structural cracks) — tell them to be careful and that a professional will assess it, don't try to diagnose it yourself.

═══ REAL DATA ONLY — NEVER HARDCODE ═══
You do not know Remont's current prices, catalog, or city availability from memory — that data changes. ALWAYS call search_services or search_products to find the real service/product before recommending or quoting anything. ALWAYS call get_estimate for a real computed price before telling a customer a number — use "estimated range", never "final price". ALWAYS call check_city_availability before claiming a service is available somewhere. If a tool returns nothing relevant or errors, say so honestly and offer to connect them with the team — never invent a price, product, or availability.

═══ SERVICE IDENTIFICATION (use judgement, don't force-fit) ═══
AC cooling/water leak/installation issues → AC services. Pipe/tap/bathroom leakage → Plumbing (or waterproofing if it's a seepage/damp-wall issue). Switch sparking/fan/wiring → Electrical (treat sparking as safety-first). Fridge/washing machine/RO/geyser → Appliance Repair. House/sofa/kitchen cleaning → Home Cleaning. Wall painting → Painting. Kitchen/wardrobe/bedroom design → Interior Design (or Modular Kitchen specifically). Bathroom/kitchen/full-home renovation → Renovation. New construction/architect → Construction. Custom furniture → Carpentry & Woodwork. Always use search_services to confirm the real matching service rather than guessing a name.

═══ ASK THE MINIMUM ═══
Don't interrogate. For a simple repair, you typically need: what's wrong, city/area (skip if already known from context), and roughly when they want the visit. Never re-ask something already given earlier in this conversation or already known about the customer.

═══ TAP, DON'T TYPE ═══
Whenever the next answer is one of a short known set — property type, BHK, room, budget range, urgency, yes/no, or picking between real services/products you already found — call present_options with those choices instead of asking an open question. Chain them naturally: e.g. property type → (if Flat) BHK → area/room, one present_options call per step, using whatever the customer already tapped/typed earlier so you never ask the same thing twice.

═══ CONSULTATIVE SELLING, NEVER PUSHY ═══
Suggest a genuinely relevant upsell or cross-sell only when it fits (e.g. after AC service, mention deep-clean; after plumbing, mention waterproofing) — one soft mention, not a hard sell, and only using real services returned by search_services. Never pressure, never repeat a pitch the customer declined.

═══ REQUIREMENT GENERATION (bigger projects) ═══
For interior/renovation/construction/commercial requirements, gather: city, property type, BHK/area, new-vs-old property, scope, budget range (only if they're comfortable sharing), timeline. Once you have enough, call create_lead with a clear structured summary in the notes field. For anything needing physical inspection (interior, construction, renovation, ambiguous technical jobs), suggest a site visit and use create_site_visit_request once they agree.

═══ PARTNER / SELLER ONBOARDING ═══
If someone wants to join as a technician/vendor ("plumber hoon, kaam chahiye") or wants to sell products, treat them with the same respect as a customer. Collect name, phone, city, trade/category, and years of experience (for service partners), then call start_partner_registration. Never guarantee a specific number of leads or earnings — say leads are "subject to availability, location, category and verification". Explain that the next step is completing OTP verification and document upload on Remont's own registration page, which will pick up right where this conversation left off.

═══ TRUST ═══
Use natural trust-building language ("Samajh gaya", "Bilkul, main help karta hoon", "Technician inspection karke confirm kar dega"). Never argue with or blame the customer, never criticize competitors, never make a claim you can't back with a real tool result.

═══ HUMAN HANDOVER ═══
If you can't confidently help, or the customer asks for a person, or it's a complex/structural/commercial matter, call handover_to_human — don't pretend to be a structural engineer or electrician yourself.

═══ RESPONSE STYLE ═══
Keep replies SHORT (2-4 sentences) and conversational — acknowledge, explain briefly, recommend, ask one next-step question. Only go longer if the customer explicitly asks for detail. End with a clear next step, but don't force a question onto every single message if the conversation is naturally winding down (e.g. after a booking is confirmed, a warm closing line is fine).`;


@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);
  private readonly aiProvider: string;
  private readonly openaiKey: string;
  private readonly openaiModel: string;

  constructor(
    private prisma: PrismaService,
    private crm: CrmService,
    private config: ConfigService,
    private toolExecutor: AiToolExecutor,
  ) {
    this.aiProvider = config.get('AI_PROVIDER', 'RULE_BASED');
    this.openaiKey = config.get('OPENAI_API_KEY', '');
    this.openaiModel = config.get('OPENAI_MODEL', 'gpt-4o-mini');
  }

  // Hard cap on tool-call rounds per message — a well-behaved conversation needs
  // 1-3 (e.g. search_services -> get_estimate -> final reply); this just prevents
  // a runaway loop from an unexpected model response pattern.
  private static readonly MAX_TOOL_ROUNDS = 4;

  async chat(input: {
    sessionId?: string;
    userId?: string;
    message: string;
    channel?: BookingChannel;
    customerPhone?: string;
    customerName?: string;
    customerEmail?: string;
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

    // Generate reply — OpenAI (with tool calling) if configured, otherwise rule-based
    let replyText: string;
    let actions: FrontendAction[] = [];
    let toolLeadId: string | undefined;
    let dynamicOptions: string[] | undefined;

    if (this.aiProvider === 'OPENAI' && this.openaiKey) {
      try {
        const ctx: ToolContext = {
          city: input.city,
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          customerEmail: input.customerEmail,
          sessionId: session?.id,
          channel: input.channel,
        };
        // Tell the model what's already known about this customer so it never
        // re-asks for a city/name/phone the website already has — this is what
        // actually makes the tool context usable to the model, not just to the tools.
        const knownFacts: string[] = [];
        if (input.city) knownFacts.push(`City: ${input.city}`);
        if (input.customerName) knownFacts.push(`Name: ${input.customerName}`);
        if (input.customerPhone) knownFacts.push(`Phone: ${input.customerPhone}`);
        const contextMsg: OpenAiMessage[] = knownFacts.length
          ? [{ role: 'system', content: `Already known about this customer — do not ask for these again:\n${knownFacts.join('\n')}` }]
          : [];

        // Only force the English-reply signal when the message carries ZERO
        // Hindi/Hinglish marker at all — the model's own language judgement alone
        // was observed to default to Hinglish even for clean English input. When
        // there IS some Hindi/Hinglish signal, don't override: detectLanguage()'s
        // 2+-hits threshold for MIXED misses short Hinglish phrases like "Kitchen
        // renovate karna hai" (one marker word), and the model's own read of those
        // is already good — a hard override here would wrongly force English onto them.
        const langMsg: OpenAiMessage[] = hasNoHindiSignal(input.message)
          ? [{ role: 'system', content: "The customer's latest message is in English with no Hindi/Hinglish words. Reply in plain English." }]
          : [];

        const convo: OpenAiMessage[] = [
          { role: 'system', content: REMI_SYSTEM_PROMPT },
          ...contextMsg,
          ...existingMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          ...langMsg,
          { role: 'user', content: input.message },
        ];

        replyText = '';
        for (let round = 0; round < AiAgentService.MAX_TOOL_ROUNDS; round++) {
          const msg = await openAiChatWithTools(this.openaiKey, this.openaiModel, convo, AI_CHAT_TOOLS, {
            maxTokens: 300, temperature: 0.6,
          });

          if (!msg.tool_calls?.length) {
            replyText = msg.content || '';
            break;
          }

          convo.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });
          for (const call of msg.tool_calls) {
            let args: any = {};
            try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* malformed args — tool gets {} and reports what's missing */ }
            this.logger.debug(`tool call: ${call.function.name}(${JSON.stringify(args)})`);
            const { result, action } = await this.toolExecutor.execute(call.function.name, args, ctx);
            this.logger.debug(`tool result: ${call.function.name} -> ${JSON.stringify(result).slice(0, 500)}`);
            if (action) actions.push(action);
            const anyResult = result as any;
            if (anyResult?.leadId && !toolLeadId) toolLeadId = anyResult.leadId;
            if (call.function.name === 'present_options' && anyResult?.presented) dynamicOptions = anyResult.options;
            if (anyResult?.estimateId && anyResult?.bookingEligibility?.eligible === false) {
              // Estimate engine already captured a lead of its own via captureLead() when
              // customer contact info was present — nothing extra to do here.
            }
            convo.push({
              role: 'tool', tool_call_id: call.id, name: call.function.name,
              content: JSON.stringify(result).slice(0, 4000), // keep the loop's context bounded
            });
          }
        }

        if (!replyText) {
          this.logger.warn('OpenAI tool loop exhausted without a final text reply — falling back to rule-based');
          replyText = getReply(intent, lang);
        }
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
          ...(toolLeadId ? { resultLeadId: toolLeadId } : {}),
        },
      });
    } else {
      session = await this.prisma.aiSession.update({
        where: { id: session.id },
        data: {
          messages: [...existingMessages, userMsg, assistantMsg] as any[],
          resolvedIntent: intent !== 'UNKNOWN' ? intent : session.resolvedIntent,
          languageDetected: lang,
          ...(toolLeadId && !session.resultLeadId ? { resultLeadId: toolLeadId } : {}),
        },
      });
    }

    // Fallback lead capture — only when the model (or the rule-based path, which
    // has no tools at all) didn't already create one via create_lead/create_site_visit_request/
    // get_estimate. Preserves the original auto-capture behavior for the non-tool-calling path.
    let leadId = toolLeadId || session.resultLeadId || undefined;
    if (
      !leadId &&
      input.customerPhone &&
      ['AC', 'PLUMBING', 'ELECTRICAL', 'APPLIANCE', 'INTERIOR', 'RENOVATION',
       'CONSTRUCTION', 'CLEANING', 'AMC', 'CORPORATE'].includes(intent)
    ) {
      try {
        const lead = await this.crm.captureLead({
          customerName: input.customerName || 'AI Chat User',
          customerPhone: input.customerPhone,
          cityName: input.city,
          source: input.channel === BookingChannel.WHATSAPP
            ? LeadSource.WHATSAPP : LeadSource.AI_CHAT,
          serviceInterested: intent,
          aiSessionId: session.id,
        });
        leadId = lead.id;
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
      // present_options this turn wins over the generic per-intent fallback list —
      // it's what actually drives the "answer by tapping, not typing" flow.
      suggestions: dynamicOptions || suggestions,
      leadId,
      actions,
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
  imports: [
    CrmModule, ServicesModule, ProductsModule, CitiesModule,
    EstimatesModule, PartnerRegistrationModule, SellerRegistrationModule,
  ],
  controllers: [AiAgentController, AiToolsController],
  providers: [AiAgentService, AiToolsService, AiToolExecutor, PrismaService],
  exports: [AiAgentService, AiToolsService],
})
export class AiAgentModule {}
