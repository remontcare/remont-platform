// OpenAI image API — used ONLY by the seller product-image generator
// (ai-enrichment.module.ts), which is deliberately left on its original provider and wallet
// flow. Extracted from that module verbatim: same model, request shape and error text.
//
// The ADMIN generator does not use this file: it runs on the Cloudinary Image Generation
// add-on (cloudinary-images.ts) with no OpenAI fallback.

export interface GenerateImagesOptions {
  apiKey: string;
  prompt: string;
  /** gpt-image-1 sizes: 1024x1024 (square), 1536x1024 (landscape), 1024x1536 (portrait). */
  size?: string;
  count?: number;
  model?: string;
  signal?: AbortSignal;
}

/** Returns the generated images as base64 strings (no decoding, no storage — the caller
 *  puts them through the central media pipeline). */
export async function generateImages(opts: GenerateImagesOptions): Promise<string[]> {
  const { apiKey, prompt, size = '1024x1024', count = 1, model = 'gpt-image-1', signal } = opts;
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, n: count, size }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenAI image generation ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const data: any = await res.json();
  const images: string[] = (data.data || []).map((d: any) => d.b64_json).filter(Boolean);
  if (!images.length) throw new Error('Image generation returned no results');
  return images;
}
