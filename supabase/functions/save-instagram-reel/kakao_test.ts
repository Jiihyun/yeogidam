import {
  buildKakaoMapURL,
  KakaoPlaceSearchError,
  parseKakaoAddressCoordinates,
  parseKakaoPlaces,
  searchKakaoAddressCoordinates,
  searchKakaoPlaces,
  searchKakaoPlacesNearAddress,
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
  const request = (() => {
    if (result instanceof Error) return Promise.reject(result);
    if (result instanceof Response) return Promise.resolve(result);
    return Promise.resolve(
      new Response("upstream failure", { status: result }),
    );
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
  const request = ((input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return Promise.resolve(Response.json({ documents: [] }));
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

Deno.test("geocodes a detailed address with the Kakao address endpoint", async () => {
  const payload = {
    documents: [{
      address_name: "서울 강남구 역삼동 825-20",
      address_type: "ROAD_ADDR",
      x: "127.027621",
      y: "37.497942",
      address: { address_name: "서울 강남구 역삼동 825-20" },
      road_address: { address_name: "서울 강남구 테헤란로1길 20" },
    }],
  };
  assertEquals(parseKakaoAddressCoordinates(payload), [{
    latitude: 37.497942,
    longitude: 127.027621,
    roadAddress: "서울 강남구 테헤란로1길 20",
    address: "서울 강남구 역삼동 825-20",
  }]);

  let requestedUrl = "";
  let authorization = "";
  const request = ((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return Promise.resolve(Response.json(payload));
  }) as typeof fetch;

  const coordinates = await searchKakaoAddressCoordinates(
    "서울 강남구 테헤란로1길 20 2층",
    "test-key",
    request,
  );
  const url = new URL(requestedUrl);
  assertEquals(coordinates, [{
    latitude: 37.497942,
    longitude: 127.027621,
    roadAddress: "서울 강남구 테헤란로1길 20",
    address: "서울 강남구 역삼동 825-20",
  }]);
  assertEquals(url.pathname, "/v2/local/search/address.json");
  assertEquals(url.searchParams.get("query"), "서울 강남구 테헤란로1길 20");
  assertEquals(url.searchParams.get("analyze_type"), "exact");
  assertEquals(authorization, "KakaoAK test-key");

  await searchKakaoAddressCoordinates(
    "서울 강남구 도산대로23길 17 1, 2F",
    "test-key",
    request,
  );
  assertEquals(
    new URL(requestedUrl).searchParams.get("query"),
    "서울 강남구 도산대로23길 17",
  );
});

Deno.test("returns an empty list only for a valid empty address search", async () => {
  const empty =
    (() => Promise.resolve(Response.json({ documents: [] }))) as typeof fetch;
  assertEquals(
    await searchKakaoAddressCoordinates("서울 강남구 없는로 1", "key", empty),
    [],
  );

  const malformed = (() =>
    Promise.resolve(Response.json({
      documents: [{ x: "invalid", y: "37.5" }],
    }))) as typeof fetch;
  try {
    await searchKakaoAddressCoordinates(
      "서울 강남구 잘못된로 1",
      "key",
      malformed,
    );
  } catch (error) {
    assertEquals(error instanceof KakaoPlaceSearchError, true);
    assertEquals((error as KakaoPlaceSearchError).kind, "INVALID_RESPONSE");
    return;
  }
  throw new Error("Expected malformed address coordinates to reject");
});

Deno.test("searches a place name near an address coordinate by distance", async () => {
  let requestedUrl = "";
  const request = ((input: string | URL | Request) => {
    requestedUrl = String(input);
    return Promise.resolve(Response.json({
      documents: [{
        id: "312908843",
        place_name: "동두천솥뚜껑삼겹살 강남역점",
        address_name: "서울 강남구 역삼동 825-20",
        road_address_name: "서울 강남구 테헤란로1길 20",
        x: "127.027621",
        y: "37.497942",
      }],
    }));
  }) as typeof fetch;

  const places = await searchKakaoPlacesNearAddress(
    "동두천솥뚜껑삼겹살",
    { latitude: 37.497942, longitude: 127.027621 },
    "test-key",
    request,
  );
  const url = new URL(requestedUrl);
  assertEquals(places.map((place) => place.kakaoPlaceId), ["312908843"]);
  assertEquals(url.pathname, "/v2/local/search/keyword.json");
  assertEquals(url.searchParams.get("query"), "동두천솥뚜껑삼겹살");
  assertEquals(url.searchParams.get("x"), "127.027621");
  assertEquals(url.searchParams.get("y"), "37.497942");
  assertEquals(url.searchParams.get("radius"), "300");
  assertEquals(url.searchParams.get("sort"), "distance");
  assertEquals(url.searchParams.get("size"), "15");
});

Deno.test("caps an address-nearby search radius at 500 meters", async () => {
  let requestedUrl = "";
  const request = ((input: string | URL | Request) => {
    requestedUrl = String(input);
    return Promise.resolve(Response.json({ documents: [] }));
  }) as typeof fetch;

  await searchKakaoPlacesNearAddress(
    "춘식당",
    { latitude: 37.52, longitude: 127.03 },
    "key",
    request,
    5000,
  );
  assertEquals(new URL(requestedUrl).searchParams.get("radius"), "500");
});
