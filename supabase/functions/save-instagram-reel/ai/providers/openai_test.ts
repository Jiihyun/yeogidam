import { AiProviderError } from "../errors.ts";
import { createOpenAiProvider } from "./openai.ts";
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
    guessIndex: 4,
    guess: {
      placeName: "우직",
      address: null,
      addressType: "NONE",
      region: "부산",
    },
    captionContexts: ["우직 @woozik.busan"],
    candidates: [],
  };
}

Deno.test("OpenAI extraction sends Responses JSON schema and parses output_text", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const request = ((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Promise.resolve(jsonResponse({
      output_text: JSON.stringify({
        places: [{
          placeName: "키리",
          address: "광주 동구 동명동 200-188",
          addressType: "JIBUN",
          region: "동명동",
        }],
      }),
      usage: { input_tokens: 21, output_tokens: 9 },
    }));
  }) as typeof fetch;
  const provider = createOpenAiProvider({
    apiKey: "openai-secret",
    extractionModel: "gpt-extract",
    judgmentModel: "gpt-judge",
    timeoutMs: 5_000,
  }, { fetch: request });

  const result = await provider.extractPlaces("키리 광주 동구 동명동 200-188");

  assertEquals(capturedUrl, "https://api.openai.com/v1/responses");
  assertEquals(capturedInit?.method, "POST");
  const headers = new Headers(capturedInit?.headers);
  assertEquals(headers.get("Authorization"), "Bearer openai-secret");
  assertEquals(headers.get("Content-Type"), "application/json");
  const body = requestBody(capturedInit);
  assertEquals(body.model, "gpt-extract");
  assertEquals(body.store, false);
  assert(typeof body.input === "string" && body.input.includes("키리"));
  const text = body.text as {
    format: {
      type: string;
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
  };
  assertEquals({
    type: text.format.type,
    name: text.format.name,
    strict: text.format.strict,
    schemaType: text.format.schema.type,
  }, {
    type: "json_schema",
    name: "place_extraction",
    strict: true,
    schemaType: "object",
  });
  assertEquals(result, {
    data: [{
      placeName: "키리",
      address: "광주 동구 동명동 200-188",
      addressType: "JIBUN",
      region: "동명동",
    }],
    model: "gpt-extract",
    usage: { inputTokens: 21, outputTokens: 9 },
  });
});

Deno.test("OpenAI judgment parses nested Responses output content", async () => {
  const capture: { body?: Record<string, unknown> } = {};
  const request = ((
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    capture.body = requestBody(init);
    return Promise.resolve(jsonResponse({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            decisions: [{
              guessIndex: 4,
              decision: "RETRY",
              candidateId: null,
              retryQueries: ["우직 부산"],
              reason: "CANDIDATE_MISSING",
            }],
          }),
        }],
      }],
    }));
  }) as typeof fetch;
  const provider = createOpenAiProvider({
    apiKey: "openai-secret",
    extractionModel: "gpt-extract",
    judgmentModel: "gpt-judge",
    timeoutMs: 5_000,
  }, { fetch: request });

  const result = await provider.judgeKakaoCandidates("우직 부산", [
    reviewItem(),
  ]);

  assertEquals(result.data, [{
    guessIndex: 4,
    decision: "RETRY",
    candidateId: null,
    retryQueries: ["우직 부산"],
    reason: "CANDIDATE_MISSING",
  }]);
  assertEquals(result.model, "gpt-judge");
  const capturedBody = capture.body;
  assert(capturedBody !== undefined);
  assertEquals(capturedBody.model, "gpt-judge");
  const text = capturedBody.text as { format: { name: string } };
  assertEquals(text.format.name, "kakao_candidate_judgment");
  assert(
    typeof capturedBody.input === "string" &&
      capturedBody.input.includes("우직 부산"),
  );
});

Deno.test("OpenAI turns malformed structured output into provider error", async () => {
  const request = (() =>
    Promise.resolve(
      jsonResponse({ output_text: "not-json" }),
    )) as typeof fetch;
  const provider = createOpenAiProvider({
    apiKey: "openai-secret",
    extractionModel: "gpt-extract",
    judgmentModel: "gpt-judge",
    timeoutMs: 5_000,
  }, { fetch: request });

  const error = await rejectedProviderError(provider.extractPlaces("키리"));

  assertEquals({
    provider: error.provider,
    operation: error.operation,
    kind: error.kind,
    model: error.model,
  }, {
    provider: "openai",
    operation: "PLACE_EXTRACTION",
    kind: "INVALID_RESPONSE",
    model: "gpt-extract",
  });
});

Deno.test("OpenAI cancelled responses do not become fallback-eligible", async () => {
  const request = (() =>
    Promise.resolve(
      jsonResponse({ status: "cancelled" }),
    )) as typeof fetch;
  const provider = createOpenAiProvider({
    apiKey: "openai-secret",
    extractionModel: "gpt-extract",
    judgmentModel: "gpt-judge",
    timeoutMs: 5_000,
  }, { fetch: request });

  const error = await rejectedProviderError(provider.extractPlaces("키리"));

  assertEquals(error.kind, "CANCELLED");
  assertEquals(error.retryable, false);
});
