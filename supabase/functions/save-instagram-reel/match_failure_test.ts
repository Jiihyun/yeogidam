import type { PlaceGuess } from "./gemini.ts";
import type { KakaoPlace } from "./kakao.ts";
import { placeMatchFailureRow } from "./match_failure.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const guess: PlaceGuess = {
  placeName: "바람따라",
  address: "동구 동명로 79",
  addressType: "ROAD",
  region: "동구",
};

function candidate(id: string): KakaoPlace {
  return {
    kakaoPlaceId: id,
    name: "바람따라",
    category: null,
    roadAddress: null,
    address: null,
    latitude: null,
    longitude: null,
    placeUrl: null,
    telephone: null,
  };
}

Deno.test("builds a queryable per-place failure row with deduped candidate IDs", () => {
  assertEquals(
    placeMatchFailureRow("reel-1", {
      guessIndex: 2,
      guess,
      stage: "FINAL_GUARD",
      reason: "UNRESOLVED_MULTI_REGION",
      searchOrigin: "EXPANDED_NAME_ONLY",
      classifierReason: "MULTIPLE_VERIFIED_CANDIDATES",
      candidates: [candidate("gwangju"), candidate("busan"), candidate("gwangju")],
    }),
    {
      reel_id: "reel-1",
      guess_index: 2,
      place_name: "바람따라",
      source_address: "동구 동명로 79",
      source_region: "동구",
      failure_stage: "FINAL_GUARD",
      failure_reason: "UNRESOLVED_MULTI_REGION",
      search_origin: "EXPANDED_NAME_ONLY",
      classifier_reason: "MULTIPLE_VERIFIED_CANDIDATES",
      candidate_count: 2,
      candidate_ids: ["gwangju", "busan"],
    },
  );
});
