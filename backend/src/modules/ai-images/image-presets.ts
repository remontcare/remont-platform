import { BadRequestException } from '@nestjs/common';
import { MediaEntityType } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════════════════
// REMONT INDIA — AI IMAGE PRESETS
//
// One place that defines the house visual identity for every AI-generated image, so a
// category, a service and a product all look like they came from the same photo shoot.
// A preset owns: prompt template, style options, aspect ratio, generation size, the media
// entity type (which decides the Cloudinary folder via media.policy) and how many images
// one request may produce.
//
// 4:3 is the platform-wide website image standard for admin-generated media, matching the
// product card slot (index.html .pm-slot `aspect-ratio: 4 / 3`). Service / category /
// sub-category images render contained (catIconHtml: object-fit: contain), so they are
// ratio-safe. NOTE: the product detail page (product.html .pd-image) is `aspect-ratio: 1/1`
// with object-fit: cover, so it centre-crops a 4:3 master — keep the product centred with
// margins (the CATALOG/PRODUCT style fragments ask for exactly that).
// ═══════════════════════════════════════════════════════════════════════════

/** Appended to every prompt — the single source of the shared Remont look. */
export const HOUSE_STYLE =
  'Premium professional commercial photography for a modern Indian home-services and e-commerce website. '
  + 'Photorealistic, natural soft lighting, clean uncluttered composition, accurate proportions, sharp focus, high detail, '
  + 'consistent premium catalogue style across the whole website.';

/** The image models exposed by Cloudinary's add-on take no separate negative-prompt
 *  parameter, so quality guards are stated inside the prompt itself. */
export const NEGATIVE_GUARDS =
  'Strictly avoid: any text, lettering, captions, numbers or labels; watermarks; logos or brand marks; '
  + 'deformed people, extra or missing fingers and hands; duplicated, cloned or floating objects; '
  + 'distorted or broken product geometry; wrong product proportions; unrealistic or toy-like tools; '
  + 'cluttered or messy backgrounds; unnecessary people; low-quality, blurry or over-saturated rendering.';

/** Brand honesty — never invent or restyle a real manufacturer's identity. */
export const BRAND_GUARD =
  'If a brand or model name is given, keep the real product identity, shape and major physical characteristics; '
  + 'do not invent brand marks, badges or model names, and do not restyle it into a different product.';

export interface StyleOption { key: string; label: string; fragment: string }

export interface AiImagePreset {
  entity: AiImageEntity;
  label: string;
  /** Media entity type — decides the Cloudinary folder (see media.policy ENTITY_FOLDER). */
  mediaEntityType: MediaEntityType;
  /** Pixel size requested from Cloudinary image generation (image_size.width/height). */
  width: number;
  height: number;
  /** Final stored aspect ratio; the generated image is centre-cropped to it. */
  aspect: { w: number; h: number };
  styles: StyleOption[];
  defaultStyles: string[];
  maxCount: number;
  /** Catalog-style presets cycle these view fragments so multiple images differ meaningfully. */
  views?: StyleOption[];
  subject: (ctx: AiImageContext) => string;
}

export type AiImageEntity = 'CATEGORY' | 'SUBCATEGORY' | 'SERVICE' | 'PRODUCT' | 'CATALOG';

export interface AiImageContext {
  name: string;
  category?: string;
  subCategory?: string;
  brand?: string;
  details?: string;
}

function withContext(ctx: AiImageContext, parts: string[]): string {
  return parts.filter(Boolean).join(' ');
}

const PRODUCT_STYLES: StyleOption[] = [
  { key: 'PREMIUM_PRODUCT', label: 'Premium Product', fragment: 'premium flagship product presentation, immaculate finish' },
  { key: 'WHITE_BACKGROUND', label: 'Clean White Background', fragment: 'isolated on a pure white seamless background with a soft natural contact shadow' },
  { key: 'STUDIO', label: 'Studio Product', fragment: 'professional studio lighting with softboxes, subtle reflections' },
  { key: 'CATALOG', label: 'Catalog', fragment: 'straight-on e-commerce catalogue framing, product centred and fully visible with even margins' },
  { key: 'LIFESTYLE', label: 'Lifestyle', fragment: 'placed in a tasteful modern Indian home setting, shallow depth of field' },
];

const PRODUCT_VIEWS: StyleOption[] = [
  { key: 'MAIN_WHITE', label: 'Main — white background', fragment: 'main hero shot, three-quarter angle on a pure white background' },
  { key: 'FRONT', label: 'Front view', fragment: 'straight front elevation view on a pure white background' },
  { key: 'LIFESTYLE', label: 'Lifestyle', fragment: 'in-use lifestyle shot inside a clean modern Indian home' },
  { key: 'DETAIL', label: 'Detail / close-up', fragment: 'close-up macro detail of the material, finish and controls' },
  { key: 'CATALOG', label: 'Catalog view', fragment: 'catalogue grid view, product centred with generous even margins on white' },
];

const SERVICE_STYLES: StyleOption[] = [
  { key: 'PROFESSIONAL_SERVICE', label: 'Professional Service', fragment: 'a uniformed professional Indian technician carrying out the work with correct, realistic tools' },
  { key: 'HOME_ENVIRONMENT', label: 'Realistic Home Environment', fragment: 'inside a clean, tidy, contemporary Indian home' },
  { key: 'PREMIUM_COMMERCIAL', label: 'Premium Commercial', fragment: 'premium commercial advertising quality, confident and trustworthy mood' },
  { key: 'CLEAN_MINIMAL', label: 'Clean Minimal', fragment: 'minimal uncluttered framing with plenty of clean negative space' },
  { key: 'LIFESTYLE', label: 'Lifestyle', fragment: 'warm natural lifestyle feel, candid working moment' },
];

const CATEGORY_STYLES: StyleOption[] = [
  { key: 'CLEAN_CATEGORY', label: 'Clean Category Visual', fragment: 'a single clear hero subject that instantly reads as this category at small sizes' },
  { key: 'PREMIUM', label: 'Premium', fragment: 'premium editorial quality, refined and aspirational' },
  { key: 'MINIMAL', label: 'Minimal', fragment: 'minimal composition on a clean neutral background with generous negative space' },
  { key: 'PHOTOREALISTIC', label: 'Photorealistic', fragment: 'photorealistic photography, not an illustration or 3D render' },
  { key: 'PRODUCT_COLLECTION', label: 'Product Collection', fragment: 'a neat arranged collection of the relevant equipment and tools' },
];

export const AI_IMAGE_PRESETS: Record<AiImageEntity, AiImagePreset> = {
  CATEGORY: {
    entity: 'CATEGORY',
    label: 'Category',
    mediaEntityType: MediaEntityType.CATEGORY,
    width: 1536,
    height: 1152,
    aspect: { w: 4, h: 3 },
    styles: CATEGORY_STYLES,
    defaultStyles: ['CLEAN_CATEGORY', 'PREMIUM', 'PHOTOREALISTIC'],
    maxCount: 2,
    subject: (c) => withContext(c, [
      `Category visual representing the "${c.name}" home-services category on an Indian home services website.`,
      'It must read clearly and instantly even when displayed small.',
    ]),
  },
  SUBCATEGORY: {
    entity: 'SUBCATEGORY',
    label: 'Sub-category',
    mediaEntityType: MediaEntityType.SUBCATEGORY,
    width: 1536,
    height: 1152,
    aspect: { w: 4, h: 3 },
    styles: CATEGORY_STYLES,
    defaultStyles: ['CLEAN_CATEGORY', 'PREMIUM', 'PHOTOREALISTIC'],
    maxCount: 2,
    subject: (c) => withContext(c, [
      `Sub-category visual representing "${c.name}"${c.category ? ` within the ${c.category} category` : ''} on an Indian home services website.`,
      'It must read clearly and instantly even when displayed small.',
    ]),
  },
  SERVICE: {
    entity: 'SERVICE',
    label: 'Service',
    mediaEntityType: MediaEntityType.SERVICE,
    width: 1536,
    height: 1152,
    aspect: { w: 4, h: 3 },
    styles: SERVICE_STYLES,
    defaultStyles: ['PROFESSIONAL_SERVICE', 'PREMIUM_COMMERCIAL'],
    maxCount: 2,
    subject: (c) => withContext(c, [
      `Service image for "${c.name}"${c.category ? ` (${c.category}${c.subCategory ? ` — ${c.subCategory}` : ''} services)` : ''}.`,
      'Show the service actually being performed, with a realistic Indian residential context.',
    ]),
  },
  PRODUCT: {
    entity: 'PRODUCT',
    label: 'Product',
    mediaEntityType: MediaEntityType.PRODUCT,
    width: 1536,
    height: 1152,
    aspect: { w: 4, h: 3 },
    styles: PRODUCT_STYLES,
    defaultStyles: ['PREMIUM_PRODUCT', 'WHITE_BACKGROUND', 'CATALOG'],
    maxCount: 4,
    subject: (c) => withContext(c, [
      `E-commerce product photograph of ${[c.brand, c.name].filter(Boolean).join(' ')}${c.category ? ` (${c.category})` : ''}.`,
      'The whole product must be visible, undistorted and correctly proportioned.',
    ]),
  },
  CATALOG: {
    entity: 'CATALOG',
    label: 'Product catalog set',
    mediaEntityType: MediaEntityType.PRODUCT,
    width: 1536,
    height: 1152,
    aspect: { w: 4, h: 3 },
    styles: PRODUCT_STYLES,
    defaultStyles: ['PREMIUM_PRODUCT', 'WHITE_BACKGROUND', 'CATALOG'],
    maxCount: 5,
    views: PRODUCT_VIEWS,
    subject: (c) => withContext(c, [
      `E-commerce catalogue photograph of ${[c.brand, c.name].filter(Boolean).join(' ')}${c.category ? ` (${c.category})` : ''}.`,
      'The whole product must be visible, undistorted and correctly proportioned.',
    ]),
  },
};

export function parseAiImageEntity(raw: unknown): AiImageEntity {
  const v = String(raw ?? '').trim().toUpperCase();
  if (!(v in AI_IMAGE_PRESETS)) throw new BadRequestException('Unsupported image type');
  return v as AiImageEntity;
}

/** Unknown style keys are rejected rather than ignored, so a typo never silently produces
 *  an off-brand image. An empty selection falls back to the preset defaults. */
export function resolveStyles(preset: AiImagePreset, raw: unknown): string[] {
  if (raw === undefined || raw === null || (Array.isArray(raw) && !raw.length)) return preset.defaultStyles;
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > preset.styles.length) throw new BadRequestException('Too many styles selected');
  return list.map((s) => {
    const key = String(s).trim().toUpperCase();
    if (!preset.styles.some((o) => o.key === key)) throw new BadRequestException(`Unknown style: ${key}`);
    return key;
  });
}

/** Cap on the admin-written subject (the only text the UI lets them edit). */
export const MAX_CUSTOM_PROMPT_CHARS = 1200;

/** Ceiling for the assembled prompt actually sent to the provider. The Remont rules are
 *  always kept; only the editable half is trimmed to fit. */
export const MAX_FINAL_PROMPT_CHARS = 3000;

/**
 * Builds the final prompt. The house style, negative guards and brand guard are ALWAYS
 * appended — including to an admin's edited prompt — so every image stays within the Remont
 * visual standard no matter who typed what.
 */
export const REFERENCE_GUARD =
  'Recreate the exact product shown in the reference image: preserve its shape, proportions, colour, '
  + 'materials, controls and every major physical characteristic. Only the background, lighting, angle and '
  + 'composition may change — never redesign the product or alter its identity.';

export function buildPrompt(preset: AiImagePreset, styleKeys: string[], ctx: AiImageContext, opts: { customSubject?: string; viewKey?: string; hasReference?: boolean } = {}): string {
  const styleFragments = styleKeys
    .map((k) => preset.styles.find((o) => o.key === k)?.fragment)
    .filter(Boolean);
  const view = opts.viewKey ? preset.views?.find((v) => v.key === opts.viewKey)?.fragment : undefined;
  const details = (ctx.details || '').trim();
  // The admin-controlled half (what the subject/style boxes produce)…
  const editable = [
    describeSubject(preset, ctx, opts.customSubject),
    view ? `Shot: ${view}.` : '',
    styleFragments.length ? `Style: ${styleFragments.join(', ')}.` : '',
    details ? `Additional details: ${details}.` : '',
  ].filter(Boolean).join(' ');
  // …and the Remont rules, always appended server-side and never shown as editable text.
  const rules = [
    HOUSE_STYLE,
    opts.hasReference ? REFERENCE_GUARD : '',
    BRAND_GUARD,
    NEGATIVE_GUARDS,
  ].filter(Boolean).join(' ');

  // Keep the whole thing inside the provider's prompt budget by trimming only the editable
  // half — the quality rules are never dropped.
  const budget = MAX_FINAL_PROMPT_CHARS - rules.length - 1;
  const trimmed = editable.length > budget ? `${editable.slice(0, Math.max(0, budget - 1)).trimEnd()}…` : editable;
  return `${trimmed} ${rules}`.trim();
}

/** The editable sentence only — what the admin sees in the optional "Edit prompt" box.
 *  The Remont style/quality rules are deliberately NOT part of this. */
export function describeSubject(preset: AiImagePreset, ctx: AiImageContext, customSubject?: string): string {
  return (customSubject || '').trim() || preset.subject(ctx);
}

/** The prompt an admin sees pre-filled in the modal (before any edits). */
export function suggestPrompt(entity: AiImageEntity, ctx: AiImageContext, styleKeys?: string[]): string {
  const preset = AI_IMAGE_PRESETS[entity];
  return buildPrompt(preset, resolveStyles(preset, styleKeys), ctx);
}

/** Shape sent to the admin UI so it can render options without duplicating any of this. */
export function presetCatalogue() {
  return Object.values(AI_IMAGE_PRESETS).map((p) => ({
    entity: p.entity,
    label: p.label,
    styles: p.styles.map(({ key, label }) => ({ key, label })),
    defaultStyles: p.defaultStyles,
    views: p.views?.map(({ key, label }) => ({ key, label })),
    maxCount: p.maxCount,
    aspect: `${p.aspect.w}:${p.aspect.h}`,
    size: `${p.width}x${p.height}`,
  }));
}
