// Gemini 실패에 버티는 장치: 같은 키 재시도, 429 예비 키 전환, 캡션 OpenAI 폴백.
import { AiProviderError, AiProvidersExhaustedError } from "./ai/errors.ts";
import { createGeminiApiKeyStateStore } from "./ai/gemini_credentials.ts";
import type { SourcePlaceHint } from "./source_analysis.ts";
import { createSourceCaptionFallback } from "./source_fallback.ts";
import {
  createSourceGeminiClient,
  SOURCE_HINTS_SCHEMA,
  sourceCaptionInput,
} from "./source_gemini.ts";
import { createSourceOpenAiClient } from "./source_openai.ts";
import { SOURCE_CAPTION_INSTRUCTION } from "./source_prompts.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected a rejection");
}

function response(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const hint: SourcePlaceHint = {
  nameInCaption: "카페",
  nameSearchHint: null,
  accountHints: [],
  locationHints: [{ type: "REGION", value: "성수", basis: "CAPTION" }],
  categoryHint: "카페",
};
const config = {
  apiKey: "primary",
  model: "test-model",
  fallbackApiKeys: ["fallback"],
};

function captionResponse(): Response {
  return response({
    status: "completed",
    steps: [{
      type: "model_output",
      content: [{ type: "text", text: JSON.stringify({ places: [hint] }) }],
    }],
  });
}

function keyOf(init?: RequestInit): string {
  return new Headers(init?.headers).get("x-goog-api-key") ?? "";
}

const RPM_QUOTA_BODY = {
  error: {
    code: 429,
    details: [{
      "@type": "type.googleapis.com/google.rpc.QuotaFailure",
      violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }],
    }],
  },
};

Deno.test("캡션 분석은 503이면 같은 키로 1초, 3초 뒤 다시 보낸다", async () => {
  const delays: number[] = [];
  const keys: string[] = [];
  const events: string[] = [];
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    sleep: async (ms) => {
      delays.push(ms);
    },
    log: (event) => events.push(event),
    fetch: async (_url, init) => {
      keys.push(keyOf(init));
      return keys.length < 3 ? response({}, 503) : captionResponse();
    },
  });
  equal(await client.extractCaption("카페"), [hint]);
  equal(delays, [1_000, 3_000]);
  equal(keys, ["primary", "primary", "primary"]);
  equal(events, ["ai_provider_retry_scheduled", "ai_provider_retry_scheduled"]);
});

Deno.test("Retry-After가 오면 따르되 10초를 넘기지 않는다", async () => {
  const delays: number[] = [];
  let calls = 0;
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    sleep: async (ms) => {
      delays.push(ms);
    },
    fetch: async () =>
      ++calls === 1
        ? response({}, 503, { "Retry-After": "30" })
        : captionResponse(),
  });
  equal(await client.extractCaption("카페"), [hint]);
  equal(delays, [10_000]);
});

Deno.test("세 번 모두 503이면 키를 바꾸지 않고 UPSTREAM으로 실패한다", async () => {
  const keys: string[] = [];
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    sleep: async () => {},
    fetch: async (_url, init) => {
      keys.push(keyOf(init));
      return response({}, 503);
    },
  });
  const error = await rejection(client.extractCaption("카페"));
  equal(error instanceof AiProviderError && error.kind, "UPSTREAM");
  equal(keys, ["primary", "primary", "primary"]);
});

Deno.test("요청 오류(400)는 다시 보내지 않는다", async () => {
  let calls = 0;
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    sleep: async () => {
      throw new Error("sleep must not be called");
    },
    fetch: async () => {
      calls++;
      return response({}, 400);
    },
  });
  const error = await rejection(client.extractCaption("카페"));
  equal(error instanceof AiProviderError && error.kind, "BAD_REQUEST");
  equal(calls, 1);
});

Deno.test("남은 시간 안에 응답을 기다릴 수 없으면 다시 보내지 않는다", async () => {
  let clock = 0;
  let calls = 0;
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    now: () => clock,
    sleep: async () => {
      throw new Error("sleep must not be called");
    },
    fetch: async () => {
      calls++;
      clock += 70_000;
      return response({}, 503);
    },
  });
  const error = await rejection(client.extractCaption("카페"));
  equal(error instanceof AiProviderError && error.kind, "UPSTREAM");
  equal(calls, 1);
});

Deno.test("429면 예비 키로 넘기고 쿨다운과 예비 키 전환을 알린다", async () => {
  const keys: string[] = [];
  const events: { event: string; details: Record<string, unknown> }[] = [];
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    sleep: async () => {},
    log: (event, details) => events.push({ event, details }),
    fetch: async (_url, init) => {
      keys.push(keyOf(init));
      return keyOf(init) === "primary"
        ? response(RPM_QUOTA_BODY, 429)
        : captionResponse();
    },
  });
  equal(await client.extractCaption("카페"), [hint]);
  equal(keys, ["primary", "fallback"]);
  equal(events.map((item) => item.event), [
    "ai_gemini_api_key_cooldown_started",
    "ai_gemini_api_key_fallback_activated",
  ]);
  const activated = events[1].details;
  equal(
    [
      activated.operation,
      activated.fromCredentialSlot,
      activated.toCredentialSlot,
      activated.quotaKind,
    ],
    ["SOURCE_CAPTION_ANALYSIS", 1, 2, "RPM"],
  );
});

Deno.test("모든 키가 429면 키 소진을 알리고 RATE_LIMITED로 실패한다", async () => {
  const events: string[] = [];
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    sleep: async () => {},
    log: (event) => events.push(event),
    fetch: async () => response(RPM_QUOTA_BODY, 429),
  });
  const error = await rejection(client.extractCaption("카페"));
  equal(error instanceof AiProviderError && error.kind, "RATE_LIMITED");
  equal(events, [
    "ai_gemini_api_key_cooldown_started",
    "ai_gemini_api_key_cooldown_started",
    "ai_gemini_api_keys_unavailable",
  ]);
});

for (const failure of ["rate-limit", "overload"] as const) {
  Deno.test(`영상 분석 실패 대응: ${failure}`, async () => {
    const path = await Deno.makeTempFile({
      dir: "/tmp",
      prefix: "yeogidam-test-",
    });
    await Deno.writeFile(path, new Uint8Array([1, 2, 3]));
    const uploads: string[] = [];
    const deletions: string[][] = [];
    const delays: number[] = [];
    let analyses = 0;
    let removed = false;
    const client = createSourceGeminiClient(config, {
      state: createGeminiApiKeyStateStore(),
      download: async () => [{ path, size: 3, mimeType: "video/mp4" }],
      remove: async () => {
        await Deno.remove(path);
        removed = true;
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetch: async (url, init) => {
        const target = String(url);
        const key = keyOf(init);
        if (init?.method === "DELETE") {
          deletions.push([target.split("/").at(-1)!, key]);
          return new Response(null, { status: 204 });
        }
        if (target.endsWith("/upload/v1beta/files")) {
          uploads.push(key);
          return new Response(null, {
            headers: {
              "X-Goog-Upload-URL":
                "https://generativelanguage.googleapis.com/upload/session",
            },
          });
        }
        if (target.endsWith("/upload/session")) {
          await new Response(init?.body).arrayBuffer();
          const name = `files/${uploads.at(-1)}`;
          return response({
            file: { name, uri: `gs://${uploads.at(-1)}`, state: "ACTIVE" },
          });
        }
        if (target.endsWith(":generateContent")) {
          analyses++;
          const fails = failure === "rate-limit"
            ? key === "primary"
            : analyses === 1;
          if (fails) {
            return response({}, failure === "rate-limit" ? 429 : 503);
          }
          return response({
            candidates: [{
              finishReason: "STOP",
              content: {
                parts: [{ text: JSON.stringify({ places: [hint] }) }],
              },
            }],
          });
        }
        throw new Error(`Unexpected URL: ${target}`);
      },
    });
    try {
      equal(
        await client.extractMedia(
          "카페",
          "https://www.instagram.com/reel/ABC/",
        ),
        [hint],
      );
      if (failure === "rate-limit") {
        // 올린 파일은 키의 프로젝트에 묶이므로 새 키로 다시 올리고, 앞 키의 파일은 앞 키로 지운다.
        equal(uploads, ["primary", "fallback"]);
        equal(deletions, [["primary", "primary"], ["fallback", "fallback"]]);
        equal(delays, []);
      } else {
        // 과부하는 올린 파일을 그대로 두고 분석만 같은 키로 다시 보낸다.
        equal(uploads, ["primary"]);
        equal(analyses, 2);
        equal(delays, [1_000]);
        equal(deletions, [["primary", "primary"]]);
      }
      equal(removed, true);
    } finally {
      try {
        await Deno.remove(path);
      } catch { /* 정리됨 */ }
    }
  });
}

const geminiFailure = (kind: "UPSTREAM" | "AUTH") =>
  new AiProviderError("gemini", "SOURCE_CAPTION_ANALYSIS", kind, {
    model: "test-model",
    retryable: kind !== "AUTH",
  });

Deno.test("캡션 분석이 일시적 사유로 실패하면 OpenAI로 다시 묻는다", async () => {
  const events: { event: string; details: Record<string, unknown> }[] = [];
  const extract = createSourceCaptionFallback(
    {
      name: "gemini",
      extractCaption: () => Promise.reject(geminiFailure("UPSTREAM")),
    },
    { name: "openai", extractCaption: async () => [hint] },
    (event, details) => events.push({ event, details }),
  );
  equal(await extract("카페"), [hint]);
  equal(events, [
    {
      event: "ai_provider_fallback_started",
      details: {
        operation: "SOURCE_CAPTION_ANALYSIS",
        fromProvider: "gemini",
        toProvider: "openai",
        failureKind: "UPSTREAM",
      },
    },
    {
      event: "ai_provider_fallback_completed",
      details: {
        operation: "SOURCE_CAPTION_ANALYSIS",
        provider: "openai",
        resultCount: 1,
      },
    },
  ]);
});

Deno.test("인증 오류는 설정 문제라 OpenAI로 넘기지 않는다", async () => {
  let fallbackCalls = 0;
  const failure = geminiFailure("AUTH");
  const extract = createSourceCaptionFallback(
    { name: "gemini", extractCaption: () => Promise.reject(failure) },
    {
      name: "openai",
      extractCaption: async () => {
        fallbackCalls++;
        return [hint];
      },
    },
  );
  equal(await rejection(extract("카페")) === failure, true);
  equal(fallbackCalls, 0);
});

Deno.test("OpenAI까지 실패하면 두 시도를 모두 담아 실패한다", async () => {
  const primary = geminiFailure("UPSTREAM");
  const secondary = new AiProviderError(
    "openai",
    "SOURCE_CAPTION_ANALYSIS",
    "TIMEOUT",
    { model: "gpt", retryable: true },
  );
  const extract = createSourceCaptionFallback(
    { name: "gemini", extractCaption: () => Promise.reject(primary) },
    { name: "openai", extractCaption: () => Promise.reject(secondary) },
  );
  const error = await rejection(extract("카페"));
  equal(
    error instanceof AiProvidersExhaustedError &&
      error.attempts.map((attempt) => attempt.kind),
    ["UPSTREAM", "TIMEOUT"],
  );
});

Deno.test("폴백이 설정되지 않으면 Gemini 오류를 그대로 던진다", async () => {
  const failure = geminiFailure("UPSTREAM");
  const extract = createSourceCaptionFallback(
    { name: "gemini", extractCaption: () => Promise.reject(failure) },
    null,
  );
  equal(await rejection(extract("카페")) === failure, true);
});

Deno.test("OpenAI 캡션 분석은 Gemini와 같은 지시와 스키마로 Responses API를 부른다", async () => {
  const client = createSourceOpenAiClient(
    { apiKey: "openai-key", model: "gpt-test", timeoutMs: 1_000 },
    {
      fetch: async (url, init) => {
        equal(String(url), "https://api.openai.com/v1/responses");
        equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer openai-key",
        );
        equal(JSON.parse(String(init?.body)), {
          model: "gpt-test",
          instructions: SOURCE_CAPTION_INSTRUCTION,
          input: sourceCaptionInput("추천 @cafe"),
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: "source_place_hints",
              strict: true,
              schema: SOURCE_HINTS_SCHEMA,
            },
          },
        });
        return response({
          status: "completed",
          output_text: JSON.stringify({ places: [hint] }),
        });
      },
    },
  );
  equal(await client.extractCaption("추천 @cafe"), [hint]);
});

Deno.test("OpenAI가 스키마에 맞지 않게 답하면 INVALID_RESPONSE로 실패한다", async () => {
  const client = createSourceOpenAiClient(
    { apiKey: "openai-key", model: "gpt-test", timeoutMs: 1_000 },
    {
      fetch: async () =>
        response({ status: "completed", output_text: '{"places":[{}]}' }),
    },
  );
  const error = await rejection(client.extractCaption("카페"));
  equal(
    error instanceof AiProviderError && [error.provider, error.kind],
    ["openai", "INVALID_RESPONSE"],
  );
});
