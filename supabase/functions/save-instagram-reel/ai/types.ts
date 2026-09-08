import type { KakaoPlace } from "../kakao.ts";

export type AiProviderName = "gemini" | "openai";

export type AiOperation =
  | "PLACE_EXTRACTION"
  | "KAKAO_CANDIDATE_JUDGMENT";

export type AddressType = "ROAD" | "JIBUN" | "PARTIAL" | "NONE";

export interface PlaceGuess {
  /** 캡션에 적힌 원래 이름. 검색 보정으로 덮어쓰지 않는다. */
  placeName: string;
  /** AI가 제안한 오타·음차·공식 표기 검색 후보. */
  searchNames?: string[];
  address: string | null;
  /** 층·호수 등을 제외한 주소 검색용 표현. */
  searchAddress?: string | null;
  addressType: AddressType;
  region: string | null;
}

export interface KakaoCandidateReviewItem {
  guessIndex: number;
  guess: PlaceGuess;
  candidates: KakaoPlace[];
  captionContexts?: string[];
  searchQueries?: string[];
  remainingSearchRounds?: number;
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
