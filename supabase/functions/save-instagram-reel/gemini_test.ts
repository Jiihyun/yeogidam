import {
  parseGeminiCandidateJudgments,
  parseGeminiPlaceGuesses,
} from "./gemini.ts";

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

Deno.test("drops malformed places without capping valid results", () => {
  const places = Array.from({ length: 12 }, (_, index) => ({
    placeName: index === 1 ? "" : `장소${index}`,
    address: null,
    addressType: index === 2 ? "INVALID" : "NONE",
    region: null,
  }));
  const result = parseGeminiPlaceGuesses(response({ places }));

  assertEquals(result.length, 11);
  assertEquals(result[1].addressType, "NONE");
  assertEquals(result.at(-1)?.placeName, "장소11");
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

Deno.test("parses only valid unique SELECT or NONE candidate judgments", () => {
  assertEquals(
    parseGeminiCandidateJudgments(response({
      decisions: [{
        guessIndex: 0,
        decision: "SELECT",
        candidateId: " 1102574979 ",
        reason: "MATCH",
      }, {
        guessIndex: 1,
        decision: "NONE",
        candidateId: "must-be-cleared",
        reason: "AMBIGUOUS_SAME_NAME",
      }, {
        guessIndex: 0,
        decision: "SELECT",
        candidateId: "duplicate",
        reason: "MATCH",
      }, {
        guessIndex: 2,
        decision: "SELECT",
        candidateId: null,
        reason: "MATCH",
      }, {
        guessIndex: 11,
        decision: "NONE",
        candidateId: null,
        reason: "INSUFFICIENT_CONTEXT",
      }, {
        guessIndex: 3,
        decision: "INVENT",
        candidateId: "new-id",
        reason: "MATCH",
      }, {
        guessIndex: 4,
        decision: "SELECT",
        candidateId: "candidate",
        reason: "NAME_MISMATCH",
      }, {
        guessIndex: 5,
        decision: "NONE",
        candidateId: null,
        reason: "MATCH",
      }],
    })),
    [{
      guessIndex: 0,
      decision: "SELECT",
      candidateId: "1102574979",
      reason: "MATCH",
    }, {
      guessIndex: 1,
      decision: "NONE",
      candidateId: null,
      reason: "AMBIGUOUS_SAME_NAME",
    }, {
      guessIndex: 11,
      decision: "NONE",
      candidateId: null,
      reason: "INSUFFICIENT_CONTEXT",
    }],
  );
});

Deno.test("parses more than ten candidate judgments", () => {
  const decisions = Array.from({ length: 12 }, (_, guessIndex) => ({
    guessIndex,
    decision: "NONE",
    candidateId: null,
    reason: "INSUFFICIENT_CONTEXT",
  }));

  const result = parseGeminiCandidateJudgments(response({ decisions }));

  assertEquals(result.length, 12);
  assertEquals(result.at(-1)?.guessIndex, 11);
});

Deno.test("rejects malformed Gemini candidate judgment responses", () => {
  assertEquals(parseGeminiCandidateJudgments({ candidates: [] }), []);
  assertEquals(
    parseGeminiCandidateJudgments({
      candidates: [{ content: { parts: [{ text: "not-json" }] } }],
    }),
    [],
  );
  assertEquals(
    parseGeminiCandidateJudgments(response({ decisions: null })),
    [],
  );
});
