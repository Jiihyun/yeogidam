import type { PlaceGuess } from "./gemini.ts";
import {
  buildKakaoQueries,
  classifyKakaoCandidates,
  deduplicateKakaoPlaces,
  groundedRetryQueries,
  hasDetailedAddressEvidence,
  locationMatchedKakaoPlaces,
  placeNamesCompatible,
  resolveAiSelectedKakaoPlace,
  resolveRetriedKakaoPlace,
  sanitizePlaceGuesses,
  withCaptionRegionHints,
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

Deno.test("keeps grounded name-only guesses and nulls ungrounded location fields", () => {
  const caption =
    "카페-노티드 다녀왔어요. 서울 서대문구 연희맛로 17-63에 있는 보연희도 추천!";
  const result = sanitizePlaceGuesses([
    guess("카페노티드", null, null),
    guess("보연희", "서울 서대문구 연희맛로 17-63", "연희동"),
    guess("없는가게", null, null),
  ], caption);

  assertEquals(result, [
    guess("카페노티드", null, null),
    guess("보연희", "서울 서대문구 연희맛로 17-63", null),
  ]);
});

Deno.test("ignores name hyphens without erasing address hyphens", () => {
  const caption = "카페-노티드 주소는 서울 서대문구 연희맛로 17-63";
  const result = sanitizePlaceGuesses([
    guess("카페노티드", "서울 서대문구 연희맛로 1763", null),
  ], caption);

  assertEquals(result, [guess("카페노티드", null, null)]);
});

Deno.test("builds one place-name Kakao query regardless of location evidence", () => {
  assertEquals(
    buildKakaoQueries(guess("키리", "광주 동구 동명동 200-188", "동명동")),
    ["키리"],
  );
  assertEquals(buildKakaoQueries(guess("연하동", null, "혜화")), ["연하동"]);
  assertEquals(buildKakaoQueries(guess("  오우드  ", null, null)), ["오우드"]);
});

Deno.test("keeps detailed-address detection separate from Kakao fallback", () => {
  assertEquals(
    hasDetailedAddressEvidence(
      guess("포티윙크스", "와우산로29길 26-8 가볼래빌딩 1층", "홍대"),
    ),
    true,
  );
  assertEquals(
    hasDetailedAddressEvidence(guess("바람따라", "동구 동명로 79", "동구")),
    true,
  );
  assertEquals(
    hasDetailedAddressEvidence(guess("연하동", null, "혜화")),
    false,
  );
});

Deno.test("deduplicates repeated Kakao results by place ID", () => {
  const first = candidate("same", "오우드", null, null);
  const duplicate = candidate("same", "오우드 성수점", null, null);
  const other = candidate("other", "다른가게", null, null);

  assertEquals(deduplicateKakaoPlaces([first, duplicate, other]), [
    first,
    other,
  ]);
});

Deno.test("classifies zero raw Kakao candidates as not found", () => {
  assertEquals(classifyKakaoCandidates(guess("오우드", null, null), []), {
    type: "NO_CANDIDATE",
  });
});

Deno.test("does not auto-match one candidate that conflicts with the extracted address", () => {
  const only = candidate(
    "only",
    "브레드누아젯",
    "부산광역시 수영구 광남로 12",
    null,
  );
  assertEquals(
    classifyKakaoCandidates(
      guess("브래드 누아젯", "서울 성동구 연무장길 12", "서울"),
      [only],
    ),
    { type: "NEEDS_AI_REVIEW", candidates: [only] },
  );
});

Deno.test("does not treat arbitrary short-name prefixes as the same place", () => {
  const icarus = candidate("icarus", "이카루스", null, null);
  assertEquals(placeNamesCompatible("이카", "이카루스"), false);
  assertEquals(classifyKakaoCandidates(guess("이카", null, null), [icarus]), {
    type: "NEEDS_AI_REVIEW",
    candidates: [icarus],
  });
  assertEquals(
    sanitizePlaceGuesses(
      [guess("이카", null, null)],
      "오늘은 이카루스 카페를 방문",
    ),
    [],
  );
});

Deno.test("does not treat added location or facility tokens as fuzzy typos", () => {
  assertEquals(
    placeNamesCompatible(
      "윤숲 후루츠산도점",
      "윤숲 후루츠산도점 부산",
    ),
    false,
  );
  for (const suffix of ["회관", "센터", "입구", "시장"]) {
    assertEquals(
      classifyKakaoCandidates(
        guess("기장 대변항 해녀촌", null, null),
        [candidate("facility", `기장 대변항 해녀촌 ${suffix}`, null, null)],
      ).type,
      "NEEDS_AI_REVIEW",
    );
  }
  for (
    const [source, target] of [
      ["기장 대변항 해녀촌", "기장 대변항 해녀촌관"],
      ["미쁘동", "미쁘동관"],
      ["이카", "이카관"],
    ]
  ) {
    assertEquals(placeNamesCompatible(source, target), false);
  }
});

Deno.test("does not auto-select an unspecified chain branch or area facility", () => {
  const chain = candidate(
    "chain",
    "용용선생 부산점",
    "부산광역시 부산진구 중앙대로 1",
    null,
  );
  const parking = candidate(
    "parking",
    "대변항 해녀촌 주차장",
    "부산광역시 기장군 기장해안로 1",
    null,
  );
  assertEquals(
    classifyKakaoCandidates(guess("용용선생", null, null), [chain]),
    {
      type: "NEEDS_AI_REVIEW",
      candidates: [chain],
    },
  );
  assertEquals(
    classifyKakaoCandidates(guess("대변항 해녀촌", null, null), [parking]),
    { type: "NEEDS_AI_REVIEW", candidates: [parking] },
  );
});

Deno.test("treats duplicate copies of one Kakao ID as one auto-match candidate", () => {
  const first = candidate("same", "오우드", null, null);
  const duplicate = candidate("same", "오우드 성수점", null, null);
  assertEquals(
    classifyKakaoCandidates(guess("오우드", null, null), [first, duplicate]),
    { type: "AUTO_MATCH", place: first },
  );
});

Deno.test("auto-matches the only candidate at the extracted road address", () => {
  const source = guess(
    "브래드누아젯",
    "광산구 수완로160번길 40",
    "광산구",
  );
  const right = candidate(
    "right",
    "브레드누아젯",
    "광주광역시 광산구 수완로160번길 40",
    null,
  );
  const wrong = candidate(
    "wrong",
    "브래드누아젯 본점",
    "광주광역시 광산구 임방울대로 40",
    null,
  );

  assertEquals(classifyKakaoCandidates(source, [wrong, right]), {
    type: "AUTO_MATCH",
    place: right,
  });
});

Deno.test("does not auto-match when extracted address and region conflict", () => {
  const source = guess("온리", "중앙로 12", "부산 남구");
  const candidates = [
    candidate(
      "same-road",
      "온리 서울점",
      "서울특별시 강남구 중앙로 12",
      null,
    ),
    candidate(
      "same-region",
      "온리 부산점",
      "부산광역시 남구 수영로 9",
      null,
    ),
  ];

  assertEquals(locationMatchedKakaoPlaces(source, candidates), []);
  assertEquals(classifyKakaoCandidates(source, candidates), {
    type: "NEEDS_AI_REVIEW",
    candidates,
  });
});

Deno.test("parses a road name joined directly to its building number", () => {
  const source = guess("오우드", "연무장길12", null);
  const right = candidate(
    "right",
    "오우드",
    "서울특별시 성동구 연무장길 12",
    null,
  );
  const sameNumber = candidate(
    "same-number",
    "오우드 부산점",
    "부산광역시 수영구 광남로 12",
    null,
  );

  assertEquals(locationMatchedKakaoPlaces(source, [sameNumber, right]), [
    right,
  ]);
  assertEquals(classifyKakaoCandidates(source, [sameNumber, right]), {
    type: "AUTO_MATCH",
    place: right,
  });
});

Deno.test("does not use a building number as the only location evidence", () => {
  const source = guess("오우드", "12", null);
  const candidates = [
    candidate("seoul", "오우드", "서울특별시 성동구 연무장길 12", null),
    candidate("busan", "오우드 부산점", "부산광역시 수영구 광남로 13", null),
  ];

  assertEquals(locationMatchedKakaoPlaces(source, candidates), []);
  assertEquals(classifyKakaoCandidates(source, candidates), {
    type: "NEEDS_AI_REVIEW",
    candidates,
  });
});

Deno.test("auto-matches the only candidate in an extracted administrative region", () => {
  const source = guess("온리", null, "남구");
  const gangnam = candidate(
    "gangnam",
    "온리 서울점",
    "서울특별시 강남구 중앙로 12",
    null,
  );
  const namgu = candidate(
    "namgu",
    "온리 부산점",
    "부산광역시 남구 중앙로 12",
    null,
  );

  assertEquals(classifyKakaoCandidates(source, [gangnam, namgu]), {
    type: "AUTO_MATCH",
    place: namgu,
  });
});

Deno.test("sends all multiple candidates to AI when location evidence is absent", () => {
  const source = guess("오우드", null, null);
  const candidates = [
    candidate("seoul", "오우드 성수점", "서울특별시 성동구 연무장길 12", null),
    candidate("busan", "오우드 부산점", "부산광역시 수영구 광남로 12", null),
  ];

  assertEquals(classifyKakaoCandidates(source, candidates), {
    type: "NEEDS_AI_REVIEW",
    candidates,
  });
});

Deno.test("sends all candidates to AI when partial location cannot select one", () => {
  const source = guess("바람따라", null, "성수");
  const candidates = [
    candidate("one", "바람따라", "서울특별시 성동구 연무장길 12", null),
    candidate("two", "바람따라 카페", "서울특별시 성동구 아차산로 12", null),
  ];

  assertEquals(locationMatchedKakaoPlaces(source, candidates), []);
  assertEquals(classifyKakaoCandidates(source, candidates), {
    type: "NEEDS_AI_REVIEW",
    candidates,
  });
});

Deno.test("sends the raw list to AI when multiple candidates share the address", () => {
  const source = guess("오우드", "서울 성동구 연무장길 12", "서울");
  const candidates = [
    candidate("one", "오우드", "서울특별시 성동구 연무장길 12", null),
    candidate("two", "오우드 성수점", "서울특별시 성동구 연무장길 12", null),
    candidate("three", "다른가게", "부산광역시 수영구 광남로 12", null),
  ];

  assertEquals(classifyKakaoCandidates(source, candidates), {
    type: "NEEDS_AI_REVIEW",
    candidates,
  });
});

Deno.test("does not auto-select an adjacent road-number transposition", () => {
  const source = guess("브래드누아젯", "광산구 수완로160번길 40", "광산구");
  const transposed = candidate(
    "transposed",
    "브레드누아젯",
    "광주광역시 광산구 수완로106번길 40",
    null,
  );
  const other = candidate(
    "other",
    "브래드누아젯 본점",
    "광주광역시 광산구 임방울대로 40",
    null,
  );

  assertEquals(locationMatchedKakaoPlaces(source, [transposed, other]), []);
  assertEquals(
    classifyKakaoCandidates(source, [transposed, other]).type,
    "NEEDS_AI_REVIEW",
  );
});

Deno.test("does not match a building number by substring", () => {
  const source = guess("오우드", "서울 성동구 연무장길 17-63", "서울");
  const substring = candidate(
    "substring",
    "오우드",
    "서울특별시 성동구 연무장길 117-63",
    null,
  );
  const other = candidate(
    "other",
    "오우드 성수점",
    "서울특별시 성동구 연무장길 18",
    null,
  );

  assertEquals(locationMatchedKakaoPlaces(source, [substring, other]), []);
});

Deno.test("passes all fifteen Kakao keyword candidates to AI review", () => {
  const candidates = Array.from(
    { length: 15 },
    (_, index) => candidate(String(index), `오우드 ${index}`, null, null),
  );
  const decision = classifyKakaoCandidates(
    guess("오우드", null, null),
    candidates,
  );
  assertEquals(decision.type, "NEEDS_AI_REVIEW");
  if (decision.type === "NEEDS_AI_REVIEW") {
    assertEquals(decision.candidates.length, 15);
  }
});

Deno.test("accepts a compatible Gemini-selected candidate from the supplied allowlist", () => {
  const selected = candidate(
    "selected",
    "Candy 성수점",
    "서울특별시 성동구 연무장길 12",
    null,
  );
  const other = candidate(
    "other",
    "켄디 부산점",
    "부산광역시 수영구 광남로 12",
    null,
  );

  assertEquals(
    resolveAiSelectedKakaoPlace(
      guess("Candy", "서울 성동구 연무장길 12", "서울"),
      [selected, other],
      "selected",
    ),
    {
      status: "ACCEPTED",
      place: selected,
    },
  );
});

Deno.test("allows a narrow Hangul-Latin transliteration without bypassing name checks", () => {
  const source = guess("오우드", null, null);
  const oud = candidate(
    "oud",
    "OUD",
    "서울특별시 성동구 연무장길 12",
    null,
  );
  assertEquals(resolveAiSelectedKakaoPlace(source, [oud], "oud"), {
    status: "ACCEPTED",
    place: oud,
  });

  const unrelated = candidate(
    "unrelated",
    "전혀다른가게",
    "서울특별시 성동구 연무장길 12",
    null,
  );
  assertEquals(
    resolveAiSelectedKakaoPlace(
      guess("오우드", "서울 성동구 연무장길 12", "서울"),
      [unrelated],
      "unrelated",
    ),
    { status: "REJECTED", reason: "NAME_MISMATCH" },
  );
});

Deno.test("rejects a Gemini candidate ID that was not supplied", () => {
  const candidateList = [candidate("known", "오우드", null, null)];
  assertEquals(
    resolveAiSelectedKakaoPlace(
      guess("오우드", null, null),
      candidateList,
      "invented",
    ),
    {
      status: "REJECTED",
      reason: "AI_SELECTED_UNKNOWN_CANDIDATE",
    },
  );
});

Deno.test("allows only caption-grounded Kakao retry queries", () => {
  const woozik = guess("우직", null, null);
  const caption = "#부산신상카페 오늘은 @woozik.busan 우직에 다녀왔어요";
  assertEquals(
    groundedRetryQueries(woozik, caption, [
      "우직 부산",
      "우직 서울",
      "다른가게 부산",
      " 우직   부산 ",
    ]),
    ["우직 부산"],
  );
  assertEquals(
    groundedRetryQueries(woozik, "@woozik.busan 우직에 다녀왔어요", [
      "우직 부산",
      "부산 우직",
    ]),
    ["우직 부산"],
  );
  assertEquals(
    groundedRetryQueries(
      guess("@woozik.busan", null, null),
      "오늘의 카페 @woozik.busan",
      ["우직 부산"],
    ),
    ["우직 부산"],
  );

  const yunsoop = guess(
    "윤숲 후루츠산도점",
    "서울 중랑구 면목로7길 8",
    "서울",
  );
  assertEquals(
    groundedRetryQueries(yunsoop, "윤숲 후루츠산도점 서울 중랑구 면목로7길 8", [
      "윤숲 후르츠산도점",
      "윤숲",
    ]),
    ["윤숲 후르츠산도점"],
  );
  assertEquals(placeNamesCompatible("후루츠산도점", "후르츠산도점"), true);
});

Deno.test("does not absorb a fabricated region into a long corrected name", () => {
  assertEquals(
    groundedRetryQueries(
      guess("윤숲 후루츠산도점", null, null),
      "윤숲 후루츠산도점 맛있어요",
      ["윤숲 후루츠산도점 부산"],
    ),
    [],
  );
});

Deno.test("does not borrow another place segment region for a retry", () => {
  for (
    const caption of [
      "우직 소개 / 다른 장소는 서울",
      "우직 소개. 다른 장소는 서울",
      "우직 소개, 다음은 서울 오우드",
      "📍우직 @woozik.busan 📍다른장소 서울",
    ]
  ) {
    assertEquals(
      groundedRetryQueries(guess("우직", null, null), caption, ["우직 서울"]),
      [],
    );
  }
  assertEquals(
    groundedRetryQueries(
      guess("기장 대변항 해녀촌", null, null),
      "기장 대변항 해녀촌에 다녀왔어요",
      ["기장"],
    ),
    [],
  );
});

Deno.test("does not interpret store names or prose endings as caption regions", () => {
  assertEquals(
    withCaptionRegionHints(guess("미쁘동", null, null), "#미쁘동 #부산맛집")
      .region,
    "부산",
  );
  assertEquals(
    withCaptionRegionHints(
      guess("우직", null, null),
      "우직에서 맛있는 요리로 하루 마무리",
    ).region,
    null,
  );
  for (
    const caption of [
      "우직 대구탕 맛집",
      "우직 서울우유 디저트",
      "우직 부산물 활용 메뉴",
      "우직 과일 광주리 선물",
      "우직 경기장 근처",
      "우직\n서울 오우드",
    ]
  ) {
    assertEquals(
      withCaptionRegionHints(guess("우직", null, null), caption, ["우직"])
        .region,
      null,
    );
  }
  assertEquals(
    groundedRetryQueries(
      guess("미쁘동", null, null),
      "#미쁘동 #부산맛집",
      ["미쁘동 부산"],
    ),
    ["미쁘동 부산"],
  );
  assertEquals(
    groundedRetryQueries(
      guess("우직", null, null),
      "우직 부산 전포동",
      ["우직 부산 전포동"],
    ),
    ["우직 부산 전포동"],
  );
});

Deno.test("uses a place-local broad region for initial and SELECT validation", () => {
  const source = withCaptionRegionHints(
    guess("미쁘동", null, null),
    "#부산맛집 #미쁘동",
    ["미쁘동"],
  );
  const seoul = candidate(
    "seoul",
    "미쁘동",
    "서울특별시 마포구 월드컵로 1",
    null,
  );
  assertEquals(source.region, "부산");
  assertEquals(
    classifyKakaoCandidates(source, [seoul]).type,
    "NEEDS_AI_REVIEW",
  );
  assertEquals(resolveAiSelectedKakaoPlace(source, [seoul], "seoul"), {
    status: "REJECTED",
    reason: "ADDRESS_CONFLICT",
  });
});

Deno.test("keeps extracted location evidence with its nearest place", () => {
  const sanitized = sanitizePlaceGuesses([
    guess("우직", "서울 성동구 연무장길 12", "서울"),
    guess("오우드", "서울 성동구 연무장길 12", "서울"),
  ], "우직 소개, 다음은 서울 성동구 연무장길 12 오우드");
  assertEquals(sanitized[0].address, null);
  assertEquals(sanitized[0].region, null);
  assertEquals(sanitized[1].address, "서울 성동구 연무장길 12");
  assertEquals(sanitized[1].region, "서울");

  const storeNameAsAddress = sanitizePlaceGuesses([
    guess("미쁘동", "미쁘동", "미쁘동"),
  ], "미쁘동 다녀왔어요");
  assertEquals(storeNameAsAddress[0].address, null);
  assertEquals(storeNameAsAddress[0].region, null);
});

Deno.test("rejects invented chain branches in SELECT and RETRY", () => {
  const source = guess("용용선생", null, null);
  const busan = candidate(
    "busan",
    "용용선생 부산점",
    "부산광역시 부산진구 중앙대로 1",
    null,
  );
  assertEquals(resolveAiSelectedKakaoPlace(source, [busan], "busan"), {
    status: "REJECTED",
    reason: "INSUFFICIENT_CONTEXT",
  });
  assertEquals(
    groundedRetryQueries(source, "용용선생 맛있어요", [
      "용용선생 부산점",
      "용용선생 강남점",
      "용용선생 본점",
    ]),
    [],
  );
  assertEquals(
    groundedRetryQueries(source, "용용선생 부산 점심 맛집", [
      "용용선생 부산점",
    ]),
    [],
  );
  assertEquals(
    groundedRetryQueries(
      source,
      "용용선생 콜라보 다른브랜드 부산점은 신메뉴",
      ["용용선생 부산점"],
    ),
    [],
  );
  assertEquals(
    groundedRetryQueries(source, "용용선생 부산", ["용용선생 부산"]),
    ["용용선생 부산"],
  );
  assertEquals(
    resolveRetriedKakaoPlace(source, ["용용선생 부산"], [busan]),
    { status: "ACCEPTED", place: busan },
  );

  const seomyeon = candidate(
    "seomyeon",
    "용용선생 서면점",
    "부산광역시 부산진구 중앙대로 2",
    null,
  );
  const busanSource = guess("용용선생", null, "부산");
  assertEquals(
    classifyKakaoCandidates(busanSource, [seomyeon]).type,
    "NEEDS_AI_REVIEW",
  );
  assertEquals(
    resolveAiSelectedKakaoPlace(busanSource, [seomyeon], "seomyeon"),
    {
      status: "REJECTED",
      reason: "INSUFFICIENT_CONTEXT",
    },
  );
  assertEquals(
    resolveAiSelectedKakaoPlace(
      source,
      [seomyeon],
      "seomyeon",
      "용용선생 서면점",
    ),
    { status: "ACCEPTED", place: seomyeon },
  );
});

Deno.test("requires an exact matching handle name and city segment", () => {
  assertEquals(placeNamesCompatible("우진", "UZIN"), false);
  assertEquals(
    groundedRetryQueries(
      guess("@woozik.busan", null, null),
      "@woozik.busan",
      ["우진 부산"],
    ),
    [],
  );
  assertEquals(
    groundedRetryQueries(
      guess("우직", null, null),
      "우직 @woozik.busanlover",
      ["우직 부산"],
    ),
    [],
  );
});

Deno.test("uses a same-segment Instagram handle region for SELECT validation", () => {
  const source = withCaptionRegionHints(
    guess("우직", null, null),
    "우직 @woozik.busan / 다른 장소는 서울",
  );
  const seoul = candidate(
    "seoul",
    "우직",
    "서울특별시 성동구 연무장길 12",
    null,
  );
  assertEquals(source.region, "부산");
  assertEquals(resolveAiSelectedKakaoPlace(source, [seoul], "seoul"), {
    status: "REJECTED",
    reason: "ADDRESS_CONFLICT",
  });
});

Deno.test("supports handle-only SELECT and a handle on the following line", () => {
  const source = withCaptionRegionHints(
    guess("@woozik.busan", null, null),
    "📍@woozik.busan",
    ["@woozik.busan"],
  );
  const woozik = candidate(
    "1595758078",
    "우직",
    "부산광역시 부산진구 전포대로256번길 34-3",
    null,
  );
  assertEquals(source.region, "부산");
  assertEquals(resolveAiSelectedKakaoPlace(source, [woozik], "1595758078"), {
    status: "ACCEPTED",
    place: woozik,
  });
  assertEquals(
    withCaptionRegionHints(
      guess("우직", null, null),
      "우직\n@woozik.busan",
      ["우직"],
    ).region,
    "부산",
  );
});

Deno.test("treats common short city names as their official metro names", () => {
  const seoul = candidate(
    "seoul",
    "오우드",
    "서울특별시 성동구 연무장길 12",
    null,
  );
  assertEquals(
    classifyKakaoCandidates(guess("오우드", null, "서울시"), [seoul]).type,
    "AUTO_MATCH",
  );
});

Deno.test("resolves the 윤숲 typo retry only at the caption address", () => {
  const source = guess(
    "윤숲 후루츠산도점",
    "서울 중랑구 면목로7길 8",
    "서울",
  );
  const right = candidate(
    "1775568752",
    "윤숲 후르츠산도점",
    "서울특별시 중랑구 면목로7길 8",
    null,
  );
  const wrong = candidate(
    "wrong",
    "윤숲 후르츠산도점",
    "서울특별시 마포구 월드컵로 8",
    null,
  );
  assertEquals(
    resolveRetriedKakaoPlace(source, ["윤숲 후르츠산도점", "윤숲"], [
      wrong,
      right,
    ]),
    { status: "ACCEPTED", place: right },
  );
});

Deno.test("resolves 우직 only in the grounded 부산 region", () => {
  const source = guess("우직", null, null);
  const busan = candidate(
    "1595758078",
    "우직",
    "부산광역시 부산진구 전포대로256번길 34-3",
    null,
  );
  const seoul = candidate(
    "seoul",
    "우직",
    "서울특별시 성동구 연무장길 12",
    null,
  );
  assertEquals(
    resolveRetriedKakaoPlace(source, ["우직 부산"], [seoul, busan]),
    { status: "ACCEPTED", place: busan },
  );
  assertEquals(
    resolveRetriedKakaoPlace(source, ["우직"], [seoul, busan]),
    { status: "REJECTED", reason: "AMBIGUOUS_SAME_NAME" },
  );
  assertEquals(
    resolveRetriedKakaoPlace(source, ["우직 부산"], [
      candidate(
        "region-name",
        "부산",
        "부산광역시 부산진구 중앙대로 1",
        null,
      ),
    ]),
    { status: "REJECTED", reason: "NAME_MISMATCH" },
  );
});

Deno.test("does not borrow an omitted neighboring place location", () => {
  for (
    const caption of [
      "우직 소개 그리고 서울 성동구 연무장길 12 오우드",
      "우직. 서울 오우드",
      "우직 · 서울 오우드",
      "우직 🔹 서울 오우드",
      "우직 🍽 서울 오우드",
    ]
  ) {
    const sanitized = sanitizePlaceGuesses([
      guess("우직", "서울 성동구 연무장길 12", "서울"),
    ], caption);
    assertEquals(sanitized, [guess("우직", null, null)]);
    assertEquals(
      withCaptionRegionHints(guess("우직", null, null), caption, ["우직"])
        .region,
      null,
    );
  }
});

Deno.test("assigns a next-line city to the place on that line", () => {
  const sanitized = sanitizePlaceGuesses([
    guess("우직", null, "서울"),
    guess("미쁘동", null, "서울"),
  ], "우직\n서울 미쁘동");
  assertEquals(sanitized, [
    guess("우직", null, null),
    guess("미쁘동", null, "서울"),
  ]);
});

Deno.test("accepts explicit address labels on the following line", () => {
  for (
    const caption of [
      "오우드\n주소는 서울 성동구 연무장길 12",
      "오우드\n📍 주소는 서울 성동구 연무장길 12",
      "오우드\n📌 위치는 서울 성동구 연무장길 12",
    ]
  ) {
    assertEquals(
      sanitizePlaceGuesses([
        guess("오우드", "서울 성동구 연무장길 12", "서울"),
      ], caption),
      [guess("오우드", "서울 성동구 연무장길 12", "서울")],
    );
  }
});

Deno.test("does not treat product or origin words as a store region", () => {
  for (
    const caption of [
      "우직 대구탕 맛집",
      "우직 서울우유 디저트",
      "우직 부산물 활용 메뉴",
      "우직 과일 광주리 선물",
      "우직 경기장 근처",
      "우직은 부산에서 공수한 재료로 운영해요",
      "우직 셰프는 부산에서 태어났어요",
    ]
  ) {
    assertEquals(
      withCaptionRegionHints(guess("우직", null, null), caption, ["우직"])
        .region,
      null,
    );
  }
});

Deno.test("requires a place name boundary after Korean particles", () => {
  for (
    const caption of [
      "오늘은 이카로스 카페",
      "오늘은 이카로제 파스타",
      "우직의자 전문점",
    ]
  ) {
    const placeName = caption.includes("우직") ? "우직" : "이카";
    assertEquals(
      sanitizePlaceGuesses([guess(placeName, null, null)], caption),
      [],
    );
  }
});

Deno.test("allows spacing and a one-character typo together", () => {
  assertEquals(placeNamesCompatible("브래드 누아젯", "브레드누아젯"), true);
  assertEquals(
    placeNamesCompatible("윤숲 후루츠 산도점", "윤숲 후르츠산도점"),
    true,
  );
});

Deno.test("requires location evidence before accepting a one-character name typo", () => {
  for (
    const [sourceName, candidateName] of [
      ["용용학생", "용용선생"],
      ["미쁘동", "미쁜동"],
      ["오우드", "오유드"],
    ]
  ) {
    const only = candidate("only", candidateName, null, null);
    const source = guess(sourceName, null, null);
    assertEquals(
      classifyKakaoCandidates(source, [only]).type,
      "NEEDS_AI_REVIEW",
    );
    assertEquals(resolveAiSelectedKakaoPlace(source, [only], "only"), {
      status: "REJECTED",
      reason: "NAME_MISMATCH",
    });
  }

  const corrected = candidate(
    "yunsoop",
    "윤숲 후르츠산도점",
    "서울특별시 중랑구 면목로7길 8",
    null,
  );
  assertEquals(
    classifyKakaoCandidates(
      guess("윤숲 후루츠산도점", "서울 중랑구 면목로7길 8", "서울"),
      [corrected],
    ).type,
    "AUTO_MATCH",
  );
});

Deno.test("applies the chain branch guard after location filtering", () => {
  const source = guess("용용선생", null, "부산");
  const seomyeon = candidate(
    "seomyeon",
    "용용선생 서면점",
    "부산광역시 부산진구 중앙대로 2",
    null,
  );
  const gangnam = candidate(
    "gangnam",
    "용용선생 강남점",
    "서울특별시 강남구 강남대로 2",
    null,
  );
  assertEquals(
    classifyKakaoCandidates(source, [seomyeon, gangnam]).type,
    "NEEDS_AI_REVIEW",
  );
});

Deno.test("does not replace an explicit branch with a generic wrong-city POI", () => {
  const genericSeoul = candidate(
    "generic",
    "용용선생",
    "서울특별시 강남구 강남대로 2",
    null,
  );
  const source = guess("용용선생 부산점", null, null);
  assertEquals(
    classifyKakaoCandidates(source, [genericSeoul]).type,
    "NEEDS_AI_REVIEW",
  );
  assertEquals(resolveAiSelectedKakaoPlace(source, [genericSeoul], "generic"), {
    status: "REJECTED",
    reason: "NAME_MISMATCH",
  });
});
