import {
  AiContractError,
  CANDIDATE_JUDGMENT_JSON_SCHEMA,
  parseCandidateJudgmentPayload,
  parseJsonPayload,
  parsePlaceExtractionPayload,
  PLACE_EXTRACTION_JSON_SCHEMA,
} from "../contracts.ts";
import { aiHttpError, AiProviderError } from "../errors.ts";
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

export interface OpenAiProviderConfig {
  apiKey: string;
  extractionModel: string;
  judgmentModel: string;
  timeoutMs: number;
}

interface OpenAiProviderDependencies {
  fetch?: typeof fetch;
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
  const raw = record(record(payload)?.usage);
  if (!raw) return undefined;
  const inputTokens = finiteNumber(raw.input_tokens);
  const outputTokens = finiteNumber(raw.output_tokens);
  return inputTokens === undefined && outputTokens === undefined
    ? undefined
    : { inputTokens, outputTokens };
}

function responseText(
  payload: unknown,
): { text: string | null; refused: boolean } {
  const root = record(payload);
  const outputText = root?.output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return { text: outputText, refused: false };
  }

  const output = root?.output;
  if (!Array.isArray(output)) return { text: null, refused: false };
  const chunks: string[] = [];
  let refused = false;
  for (const item of output) {
    const content = record(item)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const raw = record(part);
      if (!raw) continue;
      if (raw.type === "refusal") refused = true;
      if (raw.type === "output_text" && typeof raw.text === "string") {
        chunks.push(raw.text);
      }
    }
  }
  const text = chunks.join("").trim();
  return { text: text || null, refused };
}

export function createOpenAiProvider(
  config: OpenAiProviderConfig,
  dependencies: OpenAiProviderDependencies = {},
): PlaceAiProvider {
  const request = dependencies.fetch ?? fetch;

  async function generate(
    operation: AiOperation,
    model: string,
    prompt: string,
    schemaName: string,
    schema: unknown,
  ): Promise<{ payload: unknown; text: string }> {
    let response: Response;
    let payload: unknown | null;
    try {
      const result = await fetchJsonWithTimeout(
        request,
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: prompt,
            store: false,
            text: {
              format: {
                type: "json_schema",
                name: schemaName,
                strict: true,
                schema,
              },
            },
          }),
        },
        config.timeoutMs,
      );
      response = result.response;
      payload = result.payload;
    } catch (cause) {
      if (cause instanceof AiRequestTimeoutError) {
        throw new AiProviderError("openai", operation, "TIMEOUT", {
          model,
          retryable: true,
          cause,
        });
      }
      if (cause instanceof AiResponseJsonError) {
        throw new AiProviderError(
          "openai",
          operation,
          "INVALID_RESPONSE",
          { model, retryable: true, cause },
        );
      }
      throw new AiProviderError("openai", operation, "NETWORK", {
        model,
        retryable: true,
        cause,
      });
    }

    if (!response.ok) {
      throw aiHttpError("openai", operation, model, response.status);
    }

    const root = record(payload);
    if (root?.status === "failed" || record(root?.error)) {
      throw new AiProviderError("openai", operation, "UPSTREAM", {
        status: response.status,
        model,
        retryable: true,
      });
    }
    if (root?.status === "cancelled") {
      throw new AiProviderError("openai", operation, "CANCELLED", {
        status: response.status,
        model,
        retryable: false,
      });
    }
    if (root?.status === "incomplete") {
      const incompleteReason = record(root.incomplete_details)?.reason;
      const contentFiltered = incompleteReason === "content_filter";
      throw new AiProviderError(
        "openai",
        operation,
        contentFiltered ? "CONTENT_BLOCKED" : "INVALID_RESPONSE",
        {
          status: response.status,
          model,
          retryable: !contentFiltered,
        },
      );
    }

    const result = responseText(payload);
    if (!result.text) {
      throw new AiProviderError(
        "openai",
        operation,
        result.refused ? "CONTENT_BLOCKED" : "INVALID_RESPONSE",
        {
          status: response.status,
          model,
          retryable: !result.refused,
        },
      );
    }
    return { payload, text: result.text };
  }

  return {
    name: "openai",
    async extractPlaces(
      caption: string,
    ): Promise<ProviderCallResult<PlaceGuess[]>> {
      const model = config.extractionModel;
      const response = await generate(
        "PLACE_EXTRACTION",
        model,
        buildPlaceExtractionPrompt(caption),
        "place_extraction",
        PLACE_EXTRACTION_JSON_SCHEMA,
      );
      try {
        return {
          data: parsePlaceExtractionPayload(parseJsonPayload(response.text)),
          model,
          usage: usage(response.payload),
        };
      } catch (cause) {
        if (!(cause instanceof AiContractError)) throw cause;
        throw new AiProviderError(
          "openai",
          "PLACE_EXTRACTION",
          "INVALID_RESPONSE",
          { model, retryable: true, cause },
        );
      }
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
        "kakao_candidate_judgment",
        CANDIDATE_JUDGMENT_JSON_SCHEMA,
      );
      try {
        return {
          data: parseCandidateJudgmentPayload(
            parseJsonPayload(response.text),
            items.map((item) => item.guessIndex),
          ),
          model,
          usage: usage(response.payload),
        };
      } catch (cause) {
        if (!(cause instanceof AiContractError)) throw cause;
        throw new AiProviderError(
          "openai",
          "KAKAO_CANDIDATE_JUDGMENT",
          "INVALID_RESPONSE",
          { model, retryable: true, cause },
        );
      }
    },
  };
}
