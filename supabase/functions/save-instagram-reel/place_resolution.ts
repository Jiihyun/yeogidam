import {
  type AiCandidateJudgment,
  type KakaoCandidateReviewItem,
  type PlaceGuess,
} from "./ai/types.ts";
import type { KakaoPlace } from "./kakao.ts";
import {
  buildKakaoQueries,
  captionContextsForPlaceName,
  classifyKakaoCandidates,
  deduplicateKakaoPlaces,
  groundedRetryQueries,
  resolveAiSelectedKakaoPlace,
  resolveRetriedKakaoPlace,
  withCaptionRegionHints,
} from "./matching.ts";
import type {
  PlaceMatchFailure,
  PlaceMatchFailureReason,
} from "./match_failure.ts";

export interface ResolvedPlace {
  guessIndex: number;
  guess: PlaceGuess;
  place: KakaoPlace;
}

export interface PlaceResolutionResult {
  matches: ResolvedPlace[];
  failures: PlaceMatchFailure[];
}

export interface PlaceResolutionDependencies {
  search(query: string): Promise<KakaoPlace[]>;
  judge(
    caption: string,
    items: KakaoCandidateReviewItem[],
  ): Promise<AiCandidateJudgment[]>;
  log?: (event: string, details: Record<string, unknown>) => void;
}

function aiNoneFailureReason(
  reason: AiCandidateJudgment["reason"],
): PlaceMatchFailureReason {
  return reason === "AMBIGUOUS_SAME_NAME" || reason === "NAME_MISMATCH" ||
      reason === "ADDRESS_CONFLICT" || reason === "INSUFFICIENT_CONTEXT"
    ? reason
    : "INSUFFICIENT_CONTEXT";
}

function searchKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/g, " ")
    .trim();
}

function orderedUniqueMatches(matches: ResolvedPlace[]): ResolvedPlace[] {
  const seen = new Set<string>();
  return [...matches].sort((left, right) => left.guessIndex - right.guessIndex)
    .filter((match) => {
      if (seen.has(match.place.kakaoPlaceId)) return false;
      seen.add(match.place.kakaoPlaceId);
      return true;
    });
}

/**
 * 최초 Kakao 검색과 단 한 번의 AI 판단, 선택적 Kakao 재검색을 수행한다.
 * RETRY 결과는 결정론적으로 끝내며 세 번째 AI 호출은 존재하지 않는다.
 */
export async function resolvePlacesFromKakao(
  caption: string,
  guesses: PlaceGuess[],
  dependencies: PlaceResolutionDependencies,
): Promise<PlaceResolutionResult> {
  const matches: ResolvedPlace[] = [];
  const failures: PlaceMatchFailure[] = [];
  const pendingReviews: KakaoCandidateReviewItem[] = [];
  const validationGuesses = new Map<number, PlaceGuess>();
  const allPlaceNames = guesses.map((guess) => guess.placeName);

  for (const [guessIndex, guess] of guesses.entries()) {
    const validationGuess = withCaptionRegionHints(
      guess,
      caption,
      allPlaceNames,
    );
    validationGuesses.set(guessIndex, validationGuess);
    const searchedCandidates: KakaoPlace[] = [];
    for (const query of buildKakaoQueries(guess)) {
      searchedCandidates.push(...await dependencies.search(query));
    }
    const candidates = deduplicateKakaoPlaces(searchedCandidates);
    const decision = classifyKakaoCandidates(validationGuess, candidates);
    dependencies.log?.("kakao_place_candidates_classified", {
      guessIndex,
      guess,
      candidateCount: candidates.length,
      decision: decision.type,
    });

    if (decision.type === "AUTO_MATCH") {
      matches.push({ guessIndex, guess, place: decision.place });
    } else {
      pendingReviews.push({
        guessIndex,
        guess,
        captionContexts: captionContextsForPlaceName(
          caption,
          guess.placeName,
          allPlaceNames,
        ),
        candidates: decision.type === "NEEDS_AI_REVIEW"
          ? decision.candidates
          : [],
      });
    }
  }

  if (pendingReviews.length === 0) {
    return { matches: orderedUniqueMatches(matches), failures };
  }

  // 모든 0개·모호·충돌 후보를 한 번에 판단한다.
  const judgments = await dependencies.judge(caption, pendingReviews);
  const judgmentByGuess = new Map(
    judgments.map((judgment) => [judgment.guessIndex, judgment]),
  );

  for (const review of pendingReviews) {
    const judgment = judgmentByGuess.get(review.guessIndex);
    if (!judgment) {
      failures.push({
        guessIndex: review.guessIndex,
        guess: review.guess,
        stage: "AI_REVIEW",
        reason: "AI_JUDGMENT_UNAVAILABLE",
        candidates: review.candidates,
      });
      continue;
    }

    if (judgment.decision === "NONE") {
      failures.push({
        guessIndex: review.guessIndex,
        guess: review.guess,
        stage: "AI_REVIEW",
        reason: aiNoneFailureReason(judgment.reason),
        candidates: review.candidates,
      });
      dependencies.log?.("ai_candidate_judgment_unresolved", {
        guessIndex: review.guessIndex,
        decision: judgment.decision,
        reason: judgment.reason,
      });
      continue;
    }

    if (judgment.decision === "SELECT") {
      const validationGuess = validationGuesses.get(review.guessIndex) ??
        review.guess;
      const resolution = judgment.candidateId
        ? resolveAiSelectedKakaoPlace(
          validationGuess,
          review.candidates,
          judgment.candidateId,
          review.captionContexts?.join(" ") ?? null,
        )
        : {
          status: "REJECTED" as const,
          reason: "AI_SELECTED_UNKNOWN_CANDIDATE" as const,
        };
      dependencies.log?.("ai_candidate_selection_guarded", {
        guessIndex: review.guessIndex,
        candidateId: judgment.candidateId,
        result: resolution.status,
        reason: resolution.status === "REJECTED" ? resolution.reason : null,
      });
      if (resolution.status === "ACCEPTED") {
        matches.push({
          guessIndex: review.guessIndex,
          guess: review.guess,
          place: resolution.place,
        });
      } else {
        failures.push({
          guessIndex: review.guessIndex,
          guess: review.guess,
          stage: "FINAL_GUARD",
          reason: resolution.reason,
          candidates: review.candidates,
        });
      }
      continue;
    }

    const initialQueries = new Set(
      buildKakaoQueries(review.guess).map(searchKey),
    );
    const validationGuess = validationGuesses.get(review.guessIndex) ??
      review.guess;
    const queries = groundedRetryQueries(
      validationGuess,
      caption,
      judgment.retryQueries,
      allPlaceNames,
    ).filter((query) => !initialQueries.has(searchKey(query)));
    if (queries.length === 0) {
      failures.push({
        guessIndex: review.guessIndex,
        guess: review.guess,
        stage: "AI_REVIEW",
        reason: "INSUFFICIENT_CONTEXT",
        candidates: review.candidates,
      });
      continue;
    }

    const retriedCandidates: KakaoPlace[] = [];
    for (const query of queries) {
      retriedCandidates.push(...await dependencies.search(query));
    }
    const candidates = deduplicateKakaoPlaces(retriedCandidates);
    const resolution = resolveRetriedKakaoPlace(
      validationGuess,
      queries,
      candidates,
    );
    dependencies.log?.("kakao_retry_candidates_resolved", {
      guessIndex: review.guessIndex,
      queries,
      candidateCount: candidates.length,
      result: resolution.status,
      reason: resolution.status === "REJECTED" ? resolution.reason : null,
    });
    if (resolution.status === "ACCEPTED") {
      matches.push({
        guessIndex: review.guessIndex,
        guess: review.guess,
        place: resolution.place,
      });
    } else {
      failures.push({
        guessIndex: review.guessIndex,
        guess: review.guess,
        stage: resolution.reason === "NO_KAKAO_CANDIDATE_AFTER_EXPANSION"
          ? "KAKAO_SEARCH"
          : "FINAL_GUARD",
        reason: resolution.reason,
        candidates,
        searchOrigin: "EXPANDED_NAME_ONLY",
      });
    }
  }

  return {
    matches: orderedUniqueMatches(matches),
    failures: failures.sort((left, right) =>
      left.guessIndex - right.guessIndex
    ),
  };
}
