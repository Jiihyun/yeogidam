import type {
  AiCandidateJudgment,
  KakaoCandidateReviewItem,
  PlaceGuess,
} from "./ai/types.ts";
import type { KakaoPlace } from "./kakao.ts";
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
