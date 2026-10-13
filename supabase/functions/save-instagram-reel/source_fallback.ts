// 캡션 분석에서 Gemini가 재시도와 예비 키로도 실패하면 OpenAI로 한 번 더 묻는다.
// 폴백 조건과 로그 이벤트는 v10의 ai/fallback.ts와 같다.
import {
  AiProviderError,
  AiProvidersExhaustedError,
  isFallbackEligible,
} from "./ai/errors.ts";
import type { AiLog } from "./ai/provider.ts";
import type { SourcePlaceHint } from "./source_analysis.ts";

export interface SourceCaptionAnalyzer {
  readonly name: "gemini" | "openai";
  extractCaption(caption: string): Promise<SourcePlaceHint[]>;
}

export function createSourceCaptionFallback(
  primary: SourceCaptionAnalyzer,
  fallback: SourceCaptionAnalyzer | null,
  log?: AiLog,
): (caption: string) => Promise<SourcePlaceHint[]> {
  const operation = "SOURCE_CAPTION_ANALYSIS";
  return async (caption) => {
    let primaryError: AiProviderError;
    try {
      return await primary.extractCaption(caption);
    } catch (error) {
      if (!(error instanceof AiProviderError)) throw error;
      if (!fallback || !isFallbackEligible(error)) {
        log?.("ai_providers_exhausted", { operation, attemptCount: 1 });
        throw error;
      }
      primaryError = error;
    }

    log?.("ai_provider_fallback_started", {
      operation,
      fromProvider: primary.name,
      toProvider: fallback.name,
      failureKind: primaryError.kind,
    });
    try {
      const hints = await fallback.extractCaption(caption);
      log?.("ai_provider_fallback_completed", {
        operation,
        provider: fallback.name,
        resultCount: hints.length,
      });
      return hints;
    } catch (fallbackError) {
      if (!(fallbackError instanceof AiProviderError)) throw fallbackError;
      log?.("ai_providers_exhausted", { operation, attemptCount: 2 });
      throw new AiProvidersExhaustedError([primaryError, fallbackError]);
    }
  };
}
