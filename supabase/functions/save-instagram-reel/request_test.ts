import {
  begunReelHTTPResult,
  clientRequestId,
  isIdempotencyKeyPayloadMismatch,
  isUUID,
  parseBegunReelRequest,
} from "./request.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

Deno.test("client request id prefers the persisted body key", () => {
  const request = new Request("https://example.com", {
    headers: {
      "Idempotency-Key": "22222222-2222-4222-8222-222222222222",
      "X-Request-Id": "33333333-3333-4333-8333-333333333333",
    },
  });
  const result = clientRequestId(request, { clientRequestId: REQUEST_ID });
  assert(result.value === REQUEST_ID, "body key must win");
  assert(result.provided, "body key must be marked as client-provided");
});

Deno.test("old clients receive a generated idempotency key", () => {
  const generated = "44444444-4444-4444-8444-444444444444";
  const result = clientRequestId(
    new Request("https://example.com"),
    {},
    () => generated,
  );
  assert(result.value === generated, "fallback key must be used");
  assert(!result.provided, "fallback key was not persisted by the client");
});

Deno.test("gateway trace ids are not mistaken for client idempotency keys", () => {
  const generated = "55555555-5555-4555-8555-555555555555";
  const result = clientRequestId(
    new Request("https://example.com", {
      headers: { "X-Request-Id": "gateway-trace-id" },
    }),
    {},
    () => generated,
  );
  assert(result.value === generated, "gateway trace header must be ignored");
  assert(!result.provided, "legacy request still uses compatibility fallback");
});

Deno.test("malformed client request ids are rejected instead of regenerated", () => {
  const result = clientRequestId(
    new Request("https://example.com"),
    { clientRequestId: "retry-me" },
  );
  assert(result.value === null, "malformed key must be rejected");
  assert(result.provided, "malformed key was still explicitly provided");
});

Deno.test("only the exact idempotency payload mismatch database error maps to 400", () => {
  assert(
    isIdempotencyKeyPayloadMismatch({
      code: "22023",
      message: "idempotency_key_payload_mismatch",
      details: null,
    }),
    "known mismatch must map to invalid clientRequestId",
  );
  assert(
    !isIdempotencyKeyPayloadMismatch({
      code: "22023",
      message: "invalid_reel_request",
    }),
    "other invalid-parameter database errors keep their existing handling",
  );
  assert(
    !isIdempotencyKeyPayloadMismatch({
      code: "P0001",
      message: "idempotency_key_payload_mismatch",
    }),
    "message alone is not enough to reclassify a database error",
  );
  assert(
    !isIdempotencyKeyPayloadMismatch(null),
    "missing errors do not match",
  );
});

Deno.test("begin request RPC response parser enforces the shared-cache contract", () => {
  const parsed = parseBegunReelRequest({
    reel_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    extraction_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    worker_reel_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    processing_status: "COMPLETED",
    failure_reason: null,
    processing_token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    should_process: false,
    reused: true,
    duplicate: false,
    save_mode: "REVIEW_QUEUE",
    place_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    place_ids: ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
  });
  assert(parsed?.reelId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "reel id");
  assert(
    parsed?.extractionId === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "extraction id",
  );
  assert(
    parsed?.workerReelId === "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "worker reel id",
  );
  assert(parsed?.processingStatus === "COMPLETED", "status");
  assert(parsed?.reused, "cache reuse marker");
  assert(parsed?.placeIds.length === 1, "cached place ids");

  const cachedWithoutWorker = parseBegunReelRequest({
    reel_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    extraction_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    worker_reel_id: null,
    processing_status: "COMPLETED",
    failure_reason: null,
    processing_token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    should_process: false,
    reused: true,
    duplicate: false,
    save_mode: "REVIEW_QUEUE",
    place_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    place_ids: ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
  });
  assert(
    cachedWithoutWorker?.workerReelId === null,
    "cache survives worker deletion",
  );

  assert(
    parseBegunReelRequest({
      reel_id: "not-a-uuid",
      extraction_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      worker_reel_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      processing_status: "COMPLETED",
      failure_reason: null,
      processing_token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      should_process: false,
      reused: true,
      duplicate: false,
      save_mode: "REVIEW_QUEUE",
      place_id: null,
      place_ids: [],
    }) === null,
    "invalid database payload must fail closed",
  );

  assert(
    parseBegunReelRequest({
      reel_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      extraction_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      worker_reel_id: null,
      processing_status: "PROCESSING",
      failure_reason: null,
      processing_token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      should_process: true,
      reused: false,
      duplicate: false,
      save_mode: "REVIEW_QUEUE",
      place_id: null,
      place_ids: [],
    }) === null,
    "a claimed extraction must have a worker",
  );
});

Deno.test("UUID validator accepts canonical UUIDs only", () => {
  assert(isUUID(REQUEST_ID), "canonical uuid");
  assert(!isUUID("11111111-1111-1111-1111-111111111111"), "invalid variant");
  assert(!isUUID(null), "non-string");
});

Deno.test("a completed shared extraction responds with the new history id", () => {
  const result = begunReelHTTPResult({
    reelId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    extractionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    workerReelId: null,
    processingStatus: "COMPLETED",
    failureReason: null,
    processingToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    shouldProcess: false,
    reused: true,
    duplicate: false,
    saveMode: "REVIEW_QUEUE",
    placeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    placeIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
  }, "REVIEW_QUEUE");

  assert(
    result.status === 200,
    "completed cache must be immediately available",
  );
  assert(
    result.body.reelId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "response identifies the new request history, not a deleted worker",
  );
  assert(result.body.reused === true, "response marks cache reuse");
  assert(result.body.saveMode === "REVIEW_QUEUE", "v2 response mode");
});

Deno.test("an in-flight shared extraction returns 202 without starting a second worker", () => {
  const result = begunReelHTTPResult({
    reelId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    extractionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    workerReelId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    processingStatus: "PROCESSING",
    failureReason: null,
    processingToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    shouldProcess: false,
    reused: true,
    duplicate: false,
    saveMode: "REVIEW_QUEUE",
    placeId: null,
    placeIds: [],
  }, "REVIEW_QUEUE");

  assert(result.status === 202, "shared in-flight request remains processing");
  assert(
    !("placeIds" in result.body),
    "partial worker output must stay hidden",
  );
});
