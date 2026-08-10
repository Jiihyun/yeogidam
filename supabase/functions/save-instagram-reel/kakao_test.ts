import { buildKakaoMapURL, parseKakaoPlaces } from "./kakao.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
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
