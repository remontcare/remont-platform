/**
 * Shared OpenAI HTTP client — uses Node 18+ fetch, no extra packages.
 * All AI features (chat, descriptions, lead qualification, insights) route through here.
 */

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  // Only present on an assistant message that made tool calls.
  tool_calls?: OpenAiToolCall[];
  // Only present on a 'tool' role message — must match the tool_calls[].id it answers.
  tool_call_id?: string;
  name?: string;
}

export interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Token counts as reported by the provider (null when it didn't send them). */
export interface OpenAiUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }

/** Shared call options: a hard timeout (no hung requests) and a usage callback for cost tracking. */
export interface OpenAiCallControls {
  timeoutMs?: number;
  onUsage?: (usage: OpenAiUsage | null) => void;
}

export interface OpenAiResponseMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
}

async function callChatCompletions(
  apiKey: string,
  model: string,
  messages: OpenAiMessage[],
  options: {
    maxTokens?: number;
    temperature?: number;
    jsonMode?: boolean;
    tools?: OpenAiTool[];
    toolChoice?: 'auto' | 'none';
  } & OpenAiCallControls = {},
): Promise<OpenAiResponseMessage> {
  // 60s default only stops a truly hung call for the other features sharing this client
  // (seller enrichment, admin service details); Remi chat passes its own shorter limit.
  const { maxTokens = 400, temperature = 0.7, jsonMode = false, tools, toolChoice, timeoutMs = 60000, onUsage } = options;

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    // One attempt only, never retried here: a failed or slow call must not turn into
    // repeated paid calls. The caller falls back to the rule-based reply instead.
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    // Status only — the provider's error body is not echoed into logs or responses.
    onUsage?.(null);
    throw new Error(`OpenAI request failed with status ${res.status}`);
  }

  const data: any = await res.json();
  onUsage?.(data?.usage ?? null);
  const message = data.choices?.[0]?.message || { role: 'assistant', content: '' };
  return { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls };
}

/** Plain text completion — unchanged behavior/signature, used by AiToolsService's
 *  content-generation methods (descriptions, SEO, lead qualification, insights). */
export async function openAiComplete(
  apiKey: string,
  model: string,
  messages: OpenAiMessage[],
  options: { maxTokens?: number; temperature?: number; jsonMode?: boolean } & OpenAiCallControls = {},
): Promise<string> {
  const result = await callChatCompletions(apiKey, model, messages, options);
  return (result.content || '').trim();
}

/** Tool-calling completion — returns the full assistant message (content and/or
 *  tool_calls) so the caller can execute tools and continue the conversation. */
export async function openAiChatWithTools(
  apiKey: string,
  model: string,
  messages: OpenAiMessage[],
  tools: OpenAiTool[],
  options: { maxTokens?: number; temperature?: number } & OpenAiCallControls = {},
): Promise<OpenAiResponseMessage> {
  return callChatCompletions(apiKey, model, messages, { ...options, tools, toolChoice: 'auto' });
}

/** Parse JSON safely from an AI response (handles markdown code blocks) */
export function parseAiJson<T>(raw: string): T {
  const cleaned = raw.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned) as T;
}
