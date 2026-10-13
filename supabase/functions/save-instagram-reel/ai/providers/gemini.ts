import {
  AiContractError,
  CANDIDATE_JUDGMENT_JSON_SCHEMA,
  parseCandidateJudgmentPayload,
  parseJsonPayload,
  parsePlaceExtractionPayload,
  PLACE_EXTRACTION_JSON_SCHEMA,
} from "../contracts.ts";
import { AiProviderError } from "../errors.ts";
import {
  createGeminiCredentialPool,
  type GeminiApiKeyStateStore,
  GeminiHttpStatusError,
} from "../gemini_credentials.ts";
import {
  AiRequestTimeoutError,
  AiResponseJsonError,
  fetchJsonWithTimeout,
} from "../http.ts";
import {
  buildCandidateJudgmentPrompt,
  buildPlaceExtractionPrompt,
} from "../prompts.ts";
import type {
  AiLog,
  PlaceAiProvider,
  ProviderCallResult,
  ProviderUsage,
} from "../provider.ts";
import type {
  AiCandidateJudgment,
  AiOperation,
  KakaoCandidateReviewItem,
  PlaceGuess,
} from "../types.ts";

export {
  createGeminiApiKeyStateStore,
  type GeminiApiKeyCooldownState,
  type GeminiApiKeyStateStore,
  type GeminiCredentialRole,
  type GeminiQuotaClassificationReason,
  type GeminiQuotaKind,
  type GeminiQuotaScope,
  type GeminiRetryHintSource,
} from "../gemini_credentials.ts";

export interface GeminiProviderConfig {
  apiKey: string;
  fallbackApiKeys?: readonly string[];
  extractionModel: string;
  judgmentModel: string;
  timeoutMs: number;
}

interface GeminiProviderDependencies {
  fetch?: typeof fetch;
  log?: AiLog;
  now?: () => number;
  state?: GeminiApiKeyStateStore;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function usage(payload: unknown): ProviderUsage | undefined {
  const metadata = record(record(payload)?.usageMetadata);
  if (!metadata) return undefined;
  const inputTokens = finiteNumber(metadata.promptTokenCount);
  const outputTokens = finiteNumber(metadata.candidatesTokenCount);
  return inputTokens === undefined && outputTokens === undefined
    ? undefined
    : { inputTokens, outputTokens };
}

function contentBlocked(payload: unknown): boolean {
  const root = record(payload);
  const promptFeedback = record(root?.promptFeedback);
  if (typeof promptFeedback?.blockReason === "string") return true;
  const candidates = root?.candidates;
  if (!Array.isArray(candidates)) return false;
  return candidates.some((candidate) => {
    const finishReason = record(candidate)?.finishReason;
    return finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT";
  });
}

function responseText(payload: unknown): string | null {
  const candidates = record(payload)?.candidates;
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    const parts = record(record(candidate)?.content)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const text = record(part)?.text;
      if (typeof text === "string" && text.trim()) return text;
    }
  }
  return null;
}

export function createGeminiProvider(
  config: GeminiProviderConfig,
  dependencies: GeminiProviderDependencies = {},
): PlaceAiProvider {
  const request = dependencies.fetch ?? fetch;
  const credentials = createGeminiCredentialPool(
    [config.apiKey, ...(config.fallbackApiKeys ?? [])],
    {
      log: dependencies.log,
      now: dependencies.now,
      state: dependencies.state,
    },
  );

  async function generate<T>(
    operation: AiOperation,
    model: string,
    prompt: string,
    schema: unknown,
    parse: (text: string) => T,
    temperature?: number,
  ): Promise<{ data: T; payload: unknown }> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${
      encodeURIComponent(model)
    }:generateContent`;
    return await credentials.run(operation, model, async (apiKey) => {
      let response: Response;
      let payload: unknown | null;
      try {
        const result = await fetchJsonWithTimeout(
          request,
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                ...(temperature === undefined ? {} : { temperature }),
                responseMimeType: "application/json",
                responseJsonSchema: schema,
              },
            }),
          },
          config.timeoutMs,
        );
        response = result.response;
        payload = result.payload;
        if (!response.ok) {
          throw new GeminiHttpStatusError(
            response,
            payload,
            result.errorBodyStatus,
          );
        }
      } catch (cause) {
        if (cause instanceof GeminiHttpStatusError) throw cause;
        if (cause instanceof AiRequestTimeoutError) {
          throw new AiProviderError("gemini", operation, "TIMEOUT", {
            model,
            retryable: true,
            cause,
          });
        }
        if (cause instanceof AiResponseJsonError) {
          throw new AiProviderError(
            "gemini",
            operation,
            "INVALID_RESPONSE",
            { model, retryable: true, cause },
          );
        }
        throw new AiProviderError("gemini", operation, "NETWORK", {
          model,
          retryable: true,
          cause,
        });
      }

      const text = responseText(payload);
      const blocked = contentBlocked(payload);
      if (!text) {
        throw new AiProviderError(
          "gemini",
          operation,
          blocked ? "CONTENT_BLOCKED" : "INVALID_RESPONSE",
          {
            status: response.status,
            model,
            retryable: !blocked,
          },
        );
      }
      try {
        return { data: parse(text), payload };
      } catch (cause) {
        if (!(cause instanceof AiContractError)) throw cause;
        throw new AiProviderError("gemini", operation, "INVALID_RESPONSE", {
          model,
          retryable: true,
          cause,
        });
      }
    });
  }

  return {
    name: "gemini",
    async extractPlaces(
      caption: string,
    ): Promise<ProviderCallResult<PlaceGuess[]>> {
      const model = config.extractionModel;
      const response = await generate(
        "PLACE_EXTRACTION",
        model,
        buildPlaceExtractionPrompt(caption),
        PLACE_EXTRACTION_JSON_SCHEMA,
        (text) => parsePlaceExtractionPayload(parseJsonPayload(text)),
      );
      return {
        data: response.data,
        model,
        usage: usage(response.payload),
      };
    },
    async judgeKakaoCandidates(
      caption: string,
      items: KakaoCandidateReviewItem[],
    ): Promise<ProviderCallResult<AiCandidateJudgment[]>> {
      const model = config.judgmentModel;
      const response = await generate(
        "KAKAO_CANDIDATE_JUDGMENT",
        model,
        buildCandidateJudgmentPrompt(caption, items),
        CANDIDATE_JUDGMENT_JSON_SCHEMA,
        (text) =>
          parseCandidateJudgmentPayload(
            parseJsonPayload(text),
            items.map((item) => item.guessIndex),
          ),
        0,
      );
      return {
        data: response.data,
        model,
        usage: usage(response.payload),
      };
    },
  };
}
