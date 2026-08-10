import { parseGeminiPlaceGuess } from "./gemini.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("parses a structured Gemini place response", () => {
  assertEquals(
    parseGeminiPlaceGuess({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              placeName: " 오르노 성수점 ",
              region: " 성수동 ",
            }),
          }],
        },
      }],
    }),
    { placeName: "오르노 성수점", region: "성수동" },
  );
});

Deno.test("rejects missing or malformed Gemini place responses", () => {
  assertEquals(parseGeminiPlaceGuess({ candidates: [] }), null);
  assertEquals(
    parseGeminiPlaceGuess({
      candidates: [{ content: { parts: [{ text: "not-json" }] } }],
    }),
    null,
  );
});
