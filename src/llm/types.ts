// The one seam between the gate and a language model.
//
// The gate needs very little from a model: text in, JSON text out. Keeping the interface this
// small is what lets the tests run the whole pipeline with a scripted fake, and what keeps every
// guarantee in code instead of in a provider feature.

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache, when it reports them. */
  cachedInputTokens: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
  /** The model that actually answered. */
  model: string;
}

export interface LlmClient {
  complete(messages: readonly LlmMessage[]): Promise<LlmResult>;
}

/** Thrown when the provider answered but there is nothing usable to parse (refusal, truncation). */
export class LlmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmOutputError";
  }
}

export const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  };
}

/**
 * Pulls the JSON object out of a model reply. Models wrap JSON in code fences or add a sentence
 * before it often enough that refusing those replies would waste a retry on pure formatting.
 * Returns `null` when no object can be parsed.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
