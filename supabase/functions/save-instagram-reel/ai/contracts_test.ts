import {
  AiContractError,
  parseCandidateJudgmentPayload,
  parseJsonPayload,
  parsePlaceExtractionPayload,
} from "./contracts.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertContractError(fn: () => unknown): AiContractError {
  try {
    fn();
  } catch (error) {
    assert(error instanceof AiContractError, "Expected AiContractError");
    return error;
  }
  throw new Error("Expected AiContractError to be thrown");
}

Deno.test("parses provider-neutral place extraction payloads", () => {
  assertEquals(
    parsePlaceExtractionPayload({
      places: [{
        placeName: " 키리 ",
        address: " 광주 동구 동명동 200-188 ",
        addressType: "JIBUN",
        region: " 동명동 ",
      }, {
        placeName: "보연희",
        address: null,
        addressType: "NONE",
        region: null,
      }],
    }),
    [{
      placeName: "키리",
      address: "광주 동구 동명동 200-188",
      addressType: "JIBUN",
      region: "동명동",
    }, {
      placeName: "보연희",
      address: null,
      addressType: "NONE",
      region: null,
    }],
  );
});

Deno.test("treats a valid empty place list as a successful result", () => {
  assertEquals(parsePlaceExtractionPayload({ places: [] }), []);
});

Deno.test("keeps more than ten valid places without an application cap", () => {
  const places = Array.from({ length: 12 }, (_, index) => ({
    placeName: `장소${index}`,
    address: null,
    addressType: "NONE",
    region: null,
  }));

  const result = parsePlaceExtractionPayload({ places });

  assertEquals(result.length, 12);
  assertEquals(result[1].addressType, "NONE");
  assertEquals(result.at(-1)?.placeName, "장소11");
});

Deno.test("rejects malformed place and JSON payloads", () => {
  assertContractError(() => parsePlaceExtractionPayload({ candidates: [] }));
  assertContractError(() =>
    parsePlaceExtractionPayload({ places: [{ placeName: "" }] })
  );
  assertContractError(() => parseJsonPayload("not-json"));
});

Deno.test("rejects a partly malformed non-empty place response", () => {
  assertContractError(() =>
    parsePlaceExtractionPayload({
      places: [{
        placeName: "보연희",
        address: null,
        addressType: "NONE",
        region: null,
      }, {
        placeName: "키리",
        address: null,
        addressType: "INVALID",
        region: null,
      }],
    })
  );
});

Deno.test("parses SELECT RETRY and NONE judgments with normalized queries", () => {
  assertEquals(
    parseCandidateJudgmentPayload({
      decisions: [{
        guessIndex: 0,
        decision: "SELECT",
        candidateId: " candidate-0 ",
        retryQueries: [],
        reason: "MATCH",
      }, {
        guessIndex: 1,
        decision: "RETRY",
        candidateId: null,
        retryQueries: [" 우직 부산 ", "우직   부산", "우직"],
        reason: "CANDIDATE_MISSING",
      }, {
        guessIndex: 2,
        decision: "NONE",
        candidateId: null,
        retryQueries: [],
        reason: "INSUFFICIENT_CONTEXT",
      }],
    }, [0, 1, 2]),
    [{
      guessIndex: 0,
      decision: "SELECT",
      candidateId: "candidate-0",
      retryQueries: [],
      reason: "MATCH",
    }, {
      guessIndex: 1,
      decision: "RETRY",
      candidateId: null,
      retryQueries: ["우직 부산", "우직"],
      reason: "CANDIDATE_MISSING",
    }, {
      guessIndex: 2,
      decision: "NONE",
      candidateId: null,
      retryQueries: [],
      reason: "INSUFFICIENT_CONTEXT",
    }],
  );
});

Deno.test("requires judgments to cover each requested guess exactly once", () => {
  const select = {
    guessIndex: 0,
    decision: "SELECT",
    candidateId: "candidate-0",
    retryQueries: [],
    reason: "MATCH",
  };
  assertContractError(() =>
    parseCandidateJudgmentPayload({ decisions: [select] }, [0, 1])
  );
  assertContractError(() =>
    parseCandidateJudgmentPayload({ decisions: [select, select] }, [0])
  );
});

Deno.test("keeps more than ten complete candidate judgments", () => {
  const decisions = Array.from({ length: 12 }, (_, guessIndex) => ({
    guessIndex,
    decision: "NONE",
    candidateId: null,
    retryQueries: [],
    reason: "INSUFFICIENT_CONTEXT",
  }));
  const expectedIndexes = decisions.map(({ guessIndex }) => guessIndex);

  const result = parseCandidateJudgmentPayload({ decisions }, expectedIndexes);

  assertEquals(result.length, 12);
  assertEquals(result.at(-1)?.guessIndex, 11);
});

Deno.test("preserves source fields and accepts corrected search names absent from the caption", () => {
  const places = [{
    placeName: "버연희",
    searchNames: [" 보연희 ", "보연희", "BOYEONHUI"],
    address: "서울 서대문구 연희맛로 17-63 2층",
    searchAddress: "서울 서대문구 연희맛로 17-63",
    addressType: "ROAD",
    region: "연희동",
  }, {
    placeName: "파파죤스",
    searchNames: ["파파존스", "Papa John's"],
    address: null,
    searchAddress: null,
    addressType: "NONE",
    region: null,
  }];
  const result = parsePlaceExtractionPayload({ places });
  assertEquals(result[0].placeName, "버연희");
  assertEquals(result[0].searchNames, ["보연희", "BOYEONHUI"]);
  assertEquals(result[0].address, places[0].address);
  assertEquals(result[0].searchAddress, places[0].searchAddress);
  assertEquals(result[1].placeName, "파파죤스");
  assertEquals(result[1].searchNames, ["파파존스", "Papa John's"]);
});

Deno.test("checks search helper field shapes without requiring name similarity", () => {
  const place = {
    placeName: "상호",
    address: null,
    addressType: "NONE",
    region: null,
  };
  for (
    const searchNames of ["상호", [null], [""], ["a", "b", "c", "d"], [
      "a".repeat(81),
    ]]
  ) {
    assertContractError(() =>
      parsePlaceExtractionPayload({ places: [{ ...place, searchNames }] })
    );
  }
  assertContractError(() =>
    parsePlaceExtractionPayload({ places: [{ ...place, searchAddress: 42 }] })
  );
});
