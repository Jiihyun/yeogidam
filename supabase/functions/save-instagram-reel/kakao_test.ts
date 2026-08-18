import {
  buildKakaoMapURL,
  KakaoPlaceSearchError,
  parseKakaoPlaces,
  searchKakaoPlaces,
} from "./kakao.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function rejectedSearch(
  result: number | Error | Response,
): Promise<KakaoPlaceSearchError> {
  const request = (async () => {
    if (result instanceof Error) throw result;
    if (result instanceof Response) return result;
    return new Response("upstream failure", { status: result });
  }) as typeof fetch;

  try {
    await searchKakaoPlaces("오우드", "test-key", request);
  } catch (error) {
    if (error instanceof KakaoPlaceSearchError) return error;
    throw new Error(`Expected KakaoPlaceSearchError, got ${String(error)}`);
  }
  throw new Error("Expected Kakao place search to reject");
}

Deno.test("normalizes Kakao places with stable place ids", () => {
  const places = parseKakaoPlaces({
    documents: [{
      id: "26338954",
      place_name: "카카오프렌즈 코엑스점",
      category_name: "가정,생활 > 문구",
      address_name: "서울 강남구 삼성동 159",
      road_address_name: "서울 강남구 영동대로 513",
      x: "127.05902969025047",
      y: "37.51207412593136",
      place_url: "http://place.map.kakao.com/26338954",
      phone: "02-6002-1880",
    }],
  });

  assertEquals(places, [{
    kakaoPlaceId: "26338954",
    name: "카카오프렌즈 코엑스점",
    category: "가정,생활 > 문구",
    roadAddress: "서울 강남구 영동대로 513",
    address: "서울 강남구 삼성동 159",
    latitude: 37.51207412593136,
    longitude: 127.05902969025047,
    placeUrl: "http://place.map.kakao.com/26338954",
    telephone: "02-6002-1880",
  }]);
  assertEquals(
    buildKakaoMapURL(places[0].kakaoPlaceId),
    "https://map.kakao.com/link/map/26338954",
  );
});

Deno.test("drops malformed Kakao documents and invalid coordinates", () => {
  const places = parseKakaoPlaces({
    documents: [
      null,
      { id: "", place_name: "이름" },
      { id: "1", place_name: "장소", x: "999", y: "none" },
    ],
  });

  assertEquals(places.length, 1);
  assertEquals(places[0].latitude, null);
  assertEquals(places[0].longitude, null);
});

Deno.test("returns an empty list only for a successful empty Kakao response", async () => {
  let requestedUrl = "";
  let authorization = "";
  const request =
    (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return Response.json({ documents: [] });
    }) as typeof fetch;

  const places = await searchKakaoPlaces("오우드", "test-key", request);
  const url = new URL(requestedUrl);

  assertEquals(places, []);
  assertEquals(url.searchParams.get("query"), "오우드");
  assertEquals(url.searchParams.get("size"), "15");
  assertEquals(url.searchParams.get("sort"), "accuracy");
  assertEquals(authorization, "KakaoAK test-key");
});

Deno.test("throws typed errors for Kakao authentication, rate, and server failures", async () => {
  const authentication = await rejectedSearch(401);
  assertEquals(
    [authentication.kind, authentication.status, authentication.retryable],
    ["AUTH", 401, false],
  );

  const rateLimit = await rejectedSearch(429);
  assertEquals(
    [rateLimit.kind, rateLimit.status, rateLimit.retryable],
    ["RATE_LIMIT", 429, true],
  );

  const server = await rejectedSearch(503);
  assertEquals(
    [server.kind, server.status, server.retryable],
    ["SERVER", 503, true],
  );

  const unexpectedSuccessStatus = await rejectedSearch(202);
  assertEquals(
    [
      unexpectedSuccessStatus.kind,
      unexpectedSuccessStatus.status,
      unexpectedSuccessStatus.retryable,
    ],
    ["HTTP", 202, false],
  );
});

Deno.test("wraps Kakao network failures as retryable typed errors", async () => {
  const error = await rejectedSearch(new TypeError("network down"));

  assertEquals([error.kind, error.status, error.retryable], [
    "NETWORK",
    null,
    true,
  ]);
  assertEquals(error.cause instanceof TypeError, true);
});

Deno.test("does not treat a malformed successful Kakao response as zero candidates", async () => {
  const malformedPayloads = [
    { meta: {} },
    { documents: [{ id: "", place_name: "" }] },
    {
      documents: [
        { id: "1", place_name: "정상 후보" },
        { id: "", place_name: "깨진 후보" },
      ],
    },
  ];

  for (const payload of malformedPayloads) {
    const error = await rejectedSearch(Response.json(payload));
    assertEquals(error.kind, "INVALID_RESPONSE");
  }

  const malformedJson = await rejectedSearch(
    new Response("not-json", { status: 200 }),
  );
  assertEquals(malformedJson.kind, "INVALID_RESPONSE");
});
