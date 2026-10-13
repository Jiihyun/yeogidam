import {
  geocodeSourceAddress,
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
  category_name: "음식점 > 카페",
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

Deno.test("카카오 분류가 음식점이 아닌 결과는 받지 않고, 음식점이 없으면 빈 목록이다", () => {
  equal(
    parseSourceKakaoPlaces({
      documents: [
        { ...valid, id: "1", category_name: "여행 > 관광,명소 > 고궁" },
        { ...valid, id: "2" },
        { ...valid, id: "3", category_name: "부동산 > 주거시설 > 아파트" },
      ],
    }).map((place) => place.kakaoPlaceId),
    ["2"],
  );
  equal(
    parseSourceKakaoPlaces({
      documents: [{ ...valid, category_name: "여행 > 공원" }],
    }),
    [],
  );
});

Deno.test("주소 좌표가 있으면 그 반경 3km 안에서 찾는다", async () => {
  await searchSourceKakaoPlaces(
    "카페",
    "test-key",
    async (url) => {
      const target = new URL(String(url));
      equal(
        ["x", "y", "radius"].map((name) => target.searchParams.get(name)),
        ["127.05", "37.54", "3000"],
      );
      return Response.json({ documents: [valid] });
    },
    { latitude: 37.54, longitude: 127.05 },
  );
});

Deno.test("주소 검색이 비면 끝 낱말을 떼고 다시 찾고, 세 번 떼도 없으면 null이다", async () => {
  const queries: string[] = [];
  const coordinate = await geocodeSourceAddress(
    "서울 성동구 성수이로 7 2층 201호",
    "test-key",
    async (url) => {
      const target = new URL(String(url));
      equal(target.pathname, "/v2/local/search/address.json");
      const query = target.searchParams.get("query")!;
      queries.push(query);
      return Response.json({
        documents: query === "서울 성동구 성수이로 7"
          ? [{ x: "127.05", y: "37.54" }]
          : [],
      });
    },
  );
  equal(coordinate, { latitude: 37.54, longitude: 127.05 });
  equal(queries, [
    "서울 성동구 성수이로 7 2층 201호",
    "서울 성동구 성수이로 7 2층",
    "서울 성동구 성수이로 7",
  ]);

  let calls = 0;
  const missing = await geocodeSourceAddress(
    "어딘가 없는 길 1 2 3 4",
    "test-key",
    async () => {
      calls++;
      return Response.json({ documents: [] });
    },
  );
  equal([missing, calls], [null, 4]);
});
