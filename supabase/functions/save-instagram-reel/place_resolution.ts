import {
  type AiCandidateJudgment,
  type KakaoCandidateReviewItem,
  type PlaceGuess,
} from "./ai/types.ts";
import {
  type KakaoAddressCoordinate,
  type KakaoCoordinate,
  type KakaoPlace,
  KakaoPlaceSearchError,
} from "./kakao.ts";
import {
  addressMatches,
  buildKakaoQueries,
  captionContextsForPlaceName,
  classifyKakaoCandidates,
  deduplicateKakaoPlaces,
  groundedRetryQueries,
  hasDetailedAddressEvidence,
  locationMatchedKakaoPlaces,
  resolveAiSelectedKakaoPlace,
  resolveRetriedKakaoPlace,
  validateKakaoCandidate,
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
  geocodeAddress?(address: string): Promise<KakaoAddressCoordinate[]>;
  searchNearby?(
    query: string,
    center: KakaoCoordinate,
  ): Promise<KakaoPlace[]>;
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

async function addAddressNearbyCandidates(
  guessIndex: number,
  guess: PlaceGuess,
  queries: string[],
  initialCandidates: KakaoPlace[],
  dependencies: PlaceResolutionDependencies,
  geocodeCache: Map<string, Promise<KakaoAddressCoordinate[]>>,
): Promise<KakaoPlace[]> {
  if (
    !guess.address || !hasDetailedAddressEvidence(guess) ||
    initialCandidates.some((candidate) =>
      validateKakaoCandidate(guess, candidate).status === "ACCEPTED"
    ) ||
    !dependencies.geocodeAddress || !dependencies.searchNearby
  ) {
    return initialCandidates;
  }

  try {
    const geocodeKey = searchKey(guess.address);
    let geocodedPromise = geocodeCache.get(geocodeKey);
    if (!geocodedPromise) {
      geocodedPromise = dependencies.geocodeAddress(guess.address);
      geocodeCache.set(geocodeKey, geocodedPromise);
    }
    const geocoded = await geocodedPromise;
    const matchingCoordinates = geocoded.filter((coordinate) =>
      [coordinate.roadAddress, coordinate.address].some((candidateAddress) =>
        Boolean(
          candidateAddress &&
            addressMatches(
              guess.address!,
              candidateAddress,
              guess.region,
            ),
        )
      )
    );
    if (matchingCoordinates.length !== 1) {
      dependencies.log?.("kakao_address_coordinate_unresolved", {
        guessIndex,
        geocodedCount: geocoded.length,
        matchingCoordinateCount: matchingCoordinates.length,
      });
      return initialCandidates;
    }
    const center = matchingCoordinates[0];

    const nearbyCandidates: KakaoPlace[] = [];
    for (const query of queries) {
      nearbyCandidates.push(...await dependencies.searchNearby(query, center));
    }
    const exactNearbyCandidates = locationMatchedKakaoPlaces(
      guess,
      nearbyCandidates,
    ).filter((candidate) =>
      validateKakaoCandidate(guess, candidate).status === "ACCEPTED"
    );
    if (exactNearbyCandidates.length === 0) {
      dependencies.log?.("kakao_address_nearby_exact_candidate_not_found", {
        guessIndex,
        nearbyCandidateCount: nearbyCandidates.length,
      });
      return initialCandidates;
    }
    // 정확주소 주변 결과를 먼저 두어 AI 검토의 15개 제한에도 해당 후보가
    // 포함되게 하되, 자동 확정은 아래 기존 주소·이름 분류기만 수행한다.
    const merged = deduplicateKakaoPlaces([
      ...exactNearbyCandidates,
      ...initialCandidates,
    ]);
    dependencies.log?.("kakao_address_nearby_candidates_merged", {
      guessIndex,
      initialCandidateCount: initialCandidates.length,
      nearbyCandidateCount: nearbyCandidates.length,
      exactNearbyCandidateCount: exactNearbyCandidates.length,
      mergedCandidateCount: merged.length,
      exactAddressCandidateCount: locationMatchedKakaoPlaces(guess, merged)
        .length,
    });
    return merged;
  } catch (error) {
    // 보조 검색 장애는 기존 키워드 후보와 AI 판단 경로를 그대로 유지한다.
    if (!(error instanceof KakaoPlaceSearchError)) throw error;
    dependencies.log?.("kakao_address_nearby_search_skipped", {
      guessIndex,
      kind: error.kind,
      status: error.status,
    });
    return initialCandidates;
  }
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
  const geocodeCache = new Map<
    string,
    Promise<KakaoAddressCoordinate[]>
  >();
  const allPlaceNames = guesses.map((guess) => guess.placeName);

  for (const [guessIndex, guess] of guesses.entries()) {
    const validationGuess = withCaptionRegionHints(
      guess,
      caption,
      allPlaceNames,
    );
    validationGuesses.set(guessIndex, validationGuess);
    const queries = buildKakaoQueries(guess);
    const searchedCandidates: KakaoPlace[] = [];
    for (const query of queries) {
      searchedCandidates.push(...await dependencies.search(query));
    }
    const initialCandidates = deduplicateKakaoPlaces(searchedCandidates);
    const candidates = await addAddressNearbyCandidates(
      guessIndex,
      validationGuess,
      queries,
      initialCandidates,
      dependencies,
      geocodeCache,
    );
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
