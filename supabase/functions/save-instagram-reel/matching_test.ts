import type { PlaceGuess } from "./gemini.ts";
import {
  buildKakaoQueries,
  classifyKakaoCandidates,
  deduplicateKakaoPlaces,
  hasDetailedAddressEvidence,
  locationMatchedKakaoPlaces,
  resolveAiSelectedKakaoPlace,
  sanitizePlaceGuesses,
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

Deno.test("auto-matches one raw candidate without name or address validation", () => {
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
    { type: "AUTO_MATCH", place: only },
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

Deno.test("accepts any Gemini-selected candidate from the supplied allowlist", () => {
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

  assertEquals(resolveAiSelectedKakaoPlace([selected, other], "selected"), {
    status: "ACCEPTED",
    place: selected,
  });
});

Deno.test("rejects a Gemini candidate ID that was not supplied", () => {
  const candidateList = [candidate("known", "오우드", null, null)];
  assertEquals(resolveAiSelectedKakaoPlace(candidateList, "invented"), {
    status: "REJECTED",
    reason: "AI_SELECTED_UNKNOWN_CANDIDATE",
  });
});
