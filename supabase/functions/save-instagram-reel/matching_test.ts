import type { PlaceGuess } from "./gemini.ts";
import {
  buildKakaoFallbackQueries,
  buildKakaoQueries,
  canUseNameOnlyKakaoFallback,
  classifyKakaoCandidates,
  resolveAiSelectedKakaoPlace,
  sanitizePlaceGuesses,
  verifiedKakaoPlaces,
} from "./matching.ts";
import type { KakaoPlace } from "./kakao.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function guess(
  placeName: string,
  address: string | null,
  region: string | null,
): PlaceGuess {
  return {
    placeName,
    address,
    addressType: address?.includes("로 ") ? "ROAD" : address ? "JIBUN" : "NONE",
    region,
  };
}

function candidate(
  id: string,
  name: string,
  roadAddress: string | null,
  address: string | null,
): KakaoPlace {
  return {
    kakaoPlaceId: id,
    name,
    category: null,
    roadAddress,
    address,
    latitude: null,
    longitude: null,
    placeUrl: null,
    telephone: null,
  };
}

Deno.test("keeps multiple literal Gemini places and drops hallucinated or broad brands", () => {
  const caption =
    `첫 번째는 키리\n광주 동구 동명동 200-188\n두 번째는 보연희\n서울 서대문구 연희맛로 17-63 2층\n용용선생 신메뉴`;
  const result = sanitizePlaceGuesses([
    guess("키리", "광주 동구 동명동 200-188", "동명동"),
    guess("보연희", "서울 서대문구 연희맛로 17-63 2층", "연희동"),
    guess("없는가게", "서울 강남구 테헤란로 1", "강남"),
    guess("용용선생", null, null),
  ], caption);

  assertEquals(result, [
    guess("키리", "광주 동구 동명동 200-188", "동명동"),
    guess("보연희", "서울 서대문구 연희맛로 17-63 2층", null),
  ]);
});

Deno.test("builds scoped Kakao queries and never a place-name-only query", () => {
  assertEquals(
    buildKakaoQueries(guess("키리", "광주 동구 동명동 200-188", "동명동")),
    [
      "키리 광주 동구 동명동 200-188",
      "동명동 키리",
      "광주 동구 동명동 200-188",
    ],
  );
  assertEquals(buildKakaoQueries(guess("용용선생", null, null)), []);
});

Deno.test("adds address-derived region queries for small-city Kakao search", () => {
  assertEquals(
    buildKakaoQueries(
      guess("만연에서", "전남 화순군 화순읍 동구리 199", null),
    ),
    [
      "만연에서 전남 화순군 화순읍 동구리 199",
      "화순군 만연에서",
      "전남 화순군 화순읍 동구리 199",
    ],
  );
  assertEquals(
    buildKakaoQueries(guess("어딘가", "서울 성동구 연무장길 12", null)),
    [
      "어딘가 서울 성동구 연무장길 12",
      "성동구 어딘가",
      "서울 성동구 연무장길 12",
    ],
  );
});

Deno.test("allows name-only fallback only with a verifiable street or lot address", () => {
  assertEquals(
    canUseNameOnlyKakaoFallback(
      guess("포티윙크스", "와우산로29길 26-8 가볼래빌딩 1층", "홍대"),
    ),
    true,
  );
  assertEquals(
    canUseNameOnlyKakaoFallback(
      guess("바람따라", "동구 동명로 79", "동구"),
    ),
    true,
  );
  assertEquals(
    canUseNameOnlyKakaoFallback(guess("연하동", null, "혜화")),
    false,
  );
  assertEquals(
    canUseNameOnlyKakaoFallback(guess("어딘가", "서울 마포구", "마포구")),
    false,
  );
  assertEquals(
    buildKakaoFallbackQueries(
      guess("포티윙크스", "와우산로29길 26-8 가볼래빌딩 1층", "홍대"),
    ),
    ["포티윙크스"],
  );
  assertEquals(
    buildKakaoFallbackQueries(guess("연하동", null, "혜화")),
    [],
  );
});

Deno.test("strongly verifies name-only fallback candidates against the full address", () => {
  const source = guess(
    "포티윙크스",
    "와우산로29길 26-8 가볼래빌딩 1층",
    "홍대",
  );
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "right",
      "포티윙크스",
      "서울특별시 마포구 와우산로29길 26-8",
      "서울특별시 마포구 서교동 328-63",
    ),
    candidate(
      "same-number-wrong-road",
      "포티윙크스",
      "서울특별시 마포구 동교로 26-8",
      null,
    ),
  ], { requireStrongAddressEvidence: true });

  assertEquals(result.map((place) => place.kakaoPlaceId), ["right"]);
});

Deno.test("strongly verifies a partial-region fallback at its exact street address", () => {
  const source = guess("바람따라", "동구 동명로 79", "동구");
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "right",
      "바람따라",
      "전남광주통합특별시 동구 동명로 79",
      "전남광주통합특별시 동구 지산동 722-27",
    ),
    candidate(
      "longer-name",
      "바람따라구름따라",
      "대구광역시 달서구 진천로10길 38",
      null,
    ),
  ], { requireStrongAddressEvidence: true });

  assertEquals(result.map((place) => place.kakaoPlaceId), ["right"]);
});

Deno.test("keeps name-only fallback ambiguous when the caption omits the city", () => {
  const source = guess("바람따라", "동구 동명로 79", "동구");
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "gwangju",
      "바람따라",
      "전남광주통합특별시 동구 동명로 79",
      null,
    ),
    candidate(
      "other-city",
      "바람따라",
      "부산광역시 동구 동명로 79",
      null,
    ),
  ], { requireStrongAddressEvidence: true });

  assertEquals(
    result.map((place) => place.kakaoPlaceId),
    ["gwangju", "other-city"],
  );
});

Deno.test("does not mistake a trailing place name ending in 도 for a province", () => {
  const source = guess(
    "문화산도",
    "서울 강북구 덕릉로19길 8 1층 문화산도",
    "서울 강북구",
  );
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "culture-sando",
      "문화산도",
      "서울특별시 강북구 덕릉로19길 8",
      "서울특별시 강북구 수유동 47-14",
    ),
  ]);

  assertEquals(result.map((place) => place.kakaoPlaceId), ["culture-sando"]);
});

Deno.test("rejects Kiri X in Seoul and accepts Kiri at the caption address", () => {
  const source = guess("키리", "광주 동구 동명동 200-188", "동명동");
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "wrong",
      "키리엑스",
      "서울특별시 중구 서소문로 116",
      "서울특별시 중구 서소문동 75",
    ),
    candidate(
      "right",
      "키리",
      "광주광역시 동구 동명로 10",
      "광주광역시 동구 동명동 200-188",
    ),
  ]);

  assertEquals(result.map((place) => place.kakaoPlaceId), ["right"]);
});

Deno.test("accepts a Kakao branch suffix but keeps ambiguous matches visible", () => {
  const source = guess("연하동", null, "혜화");
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "one",
      "연하동 대학로점",
      "서울특별시 종로구 대학로11길 43",
      null,
    ),
    candidate(
      "two",
      "연하동 대학로2호점",
      "서울특별시 종로구 대학로12길 1",
      null,
    ),
  ]);

  assertEquals(result.map((place) => place.kakaoPlaceId), ["one", "two"]);
});

Deno.test("accepts a one-character place-name typo at the exact road address", () => {
  const source = guess(
    "파티세르시즈널",
    "광산구 수완로52번길 46-13 1층",
    "전남광주",
  );
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "seasonal",
      "파티세리시즈널",
      "전남광주통합특별시 광산구 수완로52번길 46-13",
      "전남광주통합특별시 광산구 수완동 1706",
    ),
  ]);

  assertEquals(result.map((place) => place.kakaoPlaceId), ["seasonal"]);
});

Deno.test("accepts adjacent road-number transposition with one-character name typo", () => {
  const source = guess(
    "브래드누아젯",
    "광산구 수완로160번길 40",
    "전남광주",
  );
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "noisette",
      "브레드누아젯",
      "전남광주통합특별시 광산구 수완로106번길 40",
      "전남광주통합특별시 광산구 수완동 1280",
    ),
  ]);

  assertEquals(result.map((place) => place.kakaoPlaceId), ["noisette"]);
});

Deno.test("rejects fuzzy place names without strong address agreement", () => {
  const source = guess(
    "브래드누아젯",
    "광산구 수완로160번길 40",
    "전남광주",
  );
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "different-road",
      "브레드누아젯",
      "전남광주통합특별시 광산구 임방울대로 40",
      null,
    ),
    candidate(
      "different-number",
      "브레드누아젯",
      "전남광주통합특별시 광산구 수완로106번길 41",
      null,
    ),
    candidate(
      "short-name",
      "키라",
      "광주광역시 동구 동명로 10",
      "광주광역시 동구 동명동 200-188",
    ),
  ]);

  assertEquals(result, []);
});

Deno.test("does not treat a building number substring as the same address", () => {
  const source = guess(
    "보연희",
    "서울 서대문구 연희맛로 17-63 2층",
    "연희동",
  );
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "wrong-building",
      "보연희",
      "서울특별시 서대문구 연희맛로 117-63",
      null,
    ),
  ]);

  assertEquals(result, []);
});

Deno.test("does not satisfy a road number with the candidate lot number", () => {
  const source = guess(
    "문화산도",
    "서울 강북구 덕릉로19길 47-14",
    "서울 강북구",
  );
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "wrong-road-number",
      "문화산도",
      "서울특별시 강북구 덕릉로19길 8",
      "서울특별시 강북구 수유동 47-14",
    ),
  ]);

  assertEquals(result, []);
});

Deno.test("matches administrative regions as tokens, not substrings", () => {
  const source = guess("온리", "남구 중앙로 12", "남구");
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "gangnam",
      "온리",
      "서울특별시 강남구 중앙로 12",
      null,
    ),
    candidate(
      "namgu",
      "온리",
      "부산광역시 남구 중앙로 12",
      null,
    ),
  ]);

  assertEquals(result.map((place) => place.kakaoPlaceId), ["namgu"]);
});

Deno.test("matches region-only guesses as tokens, not substrings", () => {
  const source = guess("온리", null, "남구");
  const result = verifiedKakaoPlaces(source, [
    candidate(
      "gangnam",
      "온리",
      "서울특별시 강남구 중앙로 12",
      null,
    ),
    candidate(
      "namgu",
      "온리",
      "부산광역시 남구 중앙로 12",
      null,
    ),
  ]);

  assertEquals(result.map((place) => place.kakaoPlaceId), ["namgu"]);
});

Deno.test("classifies zero, unique, and ambiguous Kakao candidate states", () => {
  const source = guess(
    "문화산도",
    "서울 강북구 덕릉로19길 8 1층 문화산도",
    "서울 강북구",
  );
  const right = candidate(
    "culture-sando",
    "문화산도",
    "서울특별시 강북구 덕릉로19길 8",
    "서울특별시 강북구 수유동 47-14",
  );

  assertEquals(classifyKakaoCandidates(source, []), {
    type: "NO_CANDIDATE",
  });
  assertEquals(classifyKakaoCandidates(source, [right]), {
    type: "AUTO_MATCH",
    place: right,
  });

  const needsReview = classifyKakaoCandidates(source, [
    candidate(
      "unverified",
      "문화산도베이커리",
      "서울특별시 강북구 덕릉로19길 8",
      "서울특별시 강북구 수유동 47-14",
    ),
  ]);
  assertEquals(needsReview.type, "NEEDS_AI_REVIEW");
  if (needsReview.type === "NEEDS_AI_REVIEW") {
    assertEquals(needsReview.reason, "NO_VERIFIED_CANDIDATE");
    assertEquals(
      needsReview.candidates.map((place) => place.kakaoPlaceId),
      ["unverified"],
    );
  }
});

Deno.test("sends only deterministically verified places to AI when multiple pass", () => {
  const source = guess("연하동", null, "혜화");
  const decision = classifyKakaoCandidates(source, [
    candidate(
      "one",
      "연하동 대학로점",
      "서울특별시 종로구 대학로11길 43",
      null,
    ),
    candidate(
      "two",
      "연하동 대학로2호점",
      "서울특별시 종로구 대학로12길 1",
      null,
    ),
    candidate(
      "irrelevant",
      "다른가게",
      "서울특별시 종로구 대학로11길 43",
      null,
    ),
  ]);

  assertEquals(decision.type, "NEEDS_AI_REVIEW");
  if (decision.type === "NEEDS_AI_REVIEW") {
    assertEquals(decision.reason, "MULTIPLE_VERIFIED_CANDIDATES");
    assertEquals(
      decision.candidates.map((place) => place.kakaoPlaceId),
      ["one", "two"],
    );
  }
});

Deno.test("final AI guard accepts a literal Kakao candidate at the same address", () => {
  const source = guess(
    "문화산도",
    "서울 강북구 덕릉로19길 8 1층 문화산도",
    "서울 강북구",
  );
  const selected = candidate(
    "culture-sando",
    "문화산도베이커리",
    "서울특별시 강북구 덕릉로19길 8",
    "서울특별시 강북구 수유동 47-14",
  );

  assertEquals(resolveAiSelectedKakaoPlace(source, [selected], selected.kakaoPlaceId), {
    status: "ACCEPTED",
    place: selected,
  });
});

Deno.test("final AI guard rejects invented IDs and hard address conflicts", () => {
  const source = guess(
    "문화산도",
    "서울 강북구 덕릉로19길 8 1층 문화산도",
    "서울 강북구",
  );
  const wrongRoad = candidate(
    "wrong-road",
    "문화산도",
    "서울특별시 강북구 도봉로19길 8",
    "서울특별시 강북구 수유동 47-14",
  );
  const wrongBuilding = candidate(
    "wrong-building",
    "문화산도",
    "서울특별시 강북구 덕릉로19길 80",
    "서울특별시 강북구 수유동 47-14",
  );
  const wrongRegion = candidate(
    "wrong-region",
    "문화산도",
    "부산광역시 강서구 덕릉로19길 8",
    null,
  );

  assertEquals(resolveAiSelectedKakaoPlace(source, [wrongRoad], "invented"), {
    status: "REJECTED",
    reason: "AI_SELECTED_UNKNOWN_CANDIDATE",
  });
  assertEquals(resolveAiSelectedKakaoPlace(source, [wrongRoad], "wrong-road"), {
    status: "REJECTED",
    reason: "ROAD_CONFLICT",
  });
  assertEquals(
    resolveAiSelectedKakaoPlace(source, [wrongBuilding], "wrong-building"),
    { status: "REJECTED", reason: "BUILDING_NUMBER_CONFLICT" },
  );
  assertEquals(
    resolveAiSelectedKakaoPlace(source, [wrongRegion], "wrong-region"),
    { status: "REJECTED", reason: "REGION_CONFLICT" },
  );
});

Deno.test("final AI guard rejects an unrelated store even at the same address", () => {
  const source = guess(
    "문화산도",
    "서울 강북구 덕릉로19길 8",
    "서울 강북구",
  );
  const unrelated = candidate(
    "unrelated",
    "완전다른가게",
    "서울특별시 강북구 덕릉로19길 8",
    "서울특별시 강북구 수유동 47-14",
  );

  assertEquals(
    resolveAiSelectedKakaoPlace(source, [unrelated], "unrelated"),
    { status: "REJECTED", reason: "NAME_MISMATCH" },
  );
});

Deno.test("final AI guard rejects unresolved same-name places across cities", () => {
  const source = guess("바람따라", "동구 동명로 79", "동구");
  const candidates = [
    candidate(
      "gwangju",
      "바람따라",
      "광주광역시 동구 동명로 79",
      null,
    ),
    candidate(
      "busan",
      "바람따라",
      "부산광역시 동구 동명로 79",
      null,
    ),
  ];

  assertEquals(
    resolveAiSelectedKakaoPlace(source, candidates, "gwangju", {
      requireStrongAddressEvidence: true,
    }),
    { status: "REJECTED", reason: "UNRESOLVED_MULTI_REGION" },
  );
});

Deno.test("final AI guard keeps multi-region protection for partial addresses", () => {
  const source = guess("바람따라", "동구", "동구");
  const candidates = [
    candidate(
      "gwangju",
      "바람따라",
      "광주광역시 동구 동명로 79",
      null,
    ),
    candidate(
      "busan",
      "바람따라",
      "부산광역시 동구 중앙대로 79",
      null,
    ),
  ];

  assertEquals(
    resolveAiSelectedKakaoPlace(source, candidates, "gwangju"),
    { status: "REJECTED", reason: "UNRESOLVED_MULTI_REGION" },
  );
});

Deno.test("name-only expansion requires positive full-address evidence after AI", () => {
  const source = guess(
    "포티윙크스",
    "와우산로29길 26-8 가볼래빌딩 1층",
    "홍대",
  );
  const right = candidate(
    "right",
    "포티윙크스",
    "서울특별시 마포구 와우산로29길 26-8",
    "서울특별시 마포구 서교동 328-63",
  );
  const noAddress = candidate("no-address", "포티윙크스", null, null);
  const options = { requireStrongAddressEvidence: true };

  assertEquals(
    resolveAiSelectedKakaoPlace(source, [right], "right", options),
    { status: "ACCEPTED", place: right },
  );
  assertEquals(
    resolveAiSelectedKakaoPlace(source, [noAddress], "no-address", options),
    { status: "REJECTED", reason: "INSUFFICIENT_ADDRESS_EVIDENCE" },
  );
});
