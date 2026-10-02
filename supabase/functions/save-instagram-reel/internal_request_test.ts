import { parseInternalReelRequest } from "./internal_request.ts";

const payload = {
  extractionId: "11111111-1111-4111-8111-111111111111",
  workerReelId: "22222222-2222-4222-8222-222222222222",
  processingToken: "33333333-3333-4333-8333-333333333333",
};

Deno.test("both internal operations require the exact worker and processing token", () => {
  for (const action of ["process_place_batch", "retry_reel_processing"]) {
    const result = parseInternalReelRequest({ ...payload, action });
    if (
      !result || result.action !== action ||
      result.processingToken !== payload.processingToken
    ) {
      throw new Error(
        "valid internal operation must preserve its worker identity",
      );
    }
  }
});

Deno.test("unknown operations and missing or invalid identities are rejected", () => {
  for (
    const input of [
      null,
      [],
      { ...payload, action: "other" },
      {
        ...payload,
        action: "retry_reel_processing",
        processingToken: undefined,
      },
      { ...payload, action: "retry_reel_processing", extractionId: "wrong" },
      { ...payload, action: "retry_reel_processing", workerReelId: "wrong" },
    ]
  ) {
    if (parseInternalReelRequest(input) !== null) {
      throw new Error("invalid operation must fail");
    }
  }
});
