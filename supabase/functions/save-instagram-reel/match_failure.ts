import type { PlaceGuess } from "./ai/types.ts";
import type { KakaoPlace } from "./kakao.ts";

export type PlaceMatchFailureStage =
  | "KAKAO_SEARCH"
  | "AI_REVIEW"
  | "FINAL_GUARD";

export type PlaceMatchFailureReason =
  | "NO_KAKAO_CANDIDATE"
  | "NO_KAKAO_CANDIDATE_AFTER_EXPANSION"
  | "AI_JUDGMENT_UNAVAILABLE"
  | "AMBIGUOUS_SAME_NAME"
  | "NAME_MISMATCH"
  | "ADDRESS_CONFLICT"
  | "INSUFFICIENT_CONTEXT"
  | "AI_SELECTED_UNKNOWN_CANDIDATE";

export interface PlaceMatchFailure {
  guessIndex: number;
  guess: PlaceGuess;
  stage: PlaceMatchFailureStage;
  reason: PlaceMatchFailureReason;
  candidates: KakaoPlace[];
  searchOrigin?: "INITIAL" | "EXPANDED_NAME_ONLY";
}

export interface PlaceMatchFailureRow {
  reel_id: string;
  guess_index: number;
  place_name: string;
  source_address: string | null;
  source_region: string | null;
  failure_stage: PlaceMatchFailureStage;
  failure_reason: PlaceMatchFailureReason;
  search_origin: "INITIAL" | "EXPANDED_NAME_ONLY";
  classifier_reason: null;
  candidate_count: number;
  candidate_ids: string[];
}

export function placeMatchFailureRow(
  reelId: string,
  failure: PlaceMatchFailure,
): PlaceMatchFailureRow {
  const candidateIds = [
    ...new Set(failure.candidates.map((candidate) => candidate.kakaoPlaceId)),
  ];
  return {
    reel_id: reelId,
    guess_index: failure.guessIndex,
    place_name: failure.guess.placeName,
    source_address: failure.guess.address,
    source_region: failure.guess.region,
    failure_stage: failure.stage,
    failure_reason: failure.reason,
    search_origin: failure.searchOrigin ?? "INITIAL",
    classifier_reason: null,
    candidate_count: candidateIds.length,
    candidate_ids: candidateIds,
  };
}
