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
  } = {},
): Promise<OpenAiResponseMessage> {
  const { maxTokens = 400, temperature = 0.7, jsonMode = false, tools, toolChoice } = options;

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
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI ${res.status}: ${errText}`);
  }

  const data: any = await res.json();
  const message = data.choices?.[0]?.message || { role: 'assistant', content: '' };
  return { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls };
}

/** Plain text completion — unchanged behavior/signature, used by AiToolsService's
 *  content-generation methods (descriptions, SEO, lead qualification, insights). */
export async function openAiComplete(
  apiKey: string,
  model: string,
  messages: OpenAiMessage[],
  options: { maxTokens?: number; temperature?: number; jsonMode?: boolean } = {},
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
  options: { maxTokens?: number; temperature?: number } = {},
): Promise<OpenAiResponseMessage> {
  return callChatCompletions(apiKey, model, messages, { ...options, tools, toolChoice: 'auto' });
}

/** Parse JSON safely from an AI response (handles markdown code blocks) */
export function parseAiJson<T>(raw: string): T {
  const cleaned = raw.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned) as T;
}
