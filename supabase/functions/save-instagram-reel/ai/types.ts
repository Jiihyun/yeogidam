import type { KakaoPlace } from "../kakao.ts";

export type AiProviderName = "gemini" | "openai";

export type AiOperation =
  | "PLACE_EXTRACTION"
  | "KAKAO_CANDIDATE_JUDGMENT";

export type AddressType = "ROAD" | "JIBUN" | "PARTIAL" | "NONE";

export interface PlaceGuess {
  placeName: string;
  address: string | null;
  addressType: AddressType;
  region: string | null;
}

export interface KakaoCandidateReviewItem {
  guessIndex: number;
  guess: PlaceGuess;
  candidates: KakaoPlace[];
  captionContexts?: string[];
}

export type AiCandidateJudgmentReason =
  | "MATCH"
  | "CANDIDATE_MISSING"
  | "AMBIGUOUS_SAME_NAME"
  | "NAME_MISMATCH"
  | "ADDRESS_CONFLICT"
  | "INSUFFICIENT_CONTEXT";

export interface AiCandidateJudgment {
  guessIndex: number;
  decision: "SELECT" | "RETRY" | "NONE";
  candidateId: string | null;
  retryQueries: string[];
  reason: AiCandidateJudgmentReason;
}
