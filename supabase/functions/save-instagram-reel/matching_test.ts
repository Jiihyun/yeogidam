import type { PlaceGuess } from "./ai/types.ts";
import {
  buildKakaoQueries,
  placeSearchNames,
  uniqueSearchQueries,
} from "./matching.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "Expected " + JSON.stringify(expected) + ", got " +
        JSON.stringify(actual),
    );
  }
}

Deno.test("searches the original typo and AI-corrected names with local context", () => {
  const guess: PlaceGuess = {
    placeName: "버연희",
    searchNames: ["보연희"],
    address: "서울 서대문구 연희맛로 17-63 2층",
    addressType: "ROAD",
    region: "연희동",
  };
  assertEquals(buildKakaoQueries(guess), [
    "버연희",
    "보연희",
    "버연희 연희동",
    "보연희 연희동",
  ]);
  assertEquals(guess.placeName, "버연희");
  assertEquals(guess.address, "서울 서대문구 연희맛로 17-63 2층");
});

Deno.test("does not restrict AI name corrections by edit distance or transliteration", () => {
  const guess: PlaceGuess = {
    placeName: "파파죤스",
    searchNames: ["파파존스", "Papa John's"],
    address: null,
    addressType: "NONE",
    region: null,
  };
  assertEquals(placeSearchNames(guess), [
    "파파죤스",
    "파파존스",
    "Papa John's",
  ]);
});

Deno.test("deduplicates equivalent queries while keeping meaningful spacing variants", () => {
  assertEquals(
    uniqueSearchQueries([
      " OUD ",
      "oud",
      "파파존스",
      "파파 존스",
      "",
      "a".repeat(81),
    ]),
    ["OUD", "파파존스", "파파 존스"],
  );
});

Deno.test("supports legacy guesses without correction fields", () => {
  assertEquals(
    buildKakaoQueries({
      placeName: "보연희",
      address: null,
      addressType: "NONE",
      region: null,
    }),
    ["보연희"],
  );
});
