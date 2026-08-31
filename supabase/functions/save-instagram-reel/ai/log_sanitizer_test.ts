import { sanitizeAiRuntimeLogDetails } from "./log_sanitizer.ts";

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

Deno.test("AI runtime log sanitizer retains fixed-shape operational metadata", () => {
  const details = sanitizeAiRuntimeLogDetails({
    operation: "PLACE_EXTRACTION",
    activatedOperation: "KAKAO_CANDIDATE_JUDGMENT",
    provider: "gemini",
    model: "gemini-2.5-flash",
    credentialRole: "Primary",
    credentialSlot: 1,
    quotaKind: "RPD",
    quotaScope: "DAY",
    classificationReason: "MISSING_QUOTA_SIGNAL",
    quotaIds: ["GenerateContentRequestsPerDay"],
    cooldownMs: 60_000,
    retryAt: "2026-08-31T12:00:00.000Z",
    retryHintSource: "RETRY_INFO",
    usage: { inputTokens: 123, outputTokens: 45 },
    fallbackUsed: false,
  });

  assertEquals(details, {
    operation: "PLACE_EXTRACTION",
    activatedOperation: "KAKAO_CANDIDATE_JUDGMENT",
    provider: "gemini",
    model: "gemini-2.5-flash",
    credentialRole: "Primary",
    quotaKind: "RPD",
    quotaScope: "DAY",
    classificationReason: "MISSING_QUOTA_SIGNAL",
    retryHintSource: "RETRY_INFO",
    quotaIds: ["GenerateContentRequestsPerDay"],
    usage: { inputTokens: 123, outputTokens: 45 },
    credentialSlot: 1,
    cooldownMs: 60_000,
    retryAt: "2026-08-31T12:00:00.000Z",
    fallbackUsed: false,
  });
});

Deno.test("AI runtime log sanitizer omits secret, prompt, and upstream body values", () => {
  const apiKey = ["AIza", "SecretKeyThatMustNeverReachLogs123456"].join("");
  const prompt = "private Instagram caption that must never reach logs";
  const rawBody = "private upstream error body";
  const details = sanitizeAiRuntimeLogDetails({
    operation: "PLACE_EXTRACTION",
    model: "gemini-2.5-flash",
    quotaKind: "UNKNOWN",
    apiKey,
    prompt,
    rawErrorBody: rawBody,
    errorBody: rawBody,
    message: rawBody,
    error: { message: rawBody, apiKey },
    classificationReason: `${prompt} ${apiKey}`,
    retryHintSource: rawBody,
    quotaIds: ["SafeQuota", rawBody],
    usage: { inputTokens: 3, rawBody, apiKey },
    nested: { prompt, rawBody, apiKey },
  });
  const text = JSON.stringify(details);

  assert(text.includes("PLACE_EXTRACTION"));
  assert(text.includes("gemini-2.5-flash"));
  assert(text.includes("SafeQuota"));
  assert(!text.includes(apiKey));
  assert(!text.includes(prompt));
  assert(!text.includes(rawBody));
  assert(!("classificationReason" in details));
  assert(!("retryHintSource" in details));
  assertEquals(details.usage, { inputTokens: 3 });
});
