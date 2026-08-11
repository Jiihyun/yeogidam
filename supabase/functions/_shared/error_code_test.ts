import { createRequestId, ErrorCode, errorResponse } from "./error_code.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("ErrorCode registry keeps public codes, messages, and statuses consistent", () => {
  const publicCodes = new Set<string>();
  for (const [name, definition] of Object.entries(ErrorCode)) {
    assert(
      /^[A-Z]+\d{3}_\d{3}$/.test(definition.code),
      `${name}: invalid public error code`,
    );
    assert(!publicCodes.has(definition.code), `${name}: duplicate public code`);
    publicCodes.add(definition.code);
    assert(definition.message.length > 0, `${name}: message is required`);
    assert(
      definition.httpStatus === null ||
        (definition.httpStatus >= 400 && definition.httpStatus <= 599),
      `${name}: invalid HTTP status`,
    );
  }
});

Deno.test("only client-side events use a null HTTP status", () => {
  const nullStatusCodes = Object.entries(ErrorCode)
    .filter(([, definition]) => definition.httpStatus === null)
    .map(([name]) => name)
    .sort();

  assert(
    JSON.stringify(nullStatusCodes) === JSON.stringify([
      "NETWORK_UNAVAILABLE",
      "OAUTH_CANCELED",
      "REQUEST_TIMEOUT",
      "RESPONSE_DECODE_FAILED",
    ]),
    `unexpected null-status codes: ${nullStatusCodes.join(", ")}`,
  );
});

Deno.test("errorResponse returns the documented safe shape", async () => {
  const response = errorResponse("INVALID_INSTAGRAM_URL", "request-123", {
    headers: { "Access-Control-Allow-Origin": "*" },
    details: { field: "instagramUrl" },
  });
  const body = await response.json();

  assert(response.status === 400, "HTTP status must come from the registry");
  assert(
    response.headers.get("X-Request-Id") === "request-123",
    "request id header is missing",
  );
  assert(
    JSON.stringify(body) === JSON.stringify({
      status: 400,
      errorCode: "REEL400_001",
      message: "Instagram 게시물 주소를 확인해주세요.",
      retryable: false,
      requestId: "request-123",
      details: { field: "instagramUrl" },
    }),
    `unexpected error body: ${JSON.stringify(body)}`,
  );
});

Deno.test("request ids are non-empty and unique", () => {
  const first = createRequestId();
  const second = createRequestId();
  assert(first.length > 0, "request id must not be empty");
  assert(first !== second, "request ids must be unique");
});
