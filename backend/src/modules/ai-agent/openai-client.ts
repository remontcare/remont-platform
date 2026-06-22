/**
 * Shared OpenAI HTTP client — uses Node 18+ fetch, no extra packages.
 * All AI features (chat, descriptions, lead qualification, insights) route through here.
 */

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function openAiComplete(
  apiKey: string,
  model: string,
  messages: OpenAiMessage[],
  options: {
    maxTokens?: number;
    temperature?: number;
    jsonMode?: boolean;
  } = {},
): Promise<string> {
  const { maxTokens = 400, temperature = 0.7, jsonMode = false } = options;

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI ${res.status}: ${errText}`);
  }

  const data: any = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

/** Parse JSON safely from an AI response (handles markdown code blocks) */
export function parseAiJson<T>(raw: string): T {
  const cleaned = raw.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned) as T;
}
