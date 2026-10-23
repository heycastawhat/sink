import type { Config } from "../config";
import { SYSTEM_PROMPT, buildUserText, parseExtraction, type ExtractInput, type Extraction } from "./extract";

export interface Provider {
  readonly enabled: boolean;
  extract(input: ExtractInput): Promise<{ extraction: Extraction; model: string }>;
}

/** Retryable = worth trying again later (rate limits, outages), as opposed to a bad reply. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * OpenAI-compatible chat completions. Covers OpenRouter and Ollama (/v1) with the same code.
 * Walks the model list in order; first model that returns parseable JSON wins.
 */
export class OpenAICompatibleProvider implements Provider {
  constructor(private cfg: Config["ai"]) {}

  get enabled() {
    // OpenRouter needs a key even for free models; Ollama needs none.
    const needsKey = this.cfg.baseUrl.includes("openrouter.ai");
    return this.cfg.models.length > 0 && (!needsKey || !!this.cfg.apiKey);
  }

  async extract(input: ExtractInput) {
    let lastError: ProviderError = new ProviderError("no models configured", false);
    for (const model of this.cfg.models) {
      try {
        const raw = await this.complete(model, input);
        return { extraction: parseExtraction(raw), model };
      } catch (err) {
        lastError =
          err instanceof ProviderError ? err : new ProviderError(`${model}: ${(err as Error).message}`, false);
        console.warn(`[ai] ${model} failed: ${lastError.message}`);
      }
    }
    throw lastError;
  }

  private async complete(model: string, input: ExtractInput): Promise<string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-title": "Sink",
    };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;

    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1200,
        // Thinking models (Qwen 3.x etc.) otherwise burn the whole budget reasoning and return nothing.
        // Extraction doesn't need it, and it's cheaper. OpenRouter-only field.
        ...(this.cfg.baseUrl.includes("openrouter.ai") && { reasoning: { enabled: false } }),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: buildUserText(input) },
              ...(input.imageDataUrl ? [{ type: "image_url", image_url: { url: input.imageDataUrl } }] : []),
            ],
          },
        ],
      }),
    }).catch((err: Error) => {
      throw new ProviderError(`${model}: ${err.message}`, true);
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(`${model}: HTTP ${res.status} ${body}`, retryable);
    }

    const data = (await res.json()) as { choices?: { finish_reason?: string; message?: { content?: string } }[] };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (!content) throw new ProviderError(`${model}: empty reply (finish_reason ${choice?.finish_reason ?? "none"})`, true);
    return content;
  }
}
