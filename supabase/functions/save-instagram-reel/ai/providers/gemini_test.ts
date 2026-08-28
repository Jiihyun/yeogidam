import { AiProviderError } from "../errors.ts";
import { createGeminiProvider } from "./gemini.ts";
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
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
  }, { fetch: request });

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
  }, { fetch: request });

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
  }, { fetch: request });

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

Deno.test("Gemini timeout covers a stalled successful response body", async () => {
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
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
    extractionModel: "gemini-extract",
    judgmentModel: "gemini-judge",
    timeoutMs: 5,
  }, { fetch: request });

  const error = await rejectedProviderError(provider.extractPlaces("보연희"));

  assertEquals(error.kind, "TIMEOUT");
  assertEquals(error.retryable, true);
});
