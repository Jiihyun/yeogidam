import {
  AiProviderError,
  AiProvidersExhaustedError,
  isFallbackEligible,
} from "./errors.ts";
import type {
  AiCallDescriptor,
  AiCallResult,
  AiLog,
  PlaceAiClient,
  PlaceAiProvider,
  ProviderCallResult,
} from "./provider.ts";
import type {
  AiCandidateJudgment,
  KakaoCandidateReviewItem,
  PlaceGuess,
} from "./types.ts";

interface FallbackOptions {
  log?: AiLog;
}

function countArray(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

export function createFallbackPlaceAiClient(
  primary: PlaceAiProvider,
  fallback?: PlaceAiProvider,
  options: FallbackOptions = {},
): PlaceAiClient {
  async function run<T>(
    descriptor: AiCallDescriptor,
    call: (provider: PlaceAiProvider) => Promise<ProviderCallResult<T>>,
  ): Promise<AiCallResult<T>> {
    const attempts: AiProviderError[] = [];

    const invoke = async (
      provider: PlaceAiProvider,
      fallbackUsed: boolean,
    ): Promise<AiCallResult<T>> => {
      const startedAt = performance.now();
      try {
        const result = await call(provider);
        options.log?.("ai_provider_call_completed", {
          operation: descriptor.operation,
          provider: provider.name,
          model: result.model,
          fallbackUsed,
          durationMs: Math.round(performance.now() - startedAt),
          resultCount: descriptor.resultCount(result.data),
          usage: result.usage ?? null,
        });
        return { ...result, provider: provider.name, fallbackUsed };
      } catch (cause) {
        if (!(cause instanceof AiProviderError)) {
          options.log?.("ai_provider_call_failed", {
            operation: descriptor.operation,
            provider: provider.name,
            model: null,
            fallbackUsed,
            durationMs: Math.round(performance.now() - startedAt),
            failureKind: "UNEXPECTED_INTERNAL",
            status: null,
            retryable: false,
          });
          throw cause;
        }
        const error = cause;
        attempts.push(error);
        options.log?.("ai_provider_call_failed", {
          operation: descriptor.operation,
          provider: provider.name,
          model: error.model,
          fallbackUsed,
          durationMs: Math.round(performance.now() - startedAt),
          failureKind: error.kind,
          status: error.status,
          retryable: error.retryable,
        });
        throw error;
      }
    };

    try {
      return await invoke(primary, false);
    } catch (primaryError) {
      if (!(primaryError instanceof AiProviderError)) throw primaryError;
      if (!fallback || !isFallbackEligible(primaryError)) {
        options.log?.("ai_providers_exhausted", {
          operation: descriptor.operation,
          attemptCount: attempts.length,
        });
        throw new AiProvidersExhaustedError(attempts);
      }
    }

    options.log?.("ai_provider_fallback_started", {
      operation: descriptor.operation,
      fromProvider: primary.name,
      toProvider: fallback.name,
    });
    try {
      const result = await invoke(fallback, true);
      options.log?.("ai_provider_fallback_completed", {
        operation: descriptor.operation,
        provider: fallback.name,
        model: result.model,
      });
      return result;
    } catch (fallbackError) {
      if (!(fallbackError instanceof AiProviderError)) throw fallbackError;
      options.log?.("ai_providers_exhausted", {
        operation: descriptor.operation,
        attemptCount: attempts.length,
      });
      throw new AiProvidersExhaustedError(attempts);
    }
  }

  return {
    extractPlaces(caption: string): Promise<AiCallResult<PlaceGuess[]>> {
      return run(
        { operation: "PLACE_EXTRACTION", resultCount: countArray },
        (provider) => provider.extractPlaces(caption),
      );
    },
    judgeKakaoCandidates(
      caption: string,
      items: KakaoCandidateReviewItem[],
    ): Promise<AiCallResult<AiCandidateJudgment[]>> {
      return run(
        {
          operation: "KAKAO_CANDIDATE_JUDGMENT",
          resultCount: countArray,
        },
        (provider) => provider.judgeKakaoCandidates(caption, items),
      );
    },
  };
}
