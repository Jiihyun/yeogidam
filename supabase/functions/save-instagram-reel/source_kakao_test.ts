import {
  parseSourceKakaoPlaces,
  searchSourceKakaoPlaces,
} from "./source_kakao.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
const valid = {
  id: "100",
  place_name: "카페",
  address_name: "서울 성동구 성수동1가 1",
  x: "127",
  y: "37.5",
};

Deno.test("카카오의 불완전한 장소는 건너뛰고 첫 유효 장소와 순서를 보존한다", () => {
  equal(
    parseSourceKakaoPlaces({
      documents: [
        { ...valid, id: "invalid", y: "" },
        valid,
        { ...valid, id: "100", place_name: "중복" },
        { ...valid, id: "200" },
      ],
    }).map((place) => [place.kakaoPlaceId, place.name]),
    [["100", "카페"], ["200", "카페"]],
  );
});

Deno.test("카카오 빈 결과는 정상이며 모든 항목이 불완전하면 공급자 오류로 처리한다", () => {
  equal(parseSourceKakaoPlaces({ documents: [] }), []);
  for (const payload of [{ documents: [{ ...valid, address_name: "" }] }, {}]) {
    let failed = false;
    try {
      parseSourceKakaoPlaces(payload);
    } catch {
      failed = true;
    }
    equal(failed, true);
  }
});

Deno.test("카카오 검색은 원본과 동일하게 첫 페이지 15개만 요청한다", async () => {
  const places = await searchSourceKakaoPlaces(
    "카페 성수",
    "test-key",
    async (url, init) => {
      const target = new URL(String(url));
      equal(target.searchParams.get("query"), "카페 성수");
      equal(target.searchParams.get("size"), "15");
      equal(target.searchParams.get("page"), "1");
      equal(
        new Headers(init?.headers).get("Authorization"),
        "KakaoAK test-key",
      );
      return Response.json({ documents: [valid] });
    },
  );
  equal(places.map((place) => place.kakaoPlaceId), ["100"]);
});

Deno.test("카카오 401과 429와 500 응답은 후보 없음으로 바꾸지 않는다", async () => {
  for (const status of [401, 429, 500]) {
    let failed = false;
    try {
      await searchSourceKakaoPlaces(
        "카페",
        "test-key",
        async () => new Response(null, { status }),
      );
    } catch {
      failed = true;
    }
    equal(failed, true);
  }
});
