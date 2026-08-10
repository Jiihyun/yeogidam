import type { PlaceGuess } from "./gemini.ts";
import {
  buildKakaoQueries,
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
