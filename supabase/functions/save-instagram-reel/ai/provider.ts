import type {
  AiCandidateJudgment,
  AiOperation,
  AiProviderName,
  KakaoCandidateReviewItem,
  PlaceGuess,
} from "./types.ts";

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ProviderCallResult<T> {
  data: T;
  model: string;
  usage?: ProviderUsage;
}

export interface PlaceAiProvider {
  readonly name: AiProviderName;

  extractPlaces(caption: string): Promise<ProviderCallResult<PlaceGuess[]>>;

  judgeKakaoCandidates(
    caption: string,
    items: KakaoCandidateReviewItem[],
  ): Promise<ProviderCallResult<AiCandidateJudgment[]>>;
}

export interface AiCallResult<T> extends ProviderCallResult<T> {
  provider: AiProviderName;
  fallbackUsed: boolean;
}

export interface PlaceAiClient {
  extractPlaces(caption: string): Promise<AiCallResult<PlaceGuess[]>>;

  judgeKakaoCandidates(
    caption: string,
    items: KakaoCandidateReviewItem[],
  ): Promise<AiCallResult<AiCandidateJudgment[]>>;
}

export type AiLog = (
  event: string,
  details: Record<string, unknown>,
) => void;

export interface AiCallDescriptor {
  operation: AiOperation;
  resultCount(value: unknown): number | null;
}
