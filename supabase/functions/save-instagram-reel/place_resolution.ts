import type {
  AiCandidateJudgment,
  KakaoCandidateReviewItem,
  PlaceGuess,
} from "./ai/types.ts";
import {
  type KakaoAddressCoordinate,
  type KakaoCoordinate,
  type KakaoPlace,
  type KakaoPlacePage,
  KakaoPlaceSearchError,
} from "./kakao.ts";
import {
  buildKakaoQueries,
  deduplicateKakaoPlaces,
  placeSearchNames,
  searchKey,
  selectedKakaoPlace,
  uniqueSearchQueries,
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
  search(query: string, page: number): Promise<KakaoPlacePage>;
  geocodeAddress?(address: string): Promise<KakaoAddressCoordinate[]>;
  searchNearby?(
    query: string,
    center: KakaoCoordinate,
    radiusMeters: number,
    page: number,
  ): Promise<KakaoPlacePage>;
  judge(
    caption: string,
    items: KakaoCandidateReviewItem[],
  ): Promise<AiCandidateJudgment[]>;
  log?: (event: string, details: Record<string, unknown>) => void;
}

interface SearchState extends KakaoCandidateReviewItem {
  queries: string[];
  nearbyQueries: string[];
  centers: KakaoCoordinate[];
}

const SEARCH_RADII = [500, 2000, 5000] as const;
const SEARCH_CONCURRENCY = 3;

function aiNoneFailureReason(
  reason: AiCandidateJudgment["reason"],
): PlaceMatchFailureReason {
  return reason === "AMBIGUOUS_SAME_NAME" || reason === "NAME_MISMATCH" ||
      reason === "ADDRESS_CONFLICT" || reason === "INSUFFICIENT_CONTEXT"
    ? reason
    : "INSUFFICIENT_CONTEXT";
}

async function collectSearches<T>(jobs: Array<() => Promise<T>>): Promise<T[]> {
  const results: T[] = [];
  for (let index = 0; index < jobs.length; index += SEARCH_CONCURRENCY) {
    const batch = await Promise.allSettled(
      jobs.slice(index, index + SEARCH_CONCURRENCY).map((job) => job()),
    );
    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}

/** AI 추출 → 후보 수집 → AI 선택. 미해결 항목만 최대 두 차례 검색을 확장한다. */
export async function resolvePlacesFromKakao(
  caption: string,
  guesses: PlaceGuess[],
  dependencies: PlaceResolutionDependencies,
): Promise<PlaceResolutionResult> {
  const matches: ResolvedPlace[] = [];
  const failures: PlaceMatchFailure[] = [];
  const searchCache = new Map<string, Promise<KakaoPlacePage>>();
  const geocodeCache = new Map<string, Promise<KakaoAddressCoordinate[]>>();

  async function addressCenters(guess: PlaceGuess): Promise<KakaoCoordinate[]> {
    if (!dependencies.geocodeAddress || !dependencies.searchNearby) return [];
    // 보정 주소가 검색되지 않을 때에는 보존한 원문 주소도 시도한다.
    const addresses = [...new Map(
      [guess.searchAddress, guess.address]
        .filter((address): address is string => Boolean(address?.trim()))
        .map((address) => [searchKey(address), address]),
    ).values()];
    for (const address of addresses) {
      try {
        const key = searchKey(address);
        let response = geocodeCache.get(key);
        if (!response) {
          response = dependencies.geocodeAddress(address);
          geocodeCache.set(key, response);
        }
        const coordinates = await response;
        const centers = [...new Map(coordinates.map((coordinate) => [
          coordinate.longitude + "," + coordinate.latitude,
          coordinate,
        ])).values()].slice(0, 2);
        if (centers.length > 0) return centers;
      } catch (error) {
        if (!(error instanceof KakaoPlaceSearchError)) throw error;
        dependencies.log?.("kakao_address_search_skipped", {
          kind: error.kind,
          status: error.status,
        });
      }
    }
    return [];
  }

  async function keywordCandidates(
    query: string,
    pages: number,
  ): Promise<KakaoPlace[]> {
    const candidates: KakaoPlace[] = [];
    for (let page = 1; page <= pages; page += 1) {
      const key = "keyword:" + searchKey(query) + ":" + page;
      let response = searchCache.get(key);
      if (!response) {
        response = dependencies.search(query, page);
        searchCache.set(key, response);
      }
      const result = await response;
      candidates.push(...result.places);
      if (result.isEnd) break;
    }
    return candidates;
  }

  async function nearbyCandidates(
    query: string,
    center: KakaoCoordinate,
    radius: number,
    pages: number,
  ): Promise<KakaoPlace[]> {
    if (!dependencies.searchNearby) return [];
    const candidates: KakaoPlace[] = [];
    try {
      for (let page = 1; page <= pages; page += 1) {
        const key = "nearby:" + JSON.stringify([
          searchKey(query),
          center.longitude,
          center.latitude,
          radius,
          page,
        ]);
        let response = searchCache.get(key);
        if (!response) {
          response = dependencies.searchNearby(query, center, radius, page);
          searchCache.set(key, response);
        }
        const result = await response;
        candidates.push(...result.places);
        if (result.isEnd) break;
      }
    } catch (error) {
      if (!(error instanceof KakaoPlaceSearchError)) throw error;
      dependencies.log?.("kakao_address_nearby_search_skipped", {
        kind: error.kind,
        status: error.status,
      });
    }
    return candidates;
  }

  async function expand(
    state: SearchState,
    round: number,
    retries: string[] = [],
  ): Promise<void> {
    state.queries = uniqueSearchQueries([...state.queries, ...retries]);
    state.nearbyQueries = uniqueSearchQueries([
      ...state.nearbyQueries,
      ...retries,
    ]);
    const jobs: Array<() => Promise<KakaoPlace[]>> = [];
    for (const center of state.centers) {
      for (const name of state.nearbyQueries) {
        jobs.push(() =>
          nearbyCandidates(name, center, SEARCH_RADII[round], round + 1)
        );
      }
    }
    for (const query of state.queries) {
      jobs.push(() => keywordCandidates(query, round + 1));
    }
    const results = await collectSearches(jobs);
    state.candidates = deduplicateKakaoPlaces([
      ...state.candidates,
      ...results.flat(),
    ]);
    state.searchQueries = [...state.queries];
    state.remainingSearchRounds = SEARCH_RADII.length - round - 1;
    dependencies.log?.("kakao_place_candidates_collected", {
      guessIndex: state.guessIndex,
      round,
      queries: state.queries,
      radiusMeters: state.centers.length ? SEARCH_RADII[round] : null,
      candidateCount: state.candidates.length,
    });
  }

  function fail(
    state: SearchState,
    reason: PlaceMatchFailureReason,
    stage: PlaceMatchFailure["stage"],
  ): void {
    failures.push({
      guessIndex: state.guessIndex,
      guess: state.guess,
      candidates: state.candidates,
      reason,
      stage,
      searchOrigin: state.remainingSearchRounds === SEARCH_RADII.length - 1
        ? "INITIAL"
        : "EXPANDED_NAME_ONLY",
    });
  }

  let pending: SearchState[] = [];
  for (const [guessIndex, guess] of guesses.entries()) {
    const state: SearchState = {
      guessIndex,
      guess,
      candidates: [],
      queries: buildKakaoQueries(guess),
      nearbyQueries: placeSearchNames(guess),
      centers: await addressCenters(guess),
    };
    await expand(state, 0);
    pending.push(state);
  }

  for (
    let round = 0;
    round < SEARCH_RADII.length && pending.length > 0;
    round += 1
  ) {
    const judgments = await dependencies.judge(caption, pending);
    const judgmentByGuess = new Map(
      judgments.map((judgment) => [judgment.guessIndex, judgment]),
    );
    const next: SearchState[] = [];
    for (const state of pending) {
      const judgment = judgmentByGuess.get(state.guessIndex);
      if (!judgment) {
        fail(state, "AI_JUDGMENT_UNAVAILABLE", "AI_REVIEW");
        continue;
      }
      if (judgment.decision === "SELECT") {
        const place = selectedKakaoPlace(
          state.candidates,
          judgment.candidateId,
        );
        if (place) {
          matches.push({
            guessIndex: state.guessIndex,
            guess: state.guess,
            place,
          });
        } else fail(state, "AI_SELECTED_UNKNOWN_CANDIDATE", "FINAL_GUARD");
      } else if (judgment.decision === "NONE") {
        fail(state, aiNoneFailureReason(judgment.reason), "AI_REVIEW");
      } else if (round + 1 < SEARCH_RADII.length) {
        await expand(
          state,
          round + 1,
          uniqueSearchQueries(judgment.retryQueries).slice(0, 3),
        );
        next.push(state);
      } else {
        fail(
          state,
          state.candidates.length === 0
            ? "NO_KAKAO_CANDIDATE_AFTER_EXPANSION"
            : "INSUFFICIENT_CONTEXT",
          state.candidates.length === 0 ? "KAKAO_SEARCH" : "AI_REVIEW",
        );
      }
      dependencies.log?.("ai_candidate_judgment_resolved", {
        guessIndex: state.guessIndex,
        round,
        decision: judgment.decision,
        candidateId: judgment.candidateId,
        reason: judgment.reason,
      });
    }
    pending = next;
  }

  const seen = new Set<string>();
  return {
    matches: matches.sort((a, b) => a.guessIndex - b.guessIndex).filter(
      ({ place }) => {
        if (seen.has(place.kakaoPlaceId)) return false;
        seen.add(place.kakaoPlaceId);
        return true;
      },
    ),
    failures: failures.sort((a, b) => a.guessIndex - b.guessIndex),
  };
}
