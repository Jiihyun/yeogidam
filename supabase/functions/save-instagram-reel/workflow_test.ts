import {
  AUTO_SAVE,
  dominantSaveMode,
  isReelSaveMode,
  responseForSaveMode,
  REVIEW_QUEUE,
} from "./workflow.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("AUTO_SAVE wins every v1/v2 mode race", () => {
  assert(
    dominantSaveMode(REVIEW_QUEUE, AUTO_SAVE) === AUTO_SAVE,
    "a later v1 request must promote queue mode",
  );
  assert(
    dominantSaveMode(AUTO_SAVE, REVIEW_QUEUE) === AUTO_SAVE,
    "a later v2 request must not downgrade auto save",
  );
  assert(
    dominantSaveMode(REVIEW_QUEUE, REVIEW_QUEUE) === REVIEW_QUEUE,
    "two v2 requests must remain queued",
  );
});

Deno.test("save mode parser accepts only the database contract values", () => {
  assert(isReelSaveMode(AUTO_SAVE), "AUTO_SAVE must be accepted");
  assert(isReelSaveMode(REVIEW_QUEUE), "REVIEW_QUEUE must be accepted");
  assert(!isReelSaveMode("PENDING"), "review status is not a save mode");
  assert(!isReelSaveMode(null), "null must be rejected");
});

Deno.test("v1 response remains byte-shape compatible without saveMode", () => {
  const body = { reelId: "reel-1", status: "COMPLETED", reused: false };
  const response = responseForSaveMode(body, AUTO_SAVE, AUTO_SAVE);
  assert(response === body, "v1 must receive the original response object");
  assert(!("saveMode" in response), "v1 must not gain a new response field");
});

Deno.test("v2 response reports the actual mode after a race", () => {
  const body = { reelId: "reel-1", status: "PROCESSING", reused: true };
  const autoResponse = responseForSaveMode(body, REVIEW_QUEUE, AUTO_SAVE);
  const queueResponse = responseForSaveMode(
    body,
    REVIEW_QUEUE,
    REVIEW_QUEUE,
  );
  assert(
    "saveMode" in autoResponse && autoResponse.saveMode === AUTO_SAVE,
    "v2 must learn that a v1 request won",
  );
  assert(
    "saveMode" in queueResponse && queueResponse.saveMode === REVIEW_QUEUE,
    "v2 must report queue mode when it remains active",
  );
});
