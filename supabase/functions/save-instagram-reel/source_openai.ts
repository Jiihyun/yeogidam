// Gemini가 캡션 분석에 끝내 실패했을 때 같은 지시와 스키마로 OpenAI에 묻는다.
// OpenAI API는 영상 파일을 받지 않으므로 영상과 사진 분석은 맡지 않는다.
import { AiConfigError, AiProviderError } from "./ai/errors.ts";
import { requestOpenAiStructuredText } from "./ai/providers/openai.ts";
import type { SourcePlaceHint } from "./source_analysis.ts";
import {
  parseSourcePlaceHints,
  SOURCE_HINTS_SCHEMA,
  sourceCaptionInput,
} from "./source_gemini.ts";
import { SOURCE_CAPTION_INSTRUCTION } from "./source_prompts.ts";

export interface SourceOpenAiConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export function createSourceOpenAiClient(
  config: SourceOpenAiConfig,
  dependencies: { fetch?: typeof fetch } = {},
) {
  if (!config.apiKey.trim() || !config.model.trim()) {
    throw new AiConfigError("OPENAI_API_KEY and OPENAI_MODEL are required");
  }
  const request = dependencies.fetch ?? fetch;
  return {
    name: "openai" as const,
    async extractCaption(caption: string): Promise<SourcePlaceHint[]> {
      const response = await requestOpenAiStructuredText(request, config, {
        operation: "SOURCE_CAPTION_ANALYSIS",
        model: config.model,
        instructions: SOURCE_CAPTION_INSTRUCTION,
        input: sourceCaptionInput(caption),
        schemaName: "source_place_hints",
        schema: SOURCE_HINTS_SCHEMA,
      });
      try {
        return parseSourcePlaceHints(JSON.parse(response.text));
      } catch (cause) {
        throw new AiProviderError(
          "openai",
          "SOURCE_CAPTION_ANALYSIS",
          "INVALID_RESPONSE",
          { model: config.model, retryable: true, cause },
        );
      }
    },
  };
}
