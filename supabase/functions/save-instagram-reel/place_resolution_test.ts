// 외부 비동기 의존성을 대신하는 스텁은 값을 즉시 반환한다.
// deno-lint-ignore-file require-await
import type { AiCandidateJudgment, PlaceGuess } from "./ai/types.ts";
import {
  type KakaoPlace,
  type KakaoPlacePage,
  KakaoPlaceSearchError,
} from "./kakao.ts";
import { resolvePlacesFromKakao } from "./place_resolution.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "Expected " + JSON.stringify(expected) + ", got " +
        JSON.stringify(actual),
    );
  }
}
function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("assertion failed");
}
function guess(placeName: string, searchNames: string[] = []): PlaceGuess {
  return {
    placeName,
    searchNames,
    address: null,
    addressType: "NONE",
    region: null,
  };
}
function candidate(kakaoPlaceId: string, name: string): KakaoPlace {
  return {
    kakaoPlaceId,
    name,
    category: "음식점",
    roadAddress: null,
    address: null,
    latitude: null,
    longitude: null,
    placeUrl: null,
    telephone: null,
  };
}
function page(places: KakaoPlace[] = [], isEnd = true): KakaoPlacePage {
  return { places, isEnd };
}
function select(guessIndex: number, candidateId: string): AiCandidateJudgment {
  return {
    guessIndex,
    decision: "SELECT",
    candidateId,
    retryQueries: [],
    reason: "MATCH",
  };
}
function retry(
  guessIndex: number,
  retryQueries: string[],
): AiCandidateJudgment {
  return {
    guessIndex,
    decision: "RETRY",
    candidateId: null,
    retryQueries,
    reason: "CANDIDATE_MISSING",
  };
}

Deno.test("finds 버연희 and 파파죤스 through AI corrections while preserving source fields", async () => {
  const guesses = [
    guess("버연희", ["보연희"]),
    guess("파파죤스", ["파파존스", "Papa John's"]),
  ];
  const corrected = [
    candidate("boyeon", "보연희"),
    candidate("papa", "파파존스 연희점"),
  ];
  const calls: string[] = [];
  const result = await resolvePlacesFromKakao("버연희 / 파파죤스", guesses, {
    async search(query) {
      calls.push(query);
      return page(
        query === "보연희"
          ? [corrected[0]]
          : query === "파파존스"
          ? [corrected[1]]
          : [],
      );
    },
    async judge(caption, items) {
      assertEquals(caption, "버연희 / 파파죤스");
      assertEquals(items.map((item) => item.guess.placeName), [
        "버연희",
        "파파죤스",
      ]);
      return [select(0, "boyeon"), select(1, "papa")];
    },
  });
  assertEquals(calls, [
    "버연희",
    "보연희",
    "파파죤스",
    "파파존스",
    "Papa John's",
  ]);
  assertEquals(
    result.matches.map((match) => [match.guess.placeName, match.place.name]),
    [["버연희", "보연희"], ["파파죤스", "파파존스 연희점"]],
  );
  assertEquals(result.failures, []);
});

Deno.test("lets AI inspect a lone initial candidate and rejudge expanded candidates", async () => {
  const wrong = candidate("wrong", "다른 가게");
  const correct = candidate("correct", "보연희");
  let rounds = 0;
  const result = await resolvePlacesFromKakao("버연희", [guess("버연희")], {
    async search(query) {
      return page(query === "버연희" ? [wrong] : [correct]);
    },
    async judge(_caption, items) {
      rounds += 1;
      if (rounds === 1) {
        assertEquals(items[0].candidates, [wrong]);
        return [retry(0, ["보연희 서울"])];
      }
      assertEquals(items[0].candidates, [wrong, correct]);
      return [select(0, "correct")];
    },
  });
  assertEquals(rounds, 2);
  assertEquals(result.matches.map((match) => match.place.kakaoPlaceId), [
    "correct",
  ]);
});

Deno.test("shows all pooled candidates and later pages without repeating prior requests", async () => {
  const first = Array.from(
    { length: 15 },
    (_, i) => candidate("first-" + i, "체인점 " + i),
  );
  const correct = candidate("correct", "체인점 목표지점");
  const calls: string[] = [];
  let rounds = 0;
  const result = await resolvePlacesFromKakao("체인점", [guess("체인점")], {
    async search(query, currentPage) {
      calls.push(query + ":" + currentPage);
      return currentPage === 1 ? page(first, false) : page([correct]);
    },
    async judge(_caption, items) {
      rounds += 1;
      if (rounds === 1) return [retry(0, ["체인점"])];
      assertEquals(items[0].candidates.length, 16);
      assertEquals(items[0].candidates.at(-1)?.kakaoPlaceId, "correct");
      return [select(0, "correct")];
    },
  });
  assertEquals(calls, ["체인점:1", "체인점:2"]);
  assertEquals(result.matches[0].place.kakaoPlaceId, "correct");
});

Deno.test("accepts address-centered candidates without exact name or address filtering", async () => {
  const source = {
    ...guess("버연희", ["보연희"]),
    address: "서울 서대문구 연희맛로 17-63 2층",
    searchAddress: "서울 서대문구 연희맛로 17-63",
    addressType: "ROAD" as const,
  };
  const correct = {
    ...candidate("correct", "BOYEONHUI"),
    address: "서울 서대문구 연희동 지번 표기",
  };
  const coordinates = [{
    latitude: 37.5,
    longitude: 127,
    address: "서울 서대문구 연희동",
    roadAddress: null,
  }];
  let geocodeCalls = 0;
  const radii: number[] = [];
  const result = await resolvePlacesFromKakao("버연희", [source], {
    async geocodeAddress(address) {
      geocodeCalls += 1;
      assertEquals(address, source.searchAddress);
      return coordinates;
    },
    async searchNearby(query, center, radius) {
      assertEquals(center, coordinates[0]);
      radii.push(radius);
      return page(query === "보연희" ? [correct] : []);
    },
    async search() {
      return page();
    },
    async judge(_caption, items) {
      assertEquals(items[0].guess.address, source.address);
      assertEquals(items[0].candidates, [correct]);
      return [select(0, "correct")];
    },
  });
  assertEquals(geocodeCalls, 1);
  assertEquals(radii, [500, 500]);
  assertEquals(result.matches[0].place, correct);
});

Deno.test("expands nearby radii over two retries and judges the final results", async () => {
  const radii: number[] = [];
  let rounds = 0;
  const correct = candidate("correct", "보연희");
  const result = await resolvePlacesFromKakao("버연희", [{
    ...guess("버연희"),
    address: "연희동",
    addressType: "PARTIAL",
  }], {
    async geocodeAddress() {
      return [{
        latitude: 37.5,
        longitude: 127,
        address: "연희동",
        roadAddress: null,
      }];
    },
    async searchNearby(_query, _center, radius) {
      radii.push(radius);
      return page(radius === 5000 ? [correct] : []);
    },
    async search() {
      return page();
    },
    async judge(_caption, items) {
      assertEquals(items[0].remainingSearchRounds, 2 - rounds);
      rounds += 1;
      return rounds < 3 ? [retry(0, ["버연희"])] : [select(0, "correct")];
    },
  });
  assertEquals(radii, [500, 2000, 5000]);
  assertEquals(rounds, 3);
  assertEquals(result.matches[0].place, correct);
});

Deno.test("falls back to the source address and shares geocoding and keyword calls", async () => {
  const source = {
    ...guess("장소"),
    address: "원문 주소",
    searchAddress: "검색용 주소",
  };
  const geocoded: string[] = [];
  let keywordCalls = 0;
  const result = await resolvePlacesFromKakao("장소", [source, source], {
    async geocodeAddress(address) {
      geocoded.push(address);
      return address === "원문 주소"
        ? [{ latitude: 37.5, longitude: 127, address, roadAddress: null }]
        : [];
    },
    async searchNearby() {
      return page();
    },
    async search() {
      keywordCalls += 1;
      return page([candidate("one", "장소")]);
    },
    async judge() {
      return [select(0, "one"), select(1, "one")];
    },
  });
  assertEquals(geocoded, ["검색용 주소", "원문 주소"]);
  assertEquals(keywordCalls, 1);
  assertEquals(result.matches.length, 1);
});

Deno.test("continues keyword search when optional geocoding or nearby search fails", async () => {
  for (const failureAt of ["geocode", "nearby"]) {
    const result = await resolvePlacesFromKakao("장소", [{
      ...guess("장소"),
      address: "주소",
    }], {
      async geocodeAddress() {
        if (failureAt === "geocode") {
          throw new KakaoPlaceSearchError("SERVER", 503, true);
        }
        return [{
          latitude: 37.5,
          longitude: 127,
          address: "주소",
          roadAddress: null,
        }];
      },
      async searchNearby() {
        throw new KakaoPlaceSearchError("NETWORK", null, true);
      },
      async search() {
        return page([candidate("one", "장소")]);
      },
      async judge() {
        return [select(0, "one")];
      },
    });
    assertEquals(result.matches.length, 1);
  }
});

Deno.test("rejects unknown IDs, records missing judgments, and keeps valid matches ordered", async () => {
  const result = await resolvePlacesFromKakao("a b c d", [
    guess("a"),
    guess("b"),
    guess("c"),
    guess("d"),
  ], {
    async search(query) {
      return page([candidate(query, query)]);
    },
    async judge() {
      return [select(3, "d"), select(2, "a"), select(0, "a")];
    },
  });
  assertEquals(result.matches.map((match) => match.guessIndex), [0, 3]);
  assertEquals(
    result.failures.map((failure) => [failure.guessIndex, failure.reason]),
    [[1, "AI_JUDGMENT_UNAVAILABLE"], [2, "AI_SELECTED_UNKNOWN_CANDIDATE"]],
  );
});

Deno.test("keeps selected places while retrying only unresolved guesses", async () => {
  let rounds = 0;
  const result = await resolvePlacesFromKakao("a b", [guess("a"), guess("b")], {
    async search(query) {
      return page([candidate(query, query)]);
    },
    async judge(_caption, items) {
      rounds += 1;
      if (rounds === 1) return [retry(0, ["correct-a"]), select(1, "b")];
      assertEquals(items.map((item) => item.guessIndex), [0]);
      return [select(0, "correct-a")];
    },
  });
  assertEquals(result.matches.map((match) => match.guessIndex), [0, 1]);
});

Deno.test("bounds repeated retries and records NONE without another search", async () => {
  let rounds = 0;
  const result = await resolvePlacesFromKakao("a b", [guess("a"), guess("b")], {
    async search() {
      return page();
    },
    async judge(_caption, items) {
      rounds += 1;
      return items.map((item) =>
        item.guessIndex === 0 ? retry(0, ["a"]) : {
          guessIndex: 1,
          decision: "NONE",
          candidateId: null,
          retryQueries: [],
          reason: "AMBIGUOUS_SAME_NAME",
        }
      );
    },
  });
  assertEquals(rounds, 3);
  assertEquals(result.failures.map((failure) => failure.reason), [
    "NO_KAKAO_CANDIDATE_AFTER_EXPANSION",
    "AMBIGUOUS_SAME_NAME",
  ]);
});

Deno.test("preserves provider errors instead of treating outages as zero candidates", async () => {
  const upstream = new KakaoPlaceSearchError("RATE_LIMIT", 429, true);
  try {
    await resolvePlacesFromKakao("a", [guess("a")], {
      async search() {
        throw upstream;
      },
      async judge() {
        throw new Error("must not judge an outage");
      },
    });
    throw new Error("expected provider error");
  } catch (error) {
    assert(error === upstream);
  }
});

Deno.test("does not call dependencies for an empty extraction", async () => {
  const never = () => {
    throw new Error("must not run");
  };
  assertEquals(
    await resolvePlacesFromKakao("", [], { search: never, judge: never }),
    { matches: [], failures: [] },
  );
});

Deno.test("reads later nearby pages when a dense area hides the corrected place", async () => {
  let rounds = 0;
  const calls: string[] = [];
  const correct = candidate("correct", "파파존스");
  const result = await resolvePlacesFromKakao("파파죤스", [{
    ...guess("파파죤스"),
    address: "역삼동",
  }], {
    async geocodeAddress() {
      return [{
        latitude: 37.5,
        longitude: 127,
        address: "역삼동",
        roadAddress: null,
      }];
    },
    async searchNearby(_query, _center, radius, currentPage) {
      calls.push(radius + ":" + currentPage);
      return currentPage === 1
        ? page([candidate("other", "다른 장소")], false)
        : page([correct]);
    },
    async search() {
      return page();
    },
    async judge(_caption, items) {
      rounds += 1;
      if (rounds === 1) return [retry(0, ["파파죤스"])];
      assert(
        items[0].candidates.some((place) => place.kakaoPlaceId === "correct"),
      );
      return [select(0, "correct")];
    },
  });
  assertEquals(calls, ["500:1", "2000:1", "2000:2"]);
  assertEquals(result.matches[0].place, correct);
});

Deno.test("keeps earlier corrected queries when the next retry widens the radius", async () => {
  let rounds = 0;
  const correct = candidate("correct", "보연희");
  const result = await resolvePlacesFromKakao("버연희", [{
    ...guess("버연희"),
    address: "연희동",
  }], {
    async geocodeAddress() {
      return [{
        latitude: 37.5,
        longitude: 127,
        address: "연희동",
        roadAddress: null,
      }];
    },
    async searchNearby(query, _center, radius) {
      return page(query === "보연희" && radius === 5000 ? [correct] : []);
    },
    async search() {
      return page();
    },
    async judge(_caption, items) {
      rounds += 1;
      if (rounds === 1) return [retry(0, ["보연희"])];
      if (rounds === 2) return [retry(0, ["BOYEONHUI"])];
      assertEquals(items[0].candidates, [correct]);
      return [select(0, "correct")];
    },
  });
  assertEquals(result.matches[0].place, correct);
});
