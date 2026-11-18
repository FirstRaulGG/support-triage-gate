// Adapter for providers that expose the OpenAI-style `/chat/completions` endpoint.
//
// Exists so the gate is not tied to one vendor: the guarantees live in code, so swapping the model
// behind them should be a configuration change. This adapter is for NON-Claude models; for Claude
// use `ClaudeClient`, which talks to the native API.

import { LlmOutputError } from "./types.js";
import type { LlmClient, LlmMessage, LlmResult } from "./types.js";

export interface OpenAiCompatibleOptions {
  /** e.g. `https://example-provider.test/v1`. The path `/chat/completions` is appended. */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: unknown }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export class OpenAiCompatibleClient implements LlmClient {
  private readonly options: OpenAiCompatibleOptions;

  constructor(options: OpenAiCompatibleOptions) {
    this.options = options;
  }

  async complete(messages: readonly LlmMessage[]): Promise<LlmResult> {
    const { baseUrl, apiKey, model, timeoutMs = 60_000, fetchImpl = fetch } = this.options;

    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, response_format: { type: "json_object" } }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`LLM provider returned ${response.status}: ${detail.slice(0, 300)}`);
    }

    const json = (await response.json()) as ChatCompletionResponse;
    const choice = json.choices?.[0];
    const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (!text) throw new LlmOutputError("the provider returned an empty reply");
    if (choice?.finish_reason === "length") throw new LlmOutputError("the model's reply was cut off");

    return {
      text,
      model: json.model ?? model,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        cachedInputTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }
}
