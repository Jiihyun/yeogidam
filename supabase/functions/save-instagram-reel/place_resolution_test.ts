import type {
  AiCandidateJudgment,
  KakaoCandidateReviewItem,
  PlaceGuess,
} from "./ai/types.ts";
import { type KakaoPlace, KakaoPlaceSearchError } from "./kakao.ts";
import { sanitizePlaceGuesses } from "./matching.ts";
import { resolvePlacesFromKakao } from "./place_resolution.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function guess(
  placeName: string,
  address: string | null = null,
  region: string | null = null,
): PlaceGuess {
  return {
    placeName,
    address,
    addressType: address ? "ROAD" : "NONE",
    region,
  };
}

function candidate(
  kakaoPlaceId: string,
  name: string,
  roadAddress: string | null = null,
): KakaoPlace {
  return {
    kakaoPlaceId,
    name,
    category: "카페",
    roadAddress,
    address: null,
    latitude: null,
    longitude: null,
    placeUrl: null,
    telephone: null,
  };
}

Deno.test("batches SELECT RETRY and NONE once while preserving original place order", async () => {
  const guesses = [
    guess("보연희", "서울 서대문구 연희맛로 17-63", "서울"),
    guess("오우드", "서울 성동구 연무장길 12", "서울"),
    guess("우직"),
    guess("윤숲 후루츠산도점", "서울 중랑구 면목로7길 8", "서울"),
    guess("용용선생"),
  ];
  const direct = candidate(
    "direct",
    "보연희",
    "서울특별시 서대문구 연희맛로 17-63",
  );
  const owoodSeoul = candidate(
    "owood-seoul",
    "오우드 성수점",
    "서울특별시 성동구 연무장길 12",
  );
  const owoodBusan = candidate(
    "owood-busan",
    "오우드 성수점 별관",
    "서울특별시 성동구 연무장길 12",
  );
  const woozik = candidate(
    "1595758078",
    "우직",
    "부산광역시 부산진구 전포대로256번길 34-3",
  );
  const yunsoop = candidate(
    "1775568752",
    "윤숲 후르츠산도점",
    "서울특별시 중랑구 면목로7길 8",
  );
  const chainCandidates = [
    candidate("chain-seoul", "용용선생 서울점", "서울특별시 강남구 강남대로 1"),
    candidate(
      "chain-busan",
      "용용선생 부산점",
      "부산광역시 부산진구 중앙대로 1",
    ),
  ];
  const initialWoozikCandidates = Array.from(
    { length: 15 },
    (_, index) => candidate(`wrong-${index}`, `우직 ${index}`),
  );
  const responses = new Map<string, KakaoPlace[]>([
    ["보연희", [direct]],
    ["오우드", [owoodSeoul, owoodBusan]],
    ["우직", initialWoozikCandidates],
    ["윤숲 후루츠산도점", []],
    ["용용선생", chainCandidates],
    ["우직 부산", [woozik]],
    ["윤숲 후르츠산도점", [yunsoop]],
  ]);
  const searchCalls: string[] = [];
  let judgeCalls = 0;

  const result = await resolvePlacesFromKakao(
    "보연희 서울 서대문구 연희맛로 17-63 / " +
      "오우드 서울 성동구 연무장길 12 / " +
      "우직\n@woozik.busan / " +
      "윤숲 후루츠산도점 서울 중랑구 면목로7길 8 / 용용선생",
    guesses,
    {
      search(query) {
        searchCalls.push(query);
        return Promise.resolve(responses.get(query) ?? []);
      },
      judge(_caption: string, items: KakaoCandidateReviewItem[]) {
        judgeCalls += 1;
        assertEquals(items.map((item) => item.guessIndex), [1, 2, 3, 4]);
        assertEquals(items[2].candidates, []);
        const decisions: AiCandidateJudgment[] = [{
          guessIndex: 1,
          decision: "SELECT",
          candidateId: "owood-seoul",
          retryQueries: [],
          reason: "MATCH",
        }, {
          guessIndex: 2,
          decision: "RETRY",
          candidateId: null,
          retryQueries: ["우직 부산"],
          reason: "CANDIDATE_MISSING",
        }, {
          guessIndex: 3,
          decision: "RETRY",
          candidateId: null,
          retryQueries: ["윤숲 후르츠산도점", "윤숲"],
          reason: "CANDIDATE_MISSING",
        }, {
          guessIndex: 4,
          decision: "NONE",
          candidateId: null,
          retryQueries: [],
          reason: "INSUFFICIENT_CONTEXT",
        }];
        return Promise.resolve(decisions);
      },
    },
  );

  assertEquals(judgeCalls, 1);
  assertEquals(searchCalls, [
    "보연희",
    "오우드",
    "우직",
    "윤숲 후루츠산도점",
    "용용선생",
    "우직 부산",
    "윤숲 후르츠산도점",
  ]);
  assertEquals(result.matches.map((match) => match.guessIndex), [0, 1, 2, 3]);
  assertEquals(result.matches.map((match) => match.place.kakaoPlaceId), [
    "direct",
    "owood-seoul",
    "1595758078",
    "1775568752",
  ]);
  assertEquals(result.failures.map((failure) => failure.guessIndex), [4]);
});

Deno.test("resolves the 군자 bullet-list regression without weakening the final guard", async () => {
  const caption = [
    "📍 로컬타코야키",
    "• 서울 광진구 군자로 166 1층",
    "📍 윤숲 후루츠산도점",
    "• 서울 광진구 면목로7길 8 1층",
  ].join("\n");
  const guesses = sanitizePlaceGuesses([
    guess("로컬타코야키", "서울 광진구 군자로 166 1층", "서울"),
    guess("윤숲 후루츠산도점", "서울 광진구 면목로7길 8 1층", "서울"),
  ], caption);
  const local: KakaoPlace = {
    ...candidate(
      "1372748435",
      "로컬타코야끼 군자",
      "서울특별시 광진구 군자로 166",
    ),
    address: "서울특별시 광진구 군자동 45-41",
  };
  const yunsoop = candidate(
    "1775568752",
    "윤숲 후르츠산도점",
    "서울특별시 광진구 면목로7길 8",
  );
  const responses = new Map<string, KakaoPlace[]>([
    ["로컬타코야키", []],
    ["로컬타코야끼 군자", [local]],
    ["윤숲 후루츠산도점", []],
    ["윤숲 후르츠산도점", [yunsoop]],
  ]);
  const searchCalls: string[] = [];
  let judgeCalls = 0;

  const result = await resolvePlacesFromKakao(caption, guesses, {
    search(query) {
      searchCalls.push(query);
      return Promise.resolve(responses.get(query) ?? []);
    },
    judge(_caption, items) {
      judgeCalls += 1;
      assertEquals(items.map((item) => item.guessIndex), [0, 1]);
      return Promise.resolve([{
        guessIndex: 0,
        decision: "RETRY",
        candidateId: null,
        retryQueries: ["로컬타코야끼 군자"],
        reason: "CANDIDATE_MISSING",
      }, {
        guessIndex: 1,
        decision: "RETRY",
        candidateId: null,
        retryQueries: ["윤숲 후르츠산도점"],
        reason: "CANDIDATE_MISSING",
      }]);
    },
  });

  assertEquals(judgeCalls, 1);
  assertEquals(searchCalls, [
    "로컬타코야키",
    "윤숲 후루츠산도점",
    "로컬타코야끼 군자",
    "윤숲 후르츠산도점",
  ]);
  assertEquals(result.matches.map((match) => match.place.kakaoPlaceId), [
    "1372748435",
    "1775568752",
  ]);
  assertEquals(result.failures, []);
});

Deno.test("does not call AI review when every initial candidate is safe", async () => {
  let judgeCalls = 0;
  const result = await resolvePlacesFromKakao("보연희", [guess("보연희")], {
    search: () => Promise.resolve([candidate("direct", "보연희")]),
    judge: () => {
      judgeCalls += 1;
      return Promise.resolve([]);
    },
  });

  assertEquals(judgeCalls, 0);
  assertEquals(result.matches.map((match) => match.place.kakaoPlaceId), [
    "direct",
  ]);
});

Deno.test("finds an exact-address branch with address-centered keyword search", async () => {
  const source = guess(
    "동두천솥뚜껑삼겹살",
    "서울 강남구 테헤란로1길 20 2층",
    "서울",
  );
  const wrong = candidate(
    "wrong",
    "동두천솥뚜껑삼겹살 역삼점",
    "서울 강남구 테헤란로 123",
  );
  const exact = candidate(
    "312908843",
    "동두천솥뚜껑삼겹살 강남역점",
    "서울 강남구 테헤란로1길 20",
  );
  const calls: string[] = [];
  let judgeCalls = 0;

  const result = await resolvePlacesFromKakao(
    "동두천솥뚜껑삼겹살 서울 강남구 테헤란로1길 20 2층",
    [source],
    {
      search(query) {
        calls.push(`initial:${query}`);
        return Promise.resolve([wrong]);
      },
      geocodeAddress(address) {
        calls.push(`address:${address}`);
        return Promise.resolve([{
          latitude: 37.497942,
          longitude: 127.027621,
          roadAddress: "서울 강남구 테헤란로1길 20",
          address: "서울 강남구 역삼동 825-20",
        }]);
      },
      searchNearby(query, center) {
        calls.push(`nearby:${query}:${center.longitude},${center.latitude}`);
        return Promise.resolve([exact]);
      },
      judge() {
        judgeCalls += 1;
        return Promise.resolve([]);
      },
    },
  );

  assertEquals(calls, [
    "initial:동두천솥뚜껑삼겹살",
    "address:서울 강남구 테헤란로1길 20 2층",
    "nearby:동두천솥뚜껑삼겹살:127.027621,37.497942",
  ]);
  assertEquals(judgeCalls, 0);
  assertEquals(result.matches.map((match) => match.place.kakaoPlaceId), [
    "312908843",
  ]);
  assertEquals(result.failures, []);
});

Deno.test("skips address-centered search when the initial result has the exact address", async () => {
  const source = guess("춘식당", "서울 강남구 도산대로23길 17", "서울");
  const exact = candidate(
    "initial-exact",
    "춘식당",
    "서울 강남구 도산대로23길 17",
  );
  let geocodeCalls = 0;
  let nearbyCalls = 0;

  const result = await resolvePlacesFromKakao("춘식당", [source], {
    search: () => Promise.resolve([exact]),
    geocodeAddress: () => {
      geocodeCalls += 1;
      throw new Error("must not geocode");
    },
    searchNearby: () => {
      nearbyCalls += 1;
      throw new Error("must not search nearby");
    },
    judge: () => Promise.resolve([]),
  });

  assertEquals([geocodeCalls, nearbyCalls], [0, 0]);
  assertEquals(result.matches.map((match) => match.place.kakaoPlaceId), [
    "initial-exact",
  ]);
});

Deno.test("keeps the existing AI path when address-centered search fails", async () => {
  const source = guess("춘식당", "서울 강남구 도산대로23길 17", "서울");
  const wrong = candidate(
    "wrong",
    "춘식당 부산점",
    "부산 동래구 충렬대로 1",
  );
  const events: string[] = [];

  const result = await resolvePlacesFromKakao("춘식당", [source], {
    search: () => Promise.resolve([wrong]),
    geocodeAddress: () =>
      Promise.resolve([{
        latitude: 37.521,
        longitude: 127.028,
        roadAddress: "서울 강남구 도산대로23길 17",
        address: "서울 강남구 신사동 561-17",
      }]),
    searchNearby: () =>
      Promise.reject(new KakaoPlaceSearchError("SERVER", 503, true)),
    judge(_caption, items) {
      assertEquals(items[0].candidates, [wrong]);
      return Promise.resolve([{
        guessIndex: 0,
        decision: "NONE",
        candidateId: null,
        retryQueries: [],
        reason: "ADDRESS_CONFLICT",
      }]);
    },
    log(event) {
      events.push(event);
    },
  });

  assertEquals(result.matches, []);
  assertEquals(result.failures.map((failure) => failure.reason), [
    "ADDRESS_CONFLICT",
  ]);
  assertEquals(events.includes("kakao_address_nearby_search_skipped"), true);
});

Deno.test("skips non-matching or ambiguous address coordinates", async () => {
  const source = guess("춘식당", "서울 강남구 도산대로23길 17", "서울");
  const wrong = candidate("wrong", "춘식당 부산점", "부산 동래구 충렬대로 1");
  const exactCoordinate = {
    latitude: 37.521,
    longitude: 127.028,
    roadAddress: "서울 강남구 도산대로23길 17",
    address: "서울 강남구 신사동 561-17",
  };
  const cases = [
    [],
    [exactCoordinate, { ...exactCoordinate, longitude: 127.0281 }],
    [{
      ...exactCoordinate,
      roadAddress: "서울 강남구 도산대로23길 18",
      address: "서울 강남구 신사동 561-18",
    }],
  ];

  for (const coordinates of cases) {
    let nearbyCalls = 0;
    const result = await resolvePlacesFromKakao("춘식당", [source], {
      search: () => Promise.resolve([wrong]),
      geocodeAddress: () => Promise.resolve(coordinates),
      searchNearby: () => {
        nearbyCalls += 1;
        return Promise.resolve([]);
      },
      judge: () =>
        Promise.resolve([{
          guessIndex: 0,
          decision: "NONE",
          candidateId: null,
          retryQueries: [],
          reason: "ADDRESS_CONFLICT",
        }]),
    });
    assertEquals(nearbyCalls, 0);
    assertEquals(result.failures.map((failure) => failure.reason), [
      "ADDRESS_CONFLICT",
    ]);
  }
});

Deno.test("does not merge nearby candidates failing the address or name guard", async () => {
  const source = guess("춘식당", "서울 강남구 도산대로23길 17", "서울");
  const initial = candidate(
    "initial",
    "춘식당 부산점",
    "부산 동래구 충렬대로 1",
  );
  const nearbyWrongAddress = candidate(
    "nearby-wrong",
    "춘식당 신사점",
    "서울 강남구 도산대로23길 18",
  );
  const nearbyWrongName = candidate(
    "nearby-unrelated",
    "전혀다른식당",
    "서울 강남구 도산대로23길 17",
  );

  const result = await resolvePlacesFromKakao("춘식당", [source], {
    search: () => Promise.resolve([initial]),
    geocodeAddress: () =>
      Promise.resolve([{
        latitude: 37.521,
        longitude: 127.028,
        roadAddress: "서울 강남구 도산대로23길 17",
        address: "서울 강남구 신사동 561-17",
      }]),
    searchNearby: () => Promise.resolve([nearbyWrongAddress, nearbyWrongName]),
    judge(_caption, items) {
      assertEquals(items[0].candidates, [initial]);
      return Promise.resolve([{
        guessIndex: 0,
        decision: "NONE",
        candidateId: null,
        retryQueries: [],
        reason: "ADDRESS_CONFLICT",
      }]);
    },
  });

  assertEquals(result.failures.map((failure) => failure.reason), [
    "ADDRESS_CONFLICT",
  ]);
});

Deno.test("searches nearby when an initial exact-address tenant fails the name guard", async () => {
  const source = guess("춘식당", "서울 강남구 도산대로23길 17", "서울");
  const unrelatedTenant = candidate(
    "other-tenant",
    "전혀다른식당",
    "서울 강남구 도산대로23길 17",
  );
  const exact = candidate(
    "chunsik",
    "춘식당",
    "서울 강남구 도산대로23길 17",
  );
  let nearbyCalls = 0;

  const result = await resolvePlacesFromKakao("춘식당", [source], {
    search: () => Promise.resolve([unrelatedTenant]),
    geocodeAddress: () =>
      Promise.resolve([{
        latitude: 37.521,
        longitude: 127.028,
        roadAddress: "서울 강남구 도산대로23길 17",
        address: "서울 강남구 신사동 561-17",
      }]),
    searchNearby: () => {
      nearbyCalls += 1;
      return Promise.resolve([exact]);
    },
    judge(_caption, items) {
      assertEquals(items[0].candidates, [exact, unrelatedTenant]);
      return Promise.resolve([{
        guessIndex: 0,
        decision: "SELECT",
        candidateId: "chunsik",
        retryQueries: [],
        reason: "MATCH",
      }]);
    },
  });

  assertEquals(nearbyCalls, 1);
  assertEquals(result.matches.map((match) => match.place.kakaoPlaceId), [
    "chunsik",
  ]);
});

Deno.test("rethrows unexpected address-centered search errors", async () => {
  const source = guess("춘식당", "서울 강남구 도산대로23길 17", "서울");
  try {
    await resolvePlacesFromKakao("춘식당", [source], {
      search: () => Promise.resolve([]),
      geocodeAddress: () => Promise.reject(new TypeError("programming bug")),
      searchNearby: () => Promise.resolve([]),
      judge: () => Promise.resolve([]),
    });
  } catch (error) {
    assertEquals(error instanceof TypeError, true);
    assertEquals((error as Error).message, "programming bug");
    return;
  }
  throw new Error("Expected an unexpected error to be rethrown");
});

Deno.test("geocodes one shared detailed address only once per resolution", async () => {
  const sharedAddress = "서울 강남구 도산대로23길 17";
  const sources = [
    guess("춘식당", sharedAddress, "서울"),
    guess("카페온", sharedAddress, "서울"),
  ];
  const chunsik = candidate("chunsik", "춘식당", sharedAddress);
  const cafeOn = candidate("cafe-on", "카페온", sharedAddress);
  let geocodeCalls = 0;
  const nearbyCalls: string[] = [];

  const result = await resolvePlacesFromKakao(
    `춘식당 ${sharedAddress} / 카페온 ${sharedAddress}`,
    sources,
    {
      search: () => Promise.resolve([]),
      geocodeAddress: () => {
        geocodeCalls += 1;
        return Promise.resolve([{
          latitude: 37.521,
          longitude: 127.028,
          roadAddress: sharedAddress,
          address: "서울 강남구 신사동 561-17",
        }]);
      },
      searchNearby(query) {
        nearbyCalls.push(query);
        return Promise.resolve(query === "춘식당" ? [chunsik] : [cafeOn]);
      },
      judge: () => Promise.resolve([]),
    },
  );

  assertEquals(geocodeCalls, 1);
  assertEquals(nearbyCalls, ["춘식당", "카페온"]);
  assertEquals(result.matches.map((match) => match.place.kakaoPlaceId), [
    "chunsik",
    "cafe-on",
  ]);
});
