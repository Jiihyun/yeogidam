import { AiProviderError, AiProvidersExhaustedError } from "./errors.ts";
import { createFallbackPlaceAiClient } from "./fallback.ts";
import type { PlaceAiProvider, ProviderCallResult } from "./provider.ts";
import type { AiProviderName, PlaceGuess } from "./types.ts";

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

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof Error, "Expected an Error rejection");
    return error;
  }
  throw new Error("Expected promise to reject");
}

const ONE_PLACE: PlaceGuess[] = [{
  placeName: "보연희",
  address: null,
  addressType: "NONE",
  region: null,
}];

function provider(
  name: AiProviderName,
  extractPlaces: () => Promise<ProviderCallResult<PlaceGuess[]>>,
): PlaceAiProvider {
  return {
    name,
    extractPlaces,
    judgeKakaoCandidates: () =>
      Promise.resolve({ data: [], model: `${name}-judgment` }),
  };
}

Deno.test("returns the primary result without calling fallback", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const client = createFallbackPlaceAiClient(
    provider("gemini", () => {
      primaryCalls += 1;
      return Promise.resolve({ data: ONE_PLACE, model: "gemini-primary" });
    }),
    provider("openai", () => {
      fallbackCalls += 1;
      return Promise.resolve({ data: [], model: "openai-fallback" });
    }),
  );

  const result = await client.extractPlaces("보연희");

  assertEquals(result, {
    data: ONE_PLACE,
    model: "gemini-primary",
    provider: "gemini",
    fallbackUsed: false,
  });
  assertEquals({ primaryCalls, fallbackCalls }, {
    primaryCalls: 1,
    fallbackCalls: 0,
  });
});

Deno.test("falls back after a 429 rate limit error", async () => {
  let fallbackCalls = 0;
  const events: string[] = [];
  const client = createFallbackPlaceAiClient(
    provider("gemini", () =>
      Promise.reject(
        new AiProviderError("gemini", "PLACE_EXTRACTION", "RATE_LIMITED", {
          status: 429,
          model: "gemini-primary",
          retryable: true,
        }),
      )),
    provider("openai", () => {
      fallbackCalls += 1;
      return Promise.resolve({ data: ONE_PLACE, model: "openai-fallback" });
    }),
    { log: (event) => events.push(event) },
  );

  const result = await client.extractPlaces("보연희");

  assertEquals(result.provider, "openai");
  assertEquals(result.fallbackUsed, true);
  assertEquals(fallbackCalls, 1);
  assertEquals(events, [
    "ai_provider_call_failed",
    "ai_provider_fallback_started",
    "ai_provider_call_completed",
    "ai_provider_fallback_completed",
  ]);
});

Deno.test("does not fall back from a valid empty extraction", async () => {
  let fallbackCalls = 0;
  const client = createFallbackPlaceAiClient(
    provider(
      "gemini",
      () => Promise.resolve({ data: [], model: "gemini-primary" }),
    ),
    provider("openai", () => {
      fallbackCalls += 1;
      return Promise.resolve({ data: ONE_PLACE, model: "openai-fallback" });
    }),
  );

  const result = await client.extractPlaces("장소가 없는 캡션");

  assertEquals(result.data, []);
  assertEquals(result.provider, "gemini");
  assertEquals(result.fallbackUsed, false);
  assertEquals(fallbackCalls, 0);
});

Deno.test("does not fall back from an authentication error", async () => {
  let fallbackCalls = 0;
  const client = createFallbackPlaceAiClient(
    provider("gemini", () =>
      Promise.reject(
        new AiProviderError("gemini", "PLACE_EXTRACTION", "AUTH", {
          status: 401,
          model: "gemini-primary",
          retryable: false,
        }),
      )),
    provider("openai", () => {
      fallbackCalls += 1;
      return Promise.resolve({ data: ONE_PLACE, model: "openai-fallback" });
    }),
  );

  const error = await rejectedError(client.extractPlaces("보연희"));

  assert(error instanceof AiProvidersExhaustedError);
  assertEquals(error.attempts.map((attempt) => attempt.kind), ["AUTH"]);
  assertEquals(fallbackCalls, 0);
});

Deno.test("reports both attempts when primary and fallback fail", async () => {
  const client = createFallbackPlaceAiClient(
    provider("gemini", () =>
      Promise.reject(
        new AiProviderError("gemini", "PLACE_EXTRACTION", "RATE_LIMITED", {
          status: 429,
          retryable: true,
        }),
      )),
    provider("openai", () =>
      Promise.reject(
        new AiProviderError("openai", "PLACE_EXTRACTION", "UPSTREAM", {
          status: 503,
          retryable: true,
        }),
      )),
  );

  const error = await rejectedError(client.extractPlaces("보연희"));

  assert(error instanceof AiProvidersExhaustedError);
  assertEquals(
    error.attempts.map(({ provider, kind, status }) => ({
      provider,
      kind,
      status,
    })),
    [{ provider: "gemini", kind: "RATE_LIMITED", status: 429 }, {
      provider: "openai",
      kind: "UPSTREAM",
      status: 503,
    }],
  );
});

Deno.test("does not disguise an internal exception as a provider failure", async () => {
  let fallbackCalls = 0;
  const internalError = new TypeError("prompt builder bug");
  const client = createFallbackPlaceAiClient(
    provider("gemini", () => Promise.reject(internalError)),
    provider("openai", () => {
      fallbackCalls += 1;
      return Promise.resolve({ data: ONE_PLACE, model: "openai-fallback" });
    }),
  );

  const error = await rejectedError(client.extractPlaces("보연희"));

  assert(error === internalError);
  assertEquals(fallbackCalls, 0);
});
