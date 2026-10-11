/**
 * REMONT AI CONCIERGE — TOOLS
 *
 * Every tool here is a thin wrapper around an EXISTING service method already
 * used elsewhere in the app — nothing is invented. Where an action can't be
 * completed server-side (cart is client-side localStorage; final booking needs
 * a human-confirmed address/slot; partner KYC needs OTP + document upload),
 * the tool does the part that IS real (creates a draft, resolves a real price,
 * captures a real lead) and returns a `FrontendAction` telling the browser
 * which EXISTING function/page to hand off to.
 *
 * Reused, not duplicated:
 *   search_services            -> ServicesService.search()          (services.module.ts)
 *   search_products             -> ProductsService.list()            (products.module.ts)
 *   check_city_availability    -> CitiesService.getActiveServicesForCity() (cities.module.ts)
 *   get_estimate                 -> EstimatesService.estimate()        (estimates.module.ts, built this session)
 *   create_lead / site visit    -> CrmService.captureLead()           (crm.module.ts) — same public
 *                                   endpoint already used by the AI-chat auto-capture, WhatsApp, web forms
 *   start_partner_registration -> PartnerRegistrationService.initRegistration()+saveStep()
 *                                   or SellerRegistrationService equivalent (unchanged flows)
 *   add_service_to_cart /
 *   add_product_to_cart /
 *   handover_to_human            -> emit a FrontendAction; the browser already has
 *                                   addToCart()/openCart()/wa.me links — no new client code invented,
 *                                   only a small dispatcher added in index.html to call them.
 */
import { Injectable, Logger } from '@nestjs/common';
import { LeadSource } from '@prisma/client';
import { OpenAiTool } from './openai-client';
import { redactForLog } from './ai-redaction';
import { ServicesService } from '../services/services.module';
import { ProductsService } from '../products/products.module';
import { CitiesService } from '../cities/cities.module';
import { CrmService } from '../crm/crm.module';
import { EstimatesService } from '../estimates/estimates.module';
import { PartnerRegistrationService } from '../partner-registration/partner-registration.module';
import { SellerRegistrationService } from '../seller-registration/seller-registration.module';

export interface FrontendAction {
  type:
    | 'ADD_SERVICE_TO_CART'
    | 'ADD_PRODUCT_TO_CART'
    | 'OPEN_CART'
    | 'CONTINUE_PARTNER_REGISTRATION'
    | 'CONTINUE_SELLER_REGISTRATION'
    | 'OPEN_WHATSAPP';
  payload: Record<string, unknown>;
}

export interface ToolContext {
  city?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  sessionId?: string;
  channel?: string;
  /** Tools this caller may use (server-decided from the authenticated role). Unset = none. */
  allowedTools?: readonly string[];
}

// ─── Who may use which chat tool ─────────────────────────────────────────────────────────
// Decided on the server from the verified JWT role (or anonymous), never from the model or the
// request. The model is only offered these tools, and execute() refuses anything else even if
// the model asks for it. Admin AI tools (/ai/tools/*) are a separate, admin-only API and are
// never reachable through chat.
export type AiAudience = 'PUBLIC' | 'CUSTOMER' | 'PARTNER' | 'SELLER' | 'ADMIN';
const SALES_TOOLS = [
  'search_services', 'search_products', 'check_city_availability', 'get_estimate',
  'add_service_to_cart', 'add_product_to_cart', 'create_lead', 'create_site_visit_request',
  'start_partner_registration', 'present_options', 'handover_to_human',
] as const;
export const CHAT_TOOL_ALLOWLIST: Record<AiAudience, readonly string[]> = {
  PUBLIC: SALES_TOOLS,
  CUSTOMER: SALES_TOOLS,
  // Already-registered partners/sellers: no onboarding tool (it would start an application for
  // whatever phone the model supplies); everything else is the same read/lead/handover set.
  PARTNER: SALES_TOOLS.filter((t) => t !== 'start_partner_registration'),
  SELLER: SALES_TOOLS.filter((t) => t !== 'start_partner_registration'),
  ADMIN: SALES_TOOLS.filter((t) => t !== 'start_partner_registration'),
};
export function audienceForRole(role?: string | null): AiAudience {
  switch (role) {
    case 'CUSTOMER': return 'CUSTOMER';
    case 'SERVICE_VENDOR': case 'AGENCY_OWNER': return 'PARTNER';
    case 'PRODUCT_VENDOR': return 'SELLER';
    case 'ADMIN': case 'SUPER_ADMIN': return 'ADMIN';
    default: return 'PUBLIC';
  }
}
export function chatToolsFor(audience: AiAudience): OpenAiTool[] {
  const allowed = new Set(CHAT_TOOL_ALLOWLIST[audience]);
  return AI_CHAT_TOOLS.filter((t) => allowed.has(t.function.name));
}

/** Tool arguments come from the model: bound every string and drop anything that isn't plain data. */
export function sanitizeToolArgs(args: unknown, depth = 0): any {
  if (depth > 3) return undefined;
  if (typeof args === 'string') return args.slice(0, 1000);
  if (typeof args === 'number') return Number.isFinite(args) ? args : undefined;
  if (typeof args === 'boolean' || args === null) return args;
  if (Array.isArray(args)) return args.slice(0, 20).map((v) => sanitizeToolArgs(v, depth + 1));
  if (args && typeof args === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args).slice(0, 30)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = sanitizeToolArgs(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

export interface ToolResult {
  result: unknown;
  action?: FrontendAction;
}

// Remont India's real, existing public contact channels — used site-wide
// (footer, header, every service landing page). Never invent a new number.
export const SUPPORT_WHATSAPP = '919232071064';
export const SUPPORT_PHONE = '+919876543210';

// ─── Tool schemas — sent to OpenAI as `tools`. Descriptions double as the
//     model's only instruction for when/how to call each one. ─────────────
export const AI_CHAT_TOOLS: OpenAiTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_services',
      description:
        "Search Remont India's real service catalog. The match is a literal substring match on the service's real name, so short, plain keyword phrases work best (e.g. 'AC Repair', 'Plumbing', 'Modular Kitchen') — long natural-language phrases like 'AC service and cooling issue' often match nothing even when a relevant service exists. If a query returns no results, call this again with a shorter or different keyword (e.g. just the category word) before telling the customer nothing was found. Returns real services with their real id, name, category, current basePrice, and unit — use this before quoting any price or recommending a specific service, never guess or remember a price.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Search keywords, e.g. 'AC service' or 'plumbing leak'" },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        "Search Remont India's real product catalog by keyword (e.g. 'bathroom mixer', 'AC stabilizer'). Returns real products with id, name, brand, price, and rating.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Product search keywords' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_city_availability',
      description:
        'Check which service categories are actually live/serviceable in a given city right now. Use this before promising a service is available somewhere, and NEVER claim availability without checking.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: "City name, e.g. 'Bhopal'" },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_estimate',
      description:
        "Get a real, backend-computed cost estimate (range + GST + timeline) for a specific service, using Remont's actual pricing engine — not a guess. Requires a real serviceId from search_services first. Use for any 'how much will it cost' question before quoting a number.",
      parameters: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', description: 'Real service id from search_services' },
          city: { type: 'string', description: 'Customer city, if known' },
          sqft: { type: 'number', description: 'Only if the service is priced per square foot and the customer gave an area' },
        },
        required: ['serviceId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_service_to_cart',
      description:
        "Add a specific real service (from search_services) to the customer's cart on the website, after they've clearly agreed (e.g. said 'yes', 'book kar do', 'okay'). Only call this after explicit confirmation, never automatically.",
      parameters: {
        type: 'object',
        properties: {
          serviceId: { type: 'string' },
          name: { type: 'string' },
          price: { type: 'number', description: 'The real basePrice returned by search_services/get_estimate — never invent a number' },
          unit: { type: 'string' },
          categoryKey: { type: 'string' },
        },
        required: ['serviceId', 'name', 'price'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_product_to_cart',
      description: "Add a specific real product (from search_products) to the customer's cart, after explicit confirmation.",
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string' },
          name: { type: 'string' },
          price: { type: 'number' },
          unit: { type: 'string' },
        },
        required: ['productId', 'name', 'price'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_lead',
      description:
        'Save a structured requirement/lead to the CRM so the Remont sales team can follow up — use for bigger requirements (interior, renovation, construction, corporate) once you have at least the name, phone, and what they need. Do not call this more than once per conversation.',
      parameters: {
        type: 'object',
        properties: {
          customerName: { type: 'string' },
          customerPhone: { type: 'string' },
          customerEmail: { type: 'string' },
          city: { type: 'string' },
          serviceInterested: { type: 'string', description: 'Short label, e.g. "2BHK Complete Interior"' },
          notes: { type: 'string', description: 'Structured requirement summary: property type, area, scope, budget range, timeline, etc.' },
        },
        required: ['customerName', 'customerPhone', 'serviceInterested'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_site_visit_request',
      description:
        'Request a physical site visit/inspection for interior, construction, renovation, or a technical job that genuinely needs in-person assessment — only after the customer agrees a site visit makes sense.',
      parameters: {
        type: 'object',
        properties: {
          customerName: { type: 'string' },
          customerPhone: { type: 'string' },
          city: { type: 'string' },
          serviceInterested: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['customerName', 'customerPhone', 'city', 'serviceInterested'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_partner_registration',
      description:
        "Start a vendor/partner or seller registration draft once someone has clearly said they want to join Remont as a service partner or product seller and given their basic details. This only creates the draft — the customer still completes OTP verification, document upload, and agreement to terms on Remont's own registration page, which will resume exactly where this left off.",
      parameters: {
        type: 'object',
        properties: {
          partnerType: { type: 'string', enum: ['SERVICE', 'SELLER'], description: 'SERVICE = technician/vendor partner, SELLER = product seller' },
          fullName: { type: 'string' },
          phone: { type: 'string', description: '10-digit Indian mobile number' },
          city: { type: 'string' },
          category: { type: 'string', description: "Trade/skill for SERVICE (e.g. 'plumber', 'electrician'), or main product category for SELLER" },
          experienceYears: { type: 'string' },
        },
        required: ['partnerType', 'fullName', 'phone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'present_options',
      description:
        "Show the customer clickable buttons for their next answer instead of asking them to type it. Use this whenever the valid answers are a short known set — property type, BHK, room/area, budget range, urgency, yes/no confirmations, choosing between real services or products you already found, etc. Prefer this over a free-text question whenever possible so the customer doesn't have to type. Keep your accompanying text reply short (just the question itself, e.g. 'Property type?') — do not repeat the option list in the text since it's already shown as buttons.",
      parameters: {
        type: 'object',
        properties: {
          options: {
            type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6,
            description: "2-6 short button labels, e.g. ['House','Flat','Commercial'] or ['1 BHK','2 BHK','3 BHK','4 BHK']",
          },
        },
        required: ['options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handover_to_human',
      description:
        "Escalate to a human team member — use when you can't confidently help, the customer explicitly asks for a person, or the issue is a complex/structural/safety matter that genuinely needs an expert rather than chat guidance.",
      parameters: {
        type: 'object',
        properties: {
          customerName: { type: 'string' },
          customerPhone: { type: 'string' },
          reason: { type: 'string', description: 'Brief reason for the handover' },
        },
        required: ['reason'],
      },
    },
  },
];

@Injectable()
export class AiToolExecutor {
  private readonly logger = new Logger(AiToolExecutor.name);

  constructor(
    private servicesSvc: ServicesService,
    private productsSvc: ProductsService,
    private citiesSvc: CitiesService,
    private crm: CrmService,
    private estimatesSvc: EstimatesService,
    private partnerReg: PartnerRegistrationService,
    private sellerReg: SellerRegistrationService,
  ) {}

  async execute(toolName: string, rawArgs: any, ctx: ToolContext): Promise<ToolResult> {
    // Enforced here, not just by what the model is offered: a tool outside the caller's
    // allow-list is refused even if the model (or a prompt-injected message) asks for it.
    if (!ctx.allowedTools?.includes(toolName)) {
      this.logger.warn(`Refused tool "${String(toolName).slice(0, 60)}" — not allowed for this caller`);
      return { result: { error: 'That action is not available here.' } };
    }
    const args = sanitizeToolArgs(rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) || {};
    try {
      switch (toolName) {
        case 'search_services':
          return { result: await this.searchServices(args.query) };
        case 'search_products':
          return { result: await this.searchProducts(args.query, ctx.city) };
        case 'check_city_availability':
          return { result: await this.checkCityAvailability(args.city || ctx.city) };
        case 'get_estimate':
          return { result: await this.getEstimate(args, ctx) };
        case 'add_service_to_cart':
          return this.addServiceToCart(args);
        case 'add_product_to_cart':
          return this.addProductToCart(args);
        case 'create_lead':
          return { result: await this.createLead(args, ctx) };
        case 'create_site_visit_request':
          return { result: await this.createSiteVisit(args, ctx) };
        case 'start_partner_registration':
          return this.startPartnerRegistration(args);
        case 'present_options':
          return this.presentOptions(args);
        case 'handover_to_human':
          return this.handoverToHuman(args, ctx);
        default:
          return { result: { error: `Unknown tool: ${toolName}` } };
      }
    } catch (e) {
      // The detail stays in the server log (redacted); the model only learns that it failed,
      // so internal errors can never be repeated to the visitor.
      this.logger.warn(`Tool "${toolName}" failed: ${redactForLog(e?.message)}`);
      return { result: { error: 'This lookup failed. Apologise and offer to connect the customer with the Remont team.' } };
    }
  }

  private async searchServices(query: string) {
    const rows = await this.servicesSvc.search(query || '');
    return rows.slice(0, 8).map((s: any) => ({
      id: s.id, name: s.name, categoryKey: s.category?.key, categoryName: s.category?.name,
      basePrice: Number(s.basePrice), originalPrice: s.originalPrice ? Number(s.originalPrice) : null,
      unit: s.unit, durationMinutes: s.durationMinutes,
    }));
  }

  private async searchProducts(query: string, city?: string) {
    const rows = await this.productsSvc.list({ q: query, city, limit: 8 });
    return rows.map((p: any) => ({
      id: p.id, name: p.name, brand: p.brand, price: Number(p.price), mrp: p.mrp ? Number(p.mrp) : null,
      unit: p.unit, rating: p.rating, categoryKey: p.category?.key,
    }));
  }

  private async checkCityAvailability(city?: string) {
    if (!city) return { error: 'No city provided' };
    // City.activeServiceKeys is the field the live homepage's own city-availability
    // display actually reads (same table CitiesService.list() serves to the
    // homepage's city modal). The separate CityService join-table method
    // (getActiveServicesForCity) is barely populated for most cities today and
    // would under-report availability — this uses the source that matches what
    // a customer already sees elsewhere on the site.
    const cityRow: any = await this.citiesSvc.getByName(city);
    if (!cityRow) return { city, isKnownCity: false, activeCategoryKeys: [] };
    return { city, isKnownCity: true, activeCategoryKeys: cityRow.activeServiceKeys || [] };
  }

  private async getEstimate(args: any, ctx: ToolContext) {
    return this.estimatesSvc.estimate({
      serviceId: args.serviceId,
      city: args.city || ctx.city,
      sqft: args.sqft,
    });
  }

  private addServiceToCart(args: any): ToolResult {
    const item = {
      id: args.serviceId, name: args.name, price: Number(args.price) || 0,
      type: 'service', unit: args.unit || 'per visit', categoryKey: args.categoryKey || '',
    };
    return {
      result: { added: true, item },
      action: { type: 'ADD_SERVICE_TO_CART', payload: item },
    };
  }

  private addProductToCart(args: any): ToolResult {
    const item = {
      id: args.productId, name: args.name, price: Number(args.price) || 0,
      type: 'product', unit: args.unit || 'piece',
    };
    return {
      result: { added: true, item },
      action: { type: 'ADD_PRODUCT_TO_CART', payload: item },
    };
  }

  private async createLead(args: any, ctx: ToolContext) {
    const lead = await this.crm.captureLead({
      customerName: args.customerName || ctx.customerName || 'AI Chat Customer',
      customerPhone: args.customerPhone || ctx.customerPhone,
      customerEmail: args.customerEmail || ctx.customerEmail,
      cityName: args.city || ctx.city,
      source: LeadSource.AI_CHAT,
      serviceInterested: args.serviceInterested,
      notes: args.notes,
      aiSessionId: ctx.sessionId,
    });
    return { leadId: lead.id, created: true };
  }

  private async createSiteVisit(args: any, ctx: ToolContext) {
    const lead = await this.crm.captureLead({
      customerName: args.customerName || ctx.customerName || 'AI Chat Customer',
      customerPhone: args.customerPhone || ctx.customerPhone,
      cityName: args.city || ctx.city,
      source: LeadSource.AI_CHAT,
      serviceInterested: args.serviceInterested,
      notes: 'Site visit requested. ' + (args.notes || ''),
      aiSessionId: ctx.sessionId,
    });
    return { leadId: lead.id, siteVisitRequested: true };
  }

  private async startPartnerRegistration(args: any): Promise<ToolResult> {
    const phone = String(args.phone || '').replace(/\D/g, '').slice(-10);
    if (phone.length !== 10) return { result: { error: 'A valid 10-digit mobile number is required' } };
    const categories = args.category ? [args.category] : undefined;

    // The chat is unauthenticated, so the phone here is unproven. Prefill only a draft this
    // call just created (nothing of anyone's to overwrite) — never an existing application,
    // which only its OTP-verified owner may edit. The owner reviews/corrects it after OTP.
    // The reply is IDENTICAL whether or not this phone already has an application (no
    // registrationId, no approved/submitted status), so the chat can't be used to probe which
    // numbers are registered. The registration page finds the draft again after OTP.
    if (args.partnerType === 'SELLER') {
      const draft = await this.sellerReg.initRegistration(phone);
      const registrationId = (draft as any).registrationId;
      if (registrationId && (draft as any).isNew === true) {
        await this.sellerReg.saveStep(registrationId, 1, {
          fullName: args.fullName, city: args.city, categories,
        }).catch(() => null);
      }
      return this.registrationHandoff('SELLER', '/seller-register.html', 'CONTINUE_SELLER_REGISTRATION');
    }

    const draft = await this.partnerReg.initRegistration('+91' + phone, 'EN');
    const registrationId = (draft as any).registrationId;
    if (registrationId && (draft as any).isNew === true) {
      await this.partnerReg.saveStep(registrationId, 1, {
        fullName: args.fullName, city: args.city, categories, experienceYears: args.experienceYears,
      }).catch(() => null);
    }
    return this.registrationHandoff('SERVICE', '/partner-register.html', 'CONTINUE_PARTNER_REGISTRATION');
  }

  private registrationHandoff(partnerType: 'SERVICE' | 'SELLER', continueUrl: string, type: string): ToolResult {
    return {
      result: { partnerType, continueUrl, next: 'Open the registration page and verify the mobile number with OTP to continue. Do not say whether an application already exists for this number.' },
      action: { type, payload: { continueUrl } } as FrontendAction,
    };
  }

  // No service call — this is a pure UI signal. AiAgentService.chat() reads
  // the returned options straight out of the tool result and uses them as this
  // turn's clickable suggestion chips (the same chip UI/click-to-send flow the
  // page already has), instead of the generic per-intent fallback list.
  private presentOptions(args: any): ToolResult {
    const options = Array.isArray(args.options) ? args.options.filter((o: any) => typeof o === 'string' && o.trim()).slice(0, 6) : [];
    return { result: { presented: options.length > 0, options } };
  }

  private handoverToHuman(args: any, ctx: ToolContext): ToolResult {
    // Best-effort lead capture for follow-up — never blocks the handover itself.
    if (args.customerPhone || ctx.customerPhone) {
      this.crm.captureLead({
        customerName: args.customerName || ctx.customerName || 'AI Chat Customer',
        customerPhone: args.customerPhone || ctx.customerPhone,
        cityName: ctx.city,
        source: LeadSource.AI_CHAT,
        serviceInterested: 'Human handover',
        notes: args.reason,
        aiSessionId: ctx.sessionId,
      }).catch((e) => this.logger.warn(`handover lead capture failed: ${e.message}`));
    }
    return {
      result: { handedOver: true, whatsapp: SUPPORT_WHATSAPP, phone: SUPPORT_PHONE },
      action: { type: 'OPEN_WHATSAPP', payload: { number: SUPPORT_WHATSAPP, reason: args.reason || '' } },
    };
  }
}
