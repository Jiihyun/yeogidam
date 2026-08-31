import { AiProviderError } from "../errors.ts";
import {
  createGeminiApiKeyStateStore,
  createGeminiProvider,
} from "./gemini.ts";
import type { KakaoCandidateReviewItem } from "../types.ts";

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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders,
  });
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  assert(typeof init?.body === "string", "Expected a JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

async function rejectedProviderError(
  promise: Promise<unknown>,
): Promise<AiProviderError> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof AiProviderError);
    return error;
  }
  throw new Error("Expected AiProviderError");
}

function reviewItem(): KakaoCandidateReviewItem {
  return {
    guessIndex: 3,
    guess: {
      placeName: "보연희",
      address: "서울 서대문구 연희맛로 17-63",
      addressType: "ROAD",
      region: "연희동",
    },
    captionContexts: ["보연희 서울 서대문구 연희맛로 17-63"],
    candidates: [{
      kakaoPlaceId: "candidate-3",
      name: "보연희",
      category: "음식점",
      roadAddress: "서울 서대문구 연희맛로 17-63",
      address: null,
      latitude: 37.0,
      longitude: 127.0,
      placeUrl: null,
      telephone: null,
    }],
  };
}

function emptyExtractionResponse(): Response {
  return jsonResponse({
    candidates: [{
      content: {
        parts: [{ text: JSON.stringify({ places: [] }) }],
      },
    }],
  });
}

function quotaErrorResponse(
  quotaId: string | readonly string[],
  retryDelay?: string,
  headers: HeadersInit = {},
): Response {
  const quotaIds = typeof quotaId === "string" ? [quotaId] : quotaId;
  return jsonResponse(
    {
      error: {
        message: "must never be logged",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: quotaIds.map((value) => ({ quotaId: value })),
          },
          ...(retryDelay
            ? [{
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay,
            }]
            : []),
        ],
      },
    },
    429,
    headers,
  );
}

Deno.test("Gemini extraction sends generateContent schema and parses response", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const request = ((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Promise.resolve(jsonResponse({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              places: [{
                placeName: " 보연희 ",
                address: null,
                addressType: "NONE",
                region: null,
              }],
            }),
          }],
        },
      }],
      usageMetadata: {
        promptTokenCount: 17,
        candidatesTokenCount: 8,
      },
    }));
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "secret key/+",
    extractionModel: "gemini/model",
    judgmentModel: "gemini-judge",
    timeoutMs: 5_000,
  }, { fetch: request, state: createGeminiApiKeyStateStore() });

  const result = await provider.extractPlaces("보연희에 다녀왔어요");

  assertEquals(
    capturedUrl,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini%2Fmodel:generateContent",
  );
  assertEquals(capturedInit?.method, "POST");
  const headers = new Headers(capturedInit?.headers);
  assertEquals(headers.get("Content-Type"), "application/json");
  assertEquals(headers.get("x-goog-api-key"), "secret key/+");
  const body = requestBody(capturedInit);
  const contents = body.contents as Array<{ parts: Array<{ text: string }> }>;
  assert(contents[0].parts[0].text.includes("보연희에 다녀왔어요"));
  const generationConfig = body.generationConfig as Record<string, unknown>;
  assertEquals(generationConfig.responseMimeType, "application/json");
  const schema = generationConfig.responseJsonSchema as {
    additionalProperties: boolean;
    properties: {
      places: {
        items: { properties: { address: Record<string, unknown> } };
      };
    };
  };
  assertEquals(schema.properties.places.items.properties.address, {
    type: ["string", "null"],
  });
  assertEquals(schema.additionalProperties, false);
  assertEquals(result, {
    data: [{
      placeName: "보연희",
      address: null,
      addressType: "NONE",
      region: null,
    }],
    model: "gemini/model",
    usage: { inputTokens: 17, outputTokens: 8 },
  });
});

Deno.test("Gemini judgment uses its model and parses every decision", async () => {
  const capture: { body?: Record<string, unknown> } = {};
  const request = ((
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    capture.body = requestBody(init);
    return Promise.resolve(jsonResponse({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              decisions: [{
                guessIndex: 3,
                decision: "SELECT",
                candidateId: "candidate-3",
                retryQueries: [],
                reason: "MATCH",
              }],
            }),
          }],
        },
      }],
    }));
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "key",
    extractionModel: "gemini-extract",
    judgmentModel: "gemini-judge",
    timeoutMs: 5_000,
  }, { fetch: request, state: createGeminiApiKeyStateStore() });

  const result = await provider.judgeKakaoCandidates("보연희", [reviewItem()]);

  assertEquals(result.data, [{
    guessIndex: 3,
    decision: "SELECT",
    candidateId: "candidate-3",
    retryQueries: [],
    reason: "MATCH",
  }]);
  assertEquals(result.model, "gemini-judge");
  const capturedBody = capture.body;
  assert(capturedBody !== undefined);
  const generationConfig = capturedBody.generationConfig as Record<
    string,
    unknown
  >;
  assertEquals(generationConfig.temperature, 0);
  const contents = capturedBody.contents as Array<{
    parts: Array<{ text: string }>;
  }>;
  assert(contents[0].parts[0].text.includes("candidate-3"));
});

Deno.test("Gemini maps HTTP 429 without making a real network request", async () => {
  const request =
    (() => Promise.resolve(jsonResponse({}, 429))) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "key",
    extractionModel: "gemini-extract",
    judgmentModel: "gemini-judge",
    timeoutMs: 5_000,
  }, { fetch: request, state: createGeminiApiKeyStateStore() });

  const error = await rejectedProviderError(provider.extractPlaces("보연희"));

  assertEquals({
    provider: error.provider,
    operation: error.operation,
    kind: error.kind,
    status: error.status,
    retryable: error.retryable,
  }, {
    provider: "gemini",
    operation: "PLACE_EXTRACTION",
    kind: "RATE_LIMITED",
    status: 429,
    retryable: true,
  });
});

Deno.test("Gemini logs exact RPM TPM and RPD quota classifications", async () => {
  const cases = [{
    quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
    quotaScope: "MINUTE",
    quotaKind: "RPM",
    retryHintSource: "MINUTE_DEFAULT",
    retryAt: "1970-01-01T00:01:00.000Z",
  }, {
    quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier",
    quotaScope: "MINUTE",
    quotaKind: "TPM",
    retryHintSource: "MINUTE_DEFAULT",
    retryAt: "1970-01-01T00:01:00.000Z",
  }, {
    quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
    quotaScope: "DAY",
    quotaKind: "RPD",
    retryHintSource: "PACIFIC_MIDNIGHT",
    retryAt: "1970-01-01T08:00:00.000Z",
  }];

  for (const expected of cases) {
    const events: Array<{ event: string; details: Record<string, unknown> }> =
      [];
    const provider = createGeminiProvider({
      apiKey: "primary-secret",
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: (() =>
        Promise.resolve(quotaErrorResponse(expected.quotaId))) as typeof fetch,
      log: (event, details) =>
        events.push({ event, details }),
      now: () =>
        0,
      state: createGeminiApiKeyStateStore(),
    });

    await rejectedProviderError(provider.extractPlaces("secret prompt"));

    const cooldown = events.find((entry) =>
      entry.event === "ai_gemini_api_key_cooldown_started"
    );
    assert(cooldown, "cooldown transition must be logged");
    assertEquals(cooldown.details, {
      operation: "PLACE_EXTRACTION",
      model: "gemini-model",
      credentialRole: "Primary",
      credentialSlot: 1,
      quotaScope: expected.quotaScope,
      quotaKind: expected.quotaKind,
      quotaIds: [expected.quotaId],
      cooldownMs: expected.quotaKind === "RPD" ? 8 * 60 * 60_000 : 60_000,
      retryAt: expected.retryAt,
      retryHintSource: expected.retryHintSource,
    });
    assert(
      !("classificationReason" in cooldown.details),
      "known quota must not have an UNKNOWN classification reason",
    );
    const serialized = JSON.stringify(events);
    assert(
      !serialized.includes("primary-secret"),
      "API key must not be logged",
    );
    assert(!serialized.includes("secret prompt"), "prompt must not be logged");
  }
});

Deno.test(
  "Gemini emits one fallback activation and one Primary recovery",
  async () => {
    let currentTime = 1_000_000;
    let primaryCalls = 0;
    const state = createGeminiApiKeyStateStore();
    const requestedKeys: Array<string | null> = [];
    const events: Array<{ event: string; details: Record<string, unknown> }> =
      [];
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key");
      requestedKeys.push(key);
      if (key === "primary-secret") {
        const call = primaryCalls++;
        if (call === 0) {
          return Promise.resolve(
            jsonResponse({ message: "response-secret" }, 429),
          );
        }
        if (call === 1) {
          return Promise.resolve(jsonResponse({
            candidates: [{
              content: {
                parts: [{ text: JSON.stringify({ places: "invalid" }) }],
              },
            }],
          }));
        }
      }

      const body = requestBody(init);
      const generationConfig = body.generationConfig as Record<string, unknown>;
      if (generationConfig.temperature === 0) {
        return Promise.resolve(jsonResponse({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  decisions: [{
                    guessIndex: 3,
                    decision: "SELECT",
                    candidateId: "candidate-3",
                    retryQueries: [],
                    reason: "MATCH",
                  }],
                }),
              }],
            },
          }],
        }));
      }
      return Promise.resolve(jsonResponse({
        candidates: [{
          content: {
            parts: [{ text: JSON.stringify({ places: [] }) }],
          },
        }],
      }));
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary-secret",
      fallbackApiKeys: ["fallback-secret"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      log: (event, details) => events.push({ event, details }),
      now: () => currentTime,
      state,
    });

    await provider.extractPlaces("장소가 없는 캡션");
    currentTime += 59_999;
    await provider.judgeKakaoCandidates("보연희", [reviewItem()]);
    assertEquals(events.map(({ event }) => event), [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_fallback_activated",
    ]);
    currentTime += 1;
    const invalidPrimary = await rejectedProviderError(
      provider.extractPlaces("계약 위반 Primary 응답"),
    );
    assertEquals(invalidPrimary.kind, "INVALID_RESPONSE");
    assertEquals(events.map(({ event }) => event), [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_fallback_activated",
    ]);
    await provider.extractPlaces("장소가 없는 캡션");

    assertEquals(requestedKeys, [
      "primary-secret",
      "fallback-secret",
      "fallback-secret",
      "primary-secret",
      "primary-secret",
    ]);
    assertEquals(events.map(({ event }) => event), [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_fallback_activated",
      "ai_gemini_primary_recovered",
    ]);
    assertEquals(events[0].details, {
      operation: "PLACE_EXTRACTION",
      model: "gemini-model",
      credentialRole: "Primary",
      credentialSlot: 1,
      quotaScope: "UNKNOWN",
      quotaKind: "UNKNOWN",
      classificationReason: "MISSING_ERROR_DETAILS",
      quotaIds: [],
      cooldownMs: 60_000,
      retryAt: "1970-01-01T00:17:40.000Z",
      retryHintSource: "ADAPTIVE_BACKOFF",
    });
    assertEquals(events[1].details, {
      operation: "PLACE_EXTRACTION",
      activatedOperation: "PLACE_EXTRACTION",
      model: "gemini-model",
      fromCredentialRole: "Primary",
      fromCredentialSlot: 1,
      toCredentialRole: "Fallback",
      toCredentialSlot: 2,
      quotaScope: "UNKNOWN",
      quotaKind: "UNKNOWN",
      classificationReason: "MISSING_ERROR_DETAILS",
      quotaIds: [],
      cooldownMs: 60_000,
      retryAt: "1970-01-01T00:17:40.000Z",
      retryHintSource: "ADAPTIVE_BACKOFF",
    });
    assertEquals(events[2].details, {
      operation: "PLACE_EXTRACTION",
      cooldownOperation: "PLACE_EXTRACTION",
      model: "gemini-model",
      credentialRole: "Primary",
      credentialSlot: 1,
      recoveredAt: "1970-01-01T00:17:40.000Z",
      quotaScope: "UNKNOWN",
      quotaKind: "UNKNOWN",
      classificationReason: "MISSING_ERROR_DETAILS",
      quotaIds: [],
      cooldownMs: 60_000,
      retryAt: "1970-01-01T00:17:40.000Z",
      retryHintSource: "ADAPTIVE_BACKOFF",
    });
    const serializedEvents = JSON.stringify(events);
    assert(!serializedEvents.includes("primary-secret"));
    assert(!serializedEvents.includes("fallback-secret"));
    assert(!serializedEvents.includes("response-secret"));
  },
);

Deno.test(
  "Gemini does not emit Fallback to Primary recovery when every key failed",
  async () => {
    let currentTime = 0;
    let quotaLimited = true;
    const requestedKeys: Array<string | null> = [];
    const events: string[] = [];
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      requestedKeys.push(new Headers(init?.headers).get("x-goog-api-key"));
      return Promise.resolve(
        quotaLimited
          ? quotaErrorResponse(
            "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
          )
          : emptyExtractionResponse(),
      );
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      log: (event) => events.push(event),
      now: () => currentTime,
      state: createGeminiApiKeyStateStore(),
    });

    await rejectedProviderError(provider.extractPlaces("모든 키 429"));
    quotaLimited = false;
    currentTime = 60_000;
    await provider.extractPlaces("Primary 직접 복구");

    assertEquals(requestedKeys, ["primary", "fallback", "primary"]);
    assertEquals(events, [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_keys_unavailable",
      "ai_gemini_service_recovered",
    ]);
    assert(
      !events.includes("ai_gemini_primary_recovered"),
      "Fallback never succeeded, so Fallback to Primary recovery must not fire",
    );
  },
);

Deno.test(
  "Gemini preserves an active Fallback route across another Primary 429",
  async () => {
    let currentTime = 0;
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const events: string[] = [];
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key");
      if (key === "primary") {
        primaryCalls += 1;
        return Promise.resolve(
          primaryCalls <= 2
            ? quotaErrorResponse(
              "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            )
            : emptyExtractionResponse(),
        );
      }
      fallbackCalls += 1;
      return Promise.resolve(
        fallbackCalls === 1 ? emptyExtractionResponse() : jsonResponse({}, 503),
      );
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      log: (event) => events.push(event),
      now: () => currentTime,
      state: createGeminiApiKeyStateStore(),
    });

    await provider.extractPlaces("Fallback 활성화");
    currentTime = 60_000;
    await rejectedProviderError(provider.extractPlaces("Primary 재실패"));
    currentTime = 120_000;
    await provider.extractPlaces("Primary 실제 복구");

    assertEquals(events, [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_fallback_activated",
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_primary_recovered",
    ]);
  },
);

Deno.test(
  "Gemini does not repeat the transition while Fallback remains active",
  async () => {
    let currentTime = 0;
    const events: string[] = [];
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key");
      return Promise.resolve(
        key === "primary"
          ? quotaErrorResponse(
            "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
          )
          : emptyExtractionResponse(),
      );
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      log: (event) => events.push(event),
      now: () => currentTime,
      state: createGeminiApiKeyStateStore(),
    });

    await provider.extractPlaces("첫 전환");
    currentTime = 60_000;
    await provider.extractPlaces("Primary probe 실패 후 Fallback 유지");

    assertEquals(events, [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_fallback_activated",
      "ai_gemini_api_key_cooldown_started",
    ]);
  },
);

Deno.test("Gemini Retry-After seconds override the default cooldown", async () => {
  let currentTime = 2_000_000;
  let primaryCalls = 0;
  const requestedKeys: Array<string | null> = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-goog-api-key");
    requestedKeys.push(key);
    if (key === "primary" && primaryCalls++ === 0) {
      return Promise.resolve(jsonResponse({}, 429, { "Retry-After": "120" }));
    }
    return Promise.resolve(emptyExtractionResponse());
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-extract",
    judgmentModel: "gemini-judge",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    now: () => currentTime,
    state: createGeminiApiKeyStateStore(),
  });

  await provider.extractPlaces("첫 호출");
  currentTime += 119_999;
  await provider.extractPlaces("cooldown 중");
  currentTime += 1;
  await provider.extractPlaces("cooldown 만료");

  assertEquals(requestedKeys, ["primary", "fallback", "fallback", "primary"]);
});

Deno.test("Gemini honors an HTTP-date Retry-After value", async () => {
  let currentTime = Date.parse("2026-08-31T00:00:00Z");
  let primaryCalls = 0;
  const requestedKeys: Array<string | null> = [];
  const retryAt = new Date(currentTime + 90_000).toUTCString();
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-goog-api-key");
    requestedKeys.push(key);
    if (key === "primary" && primaryCalls++ === 0) {
      return Promise.resolve(jsonResponse({}, 429, { "Retry-After": retryAt }));
    }
    return Promise.resolve(emptyExtractionResponse());
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-extract",
    judgmentModel: "gemini-judge",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    now: () => currentTime,
    state: createGeminiApiKeyStateStore(),
  });

  await provider.extractPlaces("첫 호출");
  currentTime += 89_999;
  await provider.extractPlaces("cooldown 중");
  currentTime += 1;
  await provider.extractPlaces("cooldown 만료");

  assertEquals(requestedKeys, ["primary", "fallback", "fallback", "primary"]);
});

Deno.test(
  "Gemini cools an RPD quota until the next Los Angeles midnight across DST",
  async () => {
    let currentTime = Date.parse("2026-03-08T09:00:00Z");
    const nextMidnight = Date.parse("2026-03-09T07:00:00Z");
    let primaryCalls = 0;
    const requestedKeys: Array<string | null> = [];
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key");
      requestedKeys.push(key);
      if (key === "primary" && primaryCalls++ === 0) {
        return Promise.resolve(quotaErrorResponse(
          "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
        ));
      }
      return Promise.resolve(emptyExtractionResponse());
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      now: () => currentTime,
      state: createGeminiApiKeyStateStore(),
    });

    await provider.extractPlaces("첫 호출");
    currentTime = nextMidnight - 1;
    await provider.extractPlaces("자정 직전");
    currentTime = nextMidnight;
    await provider.extractPlaces("자정");

    assertEquals(requestedKeys, ["primary", "fallback", "fallback", "primary"]);
  },
);

Deno.test("Gemini honors a longer structured RetryInfo delay", async () => {
  let currentTime = 0;
  let primaryCalls = 0;
  const requestedKeys: Array<string | null> = [];
  const events: Array<{ event: string; details: Record<string, unknown> }> = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-goog-api-key");
    requestedKeys.push(key);
    if (key === "primary" && primaryCalls++ === 0) {
      return Promise.resolve(quotaErrorResponse("unclassified-quota", "300s"));
    }
    return Promise.resolve(emptyExtractionResponse());
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-model",
    judgmentModel: "gemini-model",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    log: (event, details) => events.push({ event, details }),
    now: () => currentTime,
    state: createGeminiApiKeyStateStore(),
  });

  await provider.extractPlaces("첫 호출");
  currentTime = 299_999;
  await provider.extractPlaces("RetryInfo 중");
  currentTime = 300_000;
  await provider.extractPlaces("RetryInfo 만료");

  assertEquals(requestedKeys, ["primary", "fallback", "fallback", "primary"]);
  assertEquals(events[0], {
    event: "ai_gemini_api_key_cooldown_started",
    details: {
      operation: "PLACE_EXTRACTION",
      model: "gemini-model",
      credentialRole: "Primary",
      credentialSlot: 1,
      quotaScope: "UNKNOWN",
      quotaKind: "UNKNOWN",
      classificationReason: "UNRECOGNIZED_QUOTA_SIGNAL",
      quotaIds: ["unclassified-quota"],
      cooldownMs: 300_000,
      retryAt: "1970-01-01T00:05:00.000Z",
      retryHintSource: "RETRY_INFO",
    },
  });
});

Deno.test("Gemini safely ignores malformed and oversized 429 bodies", async () => {
  const errorResponses = [
    {
      response: () => new Response(null, { status: 429 }),
      reason: "EMPTY_ERROR_BODY",
    },
    {
      response: () =>
        new Response("{malformed", {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      reason: "INVALID_ERROR_JSON",
    },
    {
      response: () =>
        new Response(JSON.stringify({ error: "x".repeat(40_000) }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "40000",
          },
        }),
      reason: "ERROR_BODY_TOO_LARGE",
    },
    {
      response: () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("read failed"));
            },
          }),
          { status: 429 },
        ),
      reason: "ERROR_BODY_READ_FAILED",
    },
  ];

  for (const errorResponse of errorResponses) {
    const requestedKeys: Array<string | null> = [];
    const events: Array<{ event: string; details: Record<string, unknown> }> =
      [];
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key");
      requestedKeys.push(key);
      return Promise.resolve(
        key === "primary"
          ? errorResponse.response()
          : emptyExtractionResponse(),
      );
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      log: (event, details) => events.push({ event, details }),
      now: () => 0,
      state: createGeminiApiKeyStateStore(),
    });

    await provider.extractPlaces("보연희");
    assertEquals(requestedKeys, ["primary", "fallback"]);
    assertEquals(events[0], {
      event: "ai_gemini_api_key_cooldown_started",
      details: {
        operation: "PLACE_EXTRACTION",
        model: "gemini-model",
        credentialRole: "Primary",
        credentialSlot: 1,
        quotaScope: "UNKNOWN",
        quotaKind: "UNKNOWN",
        classificationReason: errorResponse.reason,
        quotaIds: [],
        cooldownMs: 60_000,
        retryAt: "1970-01-01T00:01:00.000Z",
        retryHintSource: "ADAPTIVE_BACKOFF",
      },
    });
  }
});

Deno.test(
  "Gemini rotates after a received 429 whose error body read times out",
  async () => {
    const requestedKeys: Array<string | null> = [];
    const events: Array<{ event: string; details: Record<string, unknown> }> =
      [];
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key");
      requestedKeys.push(key);
      if (key === "primary") {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({ start() {} }),
            { status: 429 },
          ),
        );
      }
      return Promise.resolve(emptyExtractionResponse());
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5,
    }, {
      fetch: request,
      log: (event, details) => events.push({ event, details }),
      now: () => 0,
      state: createGeminiApiKeyStateStore(),
    });

    const result = await provider.extractPlaces("보연희");

    assertEquals(result.data, []);
    assertEquals(requestedKeys, ["primary", "fallback"]);
    const cooldown = events.find((entry) =>
      entry.event === "ai_gemini_api_key_cooldown_started"
    );
    assert(cooldown);
    assertEquals({
      quotaScope: cooldown.details.quotaScope,
      quotaKind: cooldown.details.quotaKind,
      classificationReason: cooldown.details.classificationReason,
      cooldownMs: cooldown.details.cooldownMs,
      retryHintSource: cooldown.details.retryHintSource,
    }, {
      quotaScope: "UNKNOWN",
      quotaKind: "UNKNOWN",
      classificationReason: "ERROR_BODY_READ_TIMEOUT",
      cooldownMs: 60_000,
      retryHintSource: "ADAPTIVE_BACKOFF",
    });
  },
);

Deno.test(
  "Gemini UNKNOWN quotas use adaptive backoff even with minute or day scope",
  async () => {
    const cases = [{
      quotaIds: [
        "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
        "GenerateContentInputTokensPerModelPerMinute-FreeTier",
      ],
      quotaScope: "MINUTE",
      classificationReason: "AMBIGUOUS_QUOTA_KIND",
    }, {
      quotaIds: ["GenerateContentInputTokensPerModelPerDay-FreeTier"],
      quotaScope: "DAY",
      classificationReason: "UNRECOGNIZED_QUOTA_SIGNAL",
    }] as const;
    const failureTimes = [0, 60_000, 360_000, 2_160_000];
    const expectedCooldowns = [60_000, 300_000, 1_800_000, 7_200_000];

    for (const scenario of cases) {
      let currentTime = 0;
      const events: Array<{
        event: string;
        details: Record<string, unknown>;
      }> = [];
      const provider = createGeminiProvider({
        apiKey: "primary",
        extractionModel: "gemini-model",
        judgmentModel: "gemini-model",
        timeoutMs: 5_000,
      }, {
        fetch: (() =>
          Promise.resolve(
            quotaErrorResponse(scenario.quotaIds),
          )) as typeof fetch,
        log: (event, details) => events.push({ event, details }),
        now: () => currentTime,
        state: createGeminiApiKeyStateStore(),
      });

      for (const failureTime of failureTimes) {
        currentTime = failureTime;
        await rejectedProviderError(
          provider.extractPlaces("UNKNOWN quota 재시도"),
        );
      }

      const cooldowns = events.filter((entry) =>
        entry.event === "ai_gemini_api_key_cooldown_started"
      );
      assertEquals(
        cooldowns.map(({ details }) => ({
          quotaScope: details.quotaScope,
          quotaKind: details.quotaKind,
          classificationReason: details.classificationReason,
          quotaIds: details.quotaIds,
          cooldownMs: details.cooldownMs,
          retryHintSource: details.retryHintSource,
        })),
        expectedCooldowns.map((cooldownMs) => ({
          quotaScope: scenario.quotaScope,
          quotaKind: "UNKNOWN",
          classificationReason: scenario.classificationReason,
          quotaIds: [...scenario.quotaIds],
          cooldownMs,
          retryHintSource: "ADAPTIVE_BACKOFF",
        })),
      );
    }
  },
);

Deno.test("Gemini unknown 429 cooldown grows to a two hour cap", async () => {
  let currentTime = 0;
  let requestCount = 0;
  const request = (() => {
    requestCount += 1;
    return Promise.resolve(jsonResponse({}, 429));
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    extractionModel: "gemini-model",
    judgmentModel: "gemini-model",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    now: () => currentTime,
    state: createGeminiApiKeyStateStore(),
  });

  await rejectedProviderError(provider.extractPlaces("첫 429"));
  currentTime = 60_000;
  await rejectedProviderError(provider.extractPlaces("두 번째 429"));
  currentTime = 120_000;
  await rejectedProviderError(provider.extractPlaces("5분 cooldown 중"));
  currentTime = 360_000;
  await rejectedProviderError(provider.extractPlaces("5분 cooldown 만료"));
  currentTime = 2_159_999;
  await rejectedProviderError(provider.extractPlaces("30분 cooldown 중"));
  currentTime = 2_160_000;
  await rejectedProviderError(provider.extractPlaces("30분 cooldown 만료"));
  currentTime = 9_359_999;
  await rejectedProviderError(provider.extractPlaces("2시간 cooldown 중"));
  currentTime = 9_360_000;
  await rejectedProviderError(provider.extractPlaces("2시간 cooldown 만료"));
  currentTime = 16_559_999;
  await rejectedProviderError(provider.extractPlaces("2시간 cap 유지 중"));
  currentTime = 16_560_000;
  await rejectedProviderError(provider.extractPlaces("2시간 cap 만료"));

  assertEquals(requestCount, 6);
});

Deno.test("Gemini per-minute quota honors a shorter server retry delay", async () => {
  let currentTime = 0;
  let primaryCalls = 0;
  const requestedKeys: Array<string | null> = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-goog-api-key");
    requestedKeys.push(key);
    if (key === "primary" && primaryCalls++ === 0) {
      return Promise.resolve(quotaErrorResponse(
        "GenerateContentInputTokensPerModelPerMinute-FreeTier",
        undefined,
        { "Retry-After": "5" },
      ));
    }
    return Promise.resolve(emptyExtractionResponse());
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-model",
    judgmentModel: "gemini-model",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    now: () => currentTime,
    state: createGeminiApiKeyStateStore(),
  });

  await provider.extractPlaces("첫 TPM");
  currentTime = 4_999;
  await provider.extractPlaces("서버 대기 시간 중");
  currentTime = 5_000;
  await provider.extractPlaces("서버 대기 시간 만료");

  assertEquals(requestedKeys, ["primary", "fallback", "fallback", "primary"]);
});

Deno.test("Gemini per-minute quota defaults to 60 seconds without a server hint", async () => {
  let currentTime = 0;
  let primaryCalls = 0;
  const requestedKeys: Array<string | null> = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-goog-api-key");
    requestedKeys.push(key);
    if (key === "primary" && primaryCalls++ === 0) {
      return Promise.resolve(quotaErrorResponse(
        "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
      ));
    }
    return Promise.resolve(emptyExtractionResponse());
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-model",
    judgmentModel: "gemini-model",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    now: () => currentTime,
    state: createGeminiApiKeyStateStore(),
  });

  await provider.extractPlaces("첫 RPM");
  currentTime = 59_999;
  await provider.extractPlaces("기본 대기 시간 중");
  currentTime = 60_000;
  await provider.extractPlaces("기본 대기 시간 만료");

  assertEquals(requestedKeys, ["primary", "fallback", "fallback", "primary"]);
});

Deno.test("Gemini per-minute quota uses the longer server retry hint", async () => {
  let currentTime = 0;
  let primaryCalls = 0;
  const requestedKeys: Array<string | null> = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-goog-api-key");
    requestedKeys.push(key);
    if (key === "primary" && primaryCalls++ === 0) {
      return Promise.resolve(quotaErrorResponse(
        "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
        "12s",
        { "Retry-After": "5" },
      ));
    }
    return Promise.resolve(emptyExtractionResponse());
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-model",
    judgmentModel: "gemini-model",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    now: () => currentTime,
    state: createGeminiApiKeyStateStore(),
  });

  await provider.extractPlaces("첫 RPM");
  currentTime = 11_999;
  await provider.extractPlaces("긴 서버 대기 시간 중");
  currentTime = 12_000;
  await provider.extractPlaces("긴 서버 대기 시간 만료");

  assertEquals(requestedKeys, ["primary", "fallback", "fallback", "primary"]);
});

Deno.test("Gemini per-minute quota honors an explicit zero retry delay", async () => {
  let currentTime = 0;
  let primaryCalls = 0;
  const requestedKeys: Array<string | null> = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-goog-api-key");
    requestedKeys.push(key);
    if (key === "primary" && primaryCalls++ === 0) {
      return Promise.resolve(quotaErrorResponse(
        "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
        undefined,
        { "Retry-After": "0" },
      ));
    }
    return Promise.resolve(emptyExtractionResponse());
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-model",
    judgmentModel: "gemini-model",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    now: () => currentTime,
    state: createGeminiApiKeyStateStore(),
  });

  await provider.extractPlaces("첫 RPM");
  await provider.extractPlaces("즉시 재시도 허용");

  assertEquals(requestedKeys, ["primary", "fallback", "primary"]);
});

Deno.test("Gemini success resets the unknown 429 strike", async () => {
  let currentTime = 0;
  let requestCount = 0;
  const request = (() => {
    requestCount += 1;
    return Promise.resolve(
      requestCount === 2 ? emptyExtractionResponse() : jsonResponse({}, 429),
    );
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    extractionModel: "gemini-model",
    judgmentModel: "gemini-model",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    now: () => currentTime,
    state: createGeminiApiKeyStateStore(),
  });

  await rejectedProviderError(provider.extractPlaces("첫 429"));
  currentTime = 60_000;
  await provider.extractPlaces("성공");
  await rejectedProviderError(provider.extractPlaces("reset 뒤 429"));
  currentTime = 120_000;
  await rejectedProviderError(provider.extractPlaces("1분 뒤 재시도"));

  assertEquals(requestCount, 4);
});

Deno.test("Gemini known 429 does not reset the unknown strike", async () => {
  let currentTime = 0;
  let requestCount = 0;
  const cooldowns: number[] = [];
  const request = (() => {
    requestCount += 1;
    if (requestCount === 2) {
      return Promise.resolve(quotaErrorResponse(
        "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
      ));
    }
    return Promise.resolve(jsonResponse({}, 429));
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    extractionModel: "gemini-model",
    judgmentModel: "gemini-model",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    log: (event, details) => {
      if (event === "ai_gemini_api_key_cooldown_started") {
        cooldowns.push(Number(details.cooldownMs));
      }
    },
    now: () => currentTime,
    state: createGeminiApiKeyStateStore(),
  });

  await rejectedProviderError(provider.extractPlaces("첫 UNKNOWN"));
  currentTime = 60_000;
  await rejectedProviderError(provider.extractPlaces("중간 RPM"));
  currentTime = 120_000;
  await rejectedProviderError(provider.extractPlaces("두 번째 UNKNOWN"));

  assertEquals(cooldowns, [60_000, 60_000, 5 * 60_000]);
});

Deno.test("Gemini providers share cooldown through their state store", async () => {
  const requestedKeys: Array<string | null> = [];
  const state = createGeminiApiKeyStateStore();
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-goog-api-key");
    requestedKeys.push(key);
    return Promise.resolve(
      key === "primary" ? jsonResponse({}, 429) : emptyExtractionResponse(),
    );
  }) as typeof fetch;
  const config = {
    apiKey: "primary",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-extract",
    judgmentModel: "gemini-judge",
    timeoutMs: 5_000,
  };

  await createGeminiProvider(config, { fetch: request, state }).extractPlaces(
    "첫 client",
  );
  await createGeminiProvider(config, { fetch: request, state }).extractPlaces(
    "새 client",
  );

  assertEquals(requestedKeys, ["primary", "fallback", "fallback"]);
});

Deno.test("Gemini cooldown is isolated by model", async () => {
  let extractionPrimaryCalls = 0;
  const requestedKeys: Array<string | null> = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-goog-api-key");
    requestedKeys.push(key);
    const body = requestBody(init);
    const generationConfig = body.generationConfig as Record<string, unknown>;
    if (
      generationConfig.temperature !== 0 && key === "primary" &&
      extractionPrimaryCalls++ === 0
    ) return Promise.resolve(jsonResponse({}, 429));
    if (generationConfig.temperature === 0) {
      return Promise.resolve(jsonResponse({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                decisions: [{
                  guessIndex: 3,
                  decision: "SELECT",
                  candidateId: "candidate-3",
                  retryQueries: [],
                  reason: "MATCH",
                }],
              }),
            }],
          },
        }],
      }));
    }
    return Promise.resolve(emptyExtractionResponse());
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-extract",
    judgmentModel: "gemini-judge",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    state: createGeminiApiKeyStateStore(),
  });

  await provider.extractPlaces("보연희");
  await provider.judgeKakaoCandidates("보연희", [reviewItem()]);

  assertEquals(requestedKeys, ["primary", "fallback", "primary"]);
});

Deno.test(
  "Gemini does not let an older Primary success clear a newer zero-delay cooldown",
  async () => {
    const oldPrimaryResponse = deferred<Response>();
    let primaryCalls = 0;
    const requestedKeys: Array<string | null> = [];
    const events: string[] = [];
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key");
      requestedKeys.push(key);
      if (key === "primary") {
        const call = primaryCalls++;
        if (call === 0) return oldPrimaryResponse.promise;
        if (call === 1) {
          return Promise.resolve(quotaErrorResponse(
            "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            undefined,
            { "Retry-After": "0" },
          ));
        }
      }
      return Promise.resolve(emptyExtractionResponse());
    }) as typeof fetch;
    const state = createGeminiApiKeyStateStore();
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      log: (event) => events.push(event),
      now: () => 0,
      state,
    });

    const olderSuccess = provider.extractPlaces("먼저 시작한 요청");
    await provider.extractPlaces("더 늦게 429를 받은 요청");
    assertEquals(events, [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_fallback_activated",
    ]);

    oldPrimaryResponse.resolve(emptyExtractionResponse());
    await olderSuccess;
    assertEquals(state.cooldowns.size, 1);
    assertEquals(events, [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_fallback_activated",
    ]);

    await provider.extractPlaces("cooldown generation을 관찰한 probe");
    assertEquals(requestedKeys, [
      "primary",
      "primary",
      "fallback",
      "primary",
    ]);
    assertEquals(events, [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_fallback_activated",
      "ai_gemini_primary_recovered",
    ]);
  },
);

Deno.test(
  "Gemini skips a Fallback cooled by another request while Primary is in flight",
  async () => {
    const olderPrimaryResponse = deferred<Response>();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const requestedKeys: Array<string | null> = [];
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key");
      requestedKeys.push(key);
      if (key === "primary" && primaryCalls++ === 0) {
        return olderPrimaryResponse.promise;
      }
      if (key === "fallback") fallbackCalls += 1;
      return Promise.resolve(quotaErrorResponse(
        "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
      ));
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      now: () => 0,
      state: createGeminiApiKeyStateStore(),
    });

    const olderRequest = provider.extractPlaces("먼저 시작한 Primary");
    await rejectedProviderError(provider.extractPlaces("동시 cooldown 생성"));
    olderPrimaryResponse.resolve(quotaErrorResponse(
      "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
    ));
    await rejectedProviderError(olderRequest);

    assertEquals(requestedKeys, ["primary", "primary", "fallback"]);
    assertEquals(fallbackCalls, 1);
  },
);

Deno.test(
  "Gemini uses a Fallback that becomes eligible while Primary is in flight",
  async () => {
    let currentTime = 0;
    const inFlightPrimaryResponse = deferred<Response>();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const requestedKeys: Array<string | null> = [];
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key");
      requestedKeys.push(key);
      if (key === "primary") {
        const call = primaryCalls++;
        if (call === 0) {
          return Promise.resolve(quotaErrorResponse(
            "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            undefined,
            { "Retry-After": "0" },
          ));
        }
        return inFlightPrimaryResponse.promise;
      }
      fallbackCalls += 1;
      return Promise.resolve(
        fallbackCalls === 1
          ? quotaErrorResponse(
            "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
          )
          : emptyExtractionResponse(),
      );
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      now: () => currentTime,
      state: createGeminiApiKeyStateStore(),
    });

    await rejectedProviderError(provider.extractPlaces("초기 cooldown 구성"));
    const resultPromise = provider.extractPlaces("Primary in flight");
    currentTime = 60_000;
    inFlightPrimaryResponse.resolve(quotaErrorResponse(
      "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
    ));
    const result = await resultPromise;

    assertEquals(result.data, []);
    assertEquals(requestedKeys, [
      "primary",
      "fallback",
      "primary",
      "fallback",
    ]);
  },
);

Deno.test(
  "Gemini stale Fallback success cannot activate or recover a newer cooldown",
  async () => {
    let currentTime = 0;
    let fallbackCalls = 0;
    const staleFallbackResponse = deferred<Response>();
    const newerFallbackResponse = deferred<Response>();
    const events: string[] = [];
    const state = createGeminiApiKeyStateStore();
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key");
      if (key === "primary") {
        return Promise.resolve(quotaErrorResponse(
          "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
        ));
      }
      fallbackCalls += 1;
      if (fallbackCalls === 1) {
        return Promise.resolve(quotaErrorResponse(
          "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
        ));
      }
      if (fallbackCalls === 2) return staleFallbackResponse.promise;
      if (fallbackCalls === 3) return newerFallbackResponse.promise;
      return Promise.resolve(emptyExtractionResponse());
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      log: (event) => events.push(event),
      now: () => currentTime,
      state,
    });

    await rejectedProviderError(provider.extractPlaces("outage 생성"));
    currentTime = 60_000;
    const staleSuccess = provider.extractPlaces("오래된 fallback probe");
    const newerFailure = provider.extractPlaces("새 fallback probe");
    newerFallbackResponse.resolve(quotaErrorResponse(
      "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
    ));
    await rejectedProviderError(newerFailure);
    staleFallbackResponse.resolve(emptyExtractionResponse());
    await staleSuccess;

    assertEquals(events, [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_keys_unavailable",
      "ai_gemini_api_key_cooldown_started",
    ]);
    assertEquals(state.cooldowns.size, 2);
    assertEquals(state.unavailableServices.size, 1);

    currentTime = 120_000;
    await provider.extractPlaces("generation 관찰 후 fallback 복구");
    assertEquals(events, [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_keys_unavailable",
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_fallback_activated",
      "ai_gemini_service_recovered",
    ]);
  },
);

Deno.test(
  "Gemini retained Primary cooldown keeps an in-flight Fallback transition eligible",
  async () => {
    const latePrimaryResponse = deferred<Response>();
    const fallbackSuccessResponse = deferred<Response>();
    const fallbackStarted = deferred<void>();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const events: string[] = [];
    const state = createGeminiApiKeyStateStore();
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key");
      if (key === "primary") {
        primaryCalls += 1;
        return primaryCalls === 1
          ? latePrimaryResponse.promise
          : Promise.resolve(quotaErrorResponse(
            "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
          ));
      }
      fallbackCalls += 1;
      if (fallbackCalls === 1) {
        fallbackStarted.resolve();
        return fallbackSuccessResponse.promise;
      }
      return Promise.resolve(jsonResponse({}, 503));
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      log: (event) => events.push(event),
      now: () => 0,
      state,
    });

    const latePrimaryFailure = provider.extractPlaces("먼저 시작한 Primary");
    const routedFallbackSuccess = provider.extractPlaces("긴 cooldown 요청");
    await fallbackStarted.promise;
    latePrimaryResponse.resolve(quotaErrorResponse(
      "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
    ));
    await rejectedProviderError(latePrimaryFailure);
    fallbackSuccessResponse.resolve(emptyExtractionResponse());
    await routedFallbackSuccess;

    assertEquals(events, [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_fallback_activated",
    ]);
    const primaryCooldown = [...state.cooldowns.values()].find((cooldown) =>
      cooldown.credentialSlot === 1
    );
    assert(primaryCooldown);
    assertEquals({
      fallbackActivationPending: primaryCooldown.fallbackActivationPending,
      fallbackActivated: primaryCooldown.fallbackActivated,
      quotaKind: primaryCooldown.quotaKind,
      cooldownUntilMs: primaryCooldown.cooldownUntilMs,
    }, {
      fallbackActivationPending: false,
      fallbackActivated: true,
      quotaKind: "RPD",
      cooldownUntilMs: 8 * 60 * 60_000,
    });
  },
);

Deno.test(
  "Gemini concurrent 429 responses never shorten an existing cooldown",
  async () => {
    let currentTime = 0;
    let requestCount = 0;
    const shortResponse = deferred<Response>();
    const longResponse = deferred<Response>();
    const state = createGeminiApiKeyStateStore();
    const request = (() => {
      const call = requestCount++;
      if (call === 0) return shortResponse.promise;
      if (call === 1) return longResponse.promise;
      return Promise.resolve(emptyExtractionResponse());
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      now: () => currentTime,
      state,
    });

    const lateShortFailure = provider.extractPlaces("늦은 짧은 429");
    const earlyLongFailure = provider.extractPlaces("먼저 긴 429");
    longResponse.resolve(quotaErrorResponse(
      "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
    ));
    await rejectedProviderError(earlyLongFailure);
    shortResponse.resolve(quotaErrorResponse(
      "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
    ));
    await rejectedProviderError(lateShortFailure);

    const cooldown = [...state.cooldowns.values()][0];
    assert(cooldown);
    assertEquals({
      cooldownUntilMs: cooldown.cooldownUntilMs,
      cooldownMs: cooldown.cooldownMs,
      quotaScope: cooldown.quotaScope,
      quotaKind: cooldown.quotaKind,
      retryAt: cooldown.retryAt,
      retryHintSource: cooldown.retryHintSource,
    }, {
      cooldownUntilMs: 8 * 60 * 60_000,
      cooldownMs: 8 * 60 * 60_000,
      quotaScope: "DAY",
      quotaKind: "RPD",
      retryAt: "1970-01-01T08:00:00.000Z",
      retryHintSource: "PACIFIC_MIDNIGHT",
    });

    currentTime = 60_000;
    await rejectedProviderError(provider.extractPlaces("짧은 cooldown 이후"));
    assertEquals(requestCount, 2);
    currentTime = 8 * 60 * 60_000;
    await provider.extractPlaces("긴 cooldown 이후");
    assertEquals(requestCount, 3);
  },
);

Deno.test("Gemini tries ordered fallback keys and preserves the last 429", async () => {
  const requestedKeys: Array<string | null> = [];
  const events: string[] = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    requestedKeys.push(new Headers(init?.headers).get("x-goog-api-key"));
    return Promise.resolve(jsonResponse({}, 429));
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback-one", "fallback-two"],
    extractionModel: "gemini-extract",
    judgmentModel: "gemini-judge",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    log: (event) => events.push(event),
    state: createGeminiApiKeyStateStore(),
  });

  const error = await rejectedProviderError(provider.extractPlaces("보연희"));

  assertEquals(requestedKeys, ["primary", "fallback-one", "fallback-two"]);
  assertEquals({ kind: error.kind, status: error.status }, {
    kind: "RATE_LIMITED",
    status: 429,
  });
  assertEquals(events, [
    "ai_gemini_api_key_cooldown_started",
    "ai_gemini_api_key_cooldown_started",
    "ai_gemini_api_key_cooldown_started",
    "ai_gemini_api_keys_unavailable",
  ]);
});

Deno.test("Gemini returns a typed 429 while every key is cooling down", async () => {
  let requestCount = 0;
  const events: string[] = [];
  const request = (() => {
    requestCount += 1;
    return Promise.resolve(jsonResponse({}, 429));
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-extract",
    judgmentModel: "gemini-judge",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    log: (event) => events.push(event),
    now: () => 10_000,
    state: createGeminiApiKeyStateStore(),
  });

  await rejectedProviderError(provider.extractPlaces("첫 호출"));
  const error = await rejectedProviderError(
    provider.extractPlaces("후속 호출"),
  );

  assertEquals(requestCount, 2);
  assertEquals({ kind: error.kind, status: error.status }, {
    kind: "RATE_LIMITED",
    status: 429,
  });
  assertEquals(
    events.filter((event) => event === "ai_gemini_api_keys_unavailable"),
    ["ai_gemini_api_keys_unavailable"],
  );
});

Deno.test(
  "Gemini emits service recovery only after an unavailable service actually succeeds",
  async () => {
    let currentTime = Date.parse("2026-08-31T00:00:00Z");
    let fallbackCalls = 0;
    const requestedKeys: Array<string | null> = [];
    const events: Array<{ event: string; details: Record<string, unknown> }> =
      [];
    const request = ((_input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-goog-api-key");
      requestedKeys.push(key);
      if (key === "primary") {
        return Promise.resolve(quotaErrorResponse(
          "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
        ));
      }
      fallbackCalls += 1;
      if (fallbackCalls === 1) {
        return Promise.resolve(quotaErrorResponse(
          "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
        ));
      }
      if (fallbackCalls === 2) {
        return Promise.resolve(jsonResponse({
          candidates: [{
            content: {
              parts: [{ text: JSON.stringify({ places: null }) }],
            },
          }],
        }));
      }
      return Promise.resolve(emptyExtractionResponse());
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      log: (event, details) => events.push({ event, details }),
      now: () => currentTime,
      state: createGeminiApiKeyStateStore(),
    });

    await rejectedProviderError(provider.extractPlaces("첫 호출"));
    await rejectedProviderError(provider.extractPlaces("모두 cooldown 중"));
    assertEquals(events.map(({ event }) => event), [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_keys_unavailable",
    ]);

    currentTime += 60_000;
    const invalidFallback = await rejectedProviderError(
      provider.extractPlaces("계약 위반 fallback 응답"),
    );
    assertEquals(invalidFallback.kind, "INVALID_RESPONSE");
    assertEquals(events.map(({ event }) => event), [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_keys_unavailable",
    ]);
    await provider.extractPlaces("fallback 복구");
    await provider.extractPlaces("반복 성공");

    assertEquals(requestedKeys, [
      "primary",
      "fallback",
      "fallback",
      "fallback",
      "fallback",
    ]);
    assertEquals(events.map(({ event }) => event), [
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_key_cooldown_started",
      "ai_gemini_api_keys_unavailable",
      "ai_gemini_api_key_fallback_activated",
      "ai_gemini_service_recovered",
    ]);
    assertEquals(events[2].details, {
      operation: "PLACE_EXTRACTION",
      model: "gemini-model",
      credentialRole: "Fallback",
      credentialSlot: 2,
      triggeringCredentialRole: "Fallback",
      triggeringCredentialSlot: 2,
      credentialCount: 2,
      incidentId: 1,
      unavailableAt: "2026-08-31T00:00:00.000Z",
      quotaScope: "MINUTE",
      quotaKind: "RPM",
      quotaIds: ["GenerateRequestsPerMinutePerProjectPerModel-FreeTier"],
      cooldownMs: 60_000,
      retryAt: "2026-08-31T00:01:00.000Z",
      retryHintSource: "MINUTE_DEFAULT",
    });
    assertEquals(events[4].details, {
      operation: "PLACE_EXTRACTION",
      unavailableOperation: "PLACE_EXTRACTION",
      model: "gemini-model",
      credentialRole: "Fallback",
      credentialSlot: 2,
      incidentId: 1,
      unavailableAt: "2026-08-31T00:00:00.000Z",
      recoveredAt: "2026-08-31T00:01:00.000Z",
      quotaScope: "MINUTE",
      quotaKind: "RPM",
      quotaIds: ["GenerateRequestsPerMinutePerProjectPerModel-FreeTier"],
      cooldownMs: 60_000,
      retryAt: "2026-08-31T00:01:00.000Z",
      retryHintSource: "MINUTE_DEFAULT",
    });
  },
);

Deno.test(
  "Gemini gives each unavailable transition a new incident ID and reuses it for recovery",
  async () => {
    let currentTime = 0;
    let requestCount = 0;
    const incidents: Array<{ event: string; incidentId: unknown }> = [];
    const request = (() => {
      requestCount += 1;
      return Promise.resolve(
        requestCount % 2 === 1
          ? jsonResponse({}, 429)
          : emptyExtractionResponse(),
      );
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      log: (event, details) => {
        if (
          event === "ai_gemini_api_keys_unavailable" ||
          event === "ai_gemini_service_recovered"
        ) incidents.push({ event, incidentId: details.incidentId });
      },
      now: () => currentTime,
      state: createGeminiApiKeyStateStore(),
    });

    await rejectedProviderError(provider.extractPlaces("첫 outage"));
    currentTime = 60_000;
    await provider.extractPlaces("첫 recovery");
    await rejectedProviderError(provider.extractPlaces("두 번째 outage"));
    currentTime = 120_000;
    await provider.extractPlaces("두 번째 recovery");

    assertEquals(incidents, [{
      event: "ai_gemini_api_keys_unavailable",
      incidentId: 1,
    }, {
      event: "ai_gemini_service_recovered",
      incidentId: 1,
    }, {
      event: "ai_gemini_api_keys_unavailable",
      incidentId: 2,
    }, {
      event: "ai_gemini_service_recovered",
      incidentId: 2,
    }]);
  },
);

Deno.test("Gemini stops key fallback on the first non-429 response", async () => {
  const requestedKeys: Array<string | null> = [];
  const events: string[] = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-goog-api-key");
    requestedKeys.push(key);
    return Promise.resolve(jsonResponse({}, key === "primary" ? 429 : 503));
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback-one", "fallback-two"],
    extractionModel: "gemini-extract",
    judgmentModel: "gemini-judge",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    log: (event) => events.push(event),
    state: createGeminiApiKeyStateStore(),
  });

  const error = await rejectedProviderError(provider.extractPlaces("보연희"));

  assertEquals(requestedKeys, ["primary", "fallback-one"]);
  assertEquals({ kind: error.kind, status: error.status }, {
    kind: "UPSTREAM",
    status: 503,
  });
  assertEquals(events, ["ai_gemini_api_key_cooldown_started"]);
});

Deno.test("Gemini logs fallback credential auth failure without secrets", async () => {
  const requestedKeys: Array<string | null> = [];
  const events: Array<{ event: string; details: Record<string, unknown> }> = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-goog-api-key");
    requestedKeys.push(key);
    return Promise.resolve(
      jsonResponse({}, key === "primary-secret" ? 429 : 401),
    );
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary-secret",
    fallbackApiKeys: ["revoked-secret", "unused-secret"],
    extractionModel: "gemini-model",
    judgmentModel: "gemini-model",
    timeoutMs: 5_000,
  }, {
    fetch: request,
    log: (event, details) => events.push({ event, details }),
    state: createGeminiApiKeyStateStore(),
  });

  const error = await rejectedProviderError(
    provider.extractPlaces("prompt-secret"),
  );

  assertEquals(requestedKeys, ["primary-secret", "revoked-secret"]);
  assertEquals({ kind: error.kind, status: error.status }, {
    kind: "AUTH",
    status: 401,
  });
  const authEvent = events.find((entry) =>
    entry.event === "ai_gemini_api_key_auth_failed"
  );
  assertEquals(authEvent, {
    event: "ai_gemini_api_key_auth_failed",
    details: {
      operation: "PLACE_EXTRACTION",
      model: "gemini-model",
      credentialRole: "Fallback",
      credentialSlot: 2,
      status: 401,
      incidentId: 1,
    },
  });
  assert(
    !events.some((entry) =>
      entry.event === "ai_gemini_api_key_fallback_activated"
    ),
    "failed fallback must not be reported as activated",
  );
  const serialized = JSON.stringify(events);
  for (
    const secret of [
      "primary-secret",
      "revoked-secret",
      "unused-secret",
      "prompt-secret",
    ]
  ) {
    assert(!serialized.includes(secret), `${secret} must not be logged`);
  }
});

Deno.test(
  "Gemini dedupes active auth incidents and reopens one after contract-valid success",
  async () => {
    let requestCount = 0;
    const events: Array<{ event: string; details: Record<string, unknown> }> =
      [];
    const request = (() => {
      const call = requestCount++;
      if (call === 0) return Promise.resolve(jsonResponse({}, 401));
      if (call === 1) {
        return Promise.resolve(jsonResponse({
          candidates: [{
            content: {
              parts: [{ text: JSON.stringify({ places: "invalid" }) }],
            },
          }],
        }));
      }
      if (call === 2 || call === 4) {
        return Promise.resolve(jsonResponse({}, 403));
      }
      return Promise.resolve(emptyExtractionResponse());
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary-secret",
      extractionModel: "gemini-model",
      judgmentModel: "gemini-model",
      timeoutMs: 5_000,
    }, {
      fetch: request,
      log: (event, details) => events.push({ event, details }),
      state: createGeminiApiKeyStateStore(),
    });

    await rejectedProviderError(provider.extractPlaces("첫 인증 실패"));
    const invalid = await rejectedProviderError(
      provider.extractPlaces("계약 위반 200"),
    );
    assertEquals(invalid.kind, "INVALID_RESPONSE");
    await rejectedProviderError(provider.extractPlaces("동일 incident 403"));
    await provider.extractPlaces("계약 유효 성공");
    await rejectedProviderError(provider.extractPlaces("새 인증 실패"));

    assertEquals(events, [{
      event: "ai_gemini_api_key_auth_failed",
      details: {
        operation: "PLACE_EXTRACTION",
        model: "gemini-model",
        credentialRole: "Primary",
        credentialSlot: 1,
        status: 401,
        incidentId: 1,
      },
    }, {
      event: "ai_gemini_api_key_auth_failed",
      details: {
        operation: "PLACE_EXTRACTION",
        model: "gemini-model",
        credentialRole: "Primary",
        credentialSlot: 1,
        status: 403,
        incidentId: 2,
      },
    }]);
  },
);

Deno.test("Gemini does not rotate keys for non-429 HTTP errors", async () => {
  const cases = [[400, "BAD_REQUEST"], [401, "AUTH"], [403, "AUTH"], [
    500,
    "UPSTREAM",
  ]] as const;
  for (const [status, expectedKind] of cases) {
    let requestCount = 0;
    const request = (() => {
      requestCount += 1;
      return Promise.resolve(jsonResponse({}, status));
    }) as typeof fetch;
    const provider = createGeminiProvider({
      apiKey: "primary",
      fallbackApiKeys: ["fallback"],
      extractionModel: "gemini-extract",
      judgmentModel: "gemini-judge",
      timeoutMs: 5_000,
    }, { fetch: request, state: createGeminiApiKeyStateStore() });

    const error = await rejectedProviderError(provider.extractPlaces("보연희"));

    assertEquals({ status, requestCount, kind: error.kind }, {
      status,
      requestCount: 1,
      kind: expectedKind,
    });
  }
});

Deno.test("Gemini does not consume a non-429 error body", async () => {
  const request = (() =>
    Promise.resolve({
      ok: false,
      status: 503,
      headers: new Headers(),
      get body(): never {
        throw new Error("non-429 body must stay unread");
      },
    } as unknown as Response)) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-model",
    judgmentModel: "gemini-model",
    timeoutMs: 5_000,
  }, { fetch: request, state: createGeminiApiKeyStateStore() });

  const error = await rejectedProviderError(provider.extractPlaces("보연희"));

  assertEquals({ kind: error.kind, status: error.status }, {
    kind: "UPSTREAM",
    status: 503,
  });
});

Deno.test("Gemini does not rotate keys after a network failure", async () => {
  let requestCount = 0;
  const request = (() => {
    requestCount += 1;
    return Promise.reject(new TypeError("offline"));
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "primary",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-extract",
    judgmentModel: "gemini-judge",
    timeoutMs: 5_000,
  }, { fetch: request, state: createGeminiApiKeyStateStore() });

  const error = await rejectedProviderError(provider.extractPlaces("보연희"));

  assertEquals(error.kind, "NETWORK");
  assertEquals(requestCount, 1);
});

Deno.test("Gemini timeout covers a stalled successful response body", async () => {
  let requestCount = 0;
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    requestCount += 1;
    const response = {
      ok: true,
      status: 200,
      json: () =>
        new Promise<unknown>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        }),
    } as Response;
    return Promise.resolve(response);
  }) as typeof fetch;
  const provider = createGeminiProvider({
    apiKey: "key",
    fallbackApiKeys: ["fallback"],
    extractionModel: "gemini-extract",
    judgmentModel: "gemini-judge",
    timeoutMs: 5,
  }, { fetch: request, state: createGeminiApiKeyStateStore() });

  const error = await rejectedProviderError(provider.extractPlaces("보연희"));

  assertEquals(error.kind, "TIMEOUT");
  assertEquals(error.retryable, true);
  assertEquals(requestCount, 1);
});
