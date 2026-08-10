import { parseGeminiPlaceGuesses } from "./gemini.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function response(payload: unknown): unknown {
  return {
    candidates: [{
      content: { parts: [{ text: JSON.stringify(payload) }] },
    }],
  };
}

Deno.test("parses multiple structured Gemini places", () => {
  assertEquals(
    parseGeminiPlaceGuesses(response({
      places: [{
        placeName: " 키리 ",
        address: " 광주 동구 동명동 200-188 ",
        addressType: "JIBUN",
        region: " 동명동 ",
      }, {
        placeName: "보연희",
        address: "서울 서대문구 연희맛로 17-63 2층",
        addressType: "ROAD",
        region: "연희동",
      }],
    })),
    [{
      placeName: "키리",
      address: "광주 동구 동명동 200-188",
      addressType: "JIBUN",
      region: "동명동",
    }, {
      placeName: "보연희",
      address: "서울 서대문구 연희맛로 17-63 2층",
      addressType: "ROAD",
      region: "연희동",
    }],
  );
});

Deno.test("drops malformed places and caps the result", () => {
  const places = Array.from({ length: 12 }, (_, index) => ({
    placeName: index === 1 ? "" : `장소${index}`,
    address: null,
    addressType: index === 2 ? "INVALID" : "NONE",
    region: null,
  }));
  const result = parseGeminiPlaceGuesses(response({ places }));

  assertEquals(result.length, 9);
  assertEquals(result[1].addressType, "NONE");
});

Deno.test("rejects missing or malformed Gemini place responses", () => {
  assertEquals(parseGeminiPlaceGuesses({ candidates: [] }), []);
  assertEquals(
    parseGeminiPlaceGuesses({
      candidates: [{ content: { parts: [{ text: "not-json" }] } }],
    }),
    [],
  );
  assertEquals(parseGeminiPlaceGuesses(response({ places: null })), []);
});
