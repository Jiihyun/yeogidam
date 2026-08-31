import { AiConfigError } from "./errors.ts";
import {
  createPlaceAiClient,
  type EnvReader,
  loadPlaceAiConfig,
} from "./factory.ts";

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

function assertConfigError(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch (error) {
    assert(error instanceof AiConfigError);
    assertEquals(error.message, message);
    return;
  }
  throw new Error("Expected AiConfigError");
}

function env(values: Record<string, string>): EnvReader {
  return { get: (name) => values[name] };
}

Deno.test("loads backward-compatible Gemini defaults", () => {
  assertEquals(loadPlaceAiConfig(env({ GEMINI_API_KEY: " gemini-key " })), {
    primary: {
      name: "gemini",
      apiKey: "gemini-key",
      extractionModel: "gemini-3.5-flash-lite",
      judgmentModel: "gemini-3.5-flash-lite",
      timeoutMs: 10_000,
    },
  });
});

Deno.test("loads ordered Gemini fallback API keys", () => {
  assertEquals(
    loadPlaceAiConfig(env({
      GEMINI_API_KEY: " primary-key ",
      GEMINI_API_KEY_FALLBACKS: " fallback-one, , fallback-two ",
    })),
    {
      primary: {
        name: "gemini",
        apiKey: "primary-key",
        fallbackApiKeys: ["fallback-one", "fallback-two"],
        extractionModel: "gemini-3.5-flash-lite",
        judgmentModel: "gemini-3.5-flash-lite",
        timeoutMs: 10_000,
      },
    },
  );
});

Deno.test("loads distinct primary and fallback provider models", () => {
  assertEquals(
    loadPlaceAiConfig(env({
      PLACE_AI_PRIMARY_PROVIDER: "OPENAI",
      PLACE_AI_FALLBACK_PROVIDER: "gemini",
      PLACE_AI_TIMEOUT_MS: "12000",
      OPENAI_API_KEY: "openai-key",
      OPENAI_MODEL: "openai-extract",
      OPENAI_MATCH_MODEL: "openai-judge",
      GEMINI_API_KEY: "gemini-key",
      GEMINI_MODEL: "gemini-extract",
      GEMINI_MATCH_MODEL: "gemini-judge",
    })),
    {
      primary: {
        name: "openai",
        apiKey: "openai-key",
        extractionModel: "openai-extract",
        judgmentModel: "openai-judge",
        timeoutMs: 12_000,
      },
      fallback: {
        name: "gemini",
        apiKey: "gemini-key",
        extractionModel: "gemini-extract",
        judgmentModel: "gemini-judge",
        timeoutMs: 12_000,
      },
    },
  );
});

Deno.test("rejects invalid provider configuration", () => {
  assertConfigError(
    () =>
      loadPlaceAiConfig(env({
        PLACE_AI_PRIMARY_PROVIDER: "gemini",
        PLACE_AI_FALLBACK_PROVIDER: "gemini",
        GEMINI_API_KEY: "key",
      })),
    "Primary and fallback AI providers must differ",
  );
  assertConfigError(
    () => loadPlaceAiConfig(env({ PLACE_AI_PRIMARY_PROVIDER: "openai" })),
    "OPENAI_API_KEY is required",
  );
  assertConfigError(
    () =>
      loadPlaceAiConfig(env({
        GEMINI_API_KEY: "key",
        PLACE_AI_TIMEOUT_MS: "999",
      })),
    "PLACE_AI_TIMEOUT_MS must be 1000-120000",
  );
  assertConfigError(
    () =>
      loadPlaceAiConfig(env({
        GEMINI_API_KEY: "same-key",
        GEMINI_API_KEY_FALLBACKS: "fallback-key, same-key, fallback-key",
      })),
    "GEMINI_API_KEY_FALLBACKS must contain unique keys",
  );
});

Deno.test("factory wires the configured primary through injected fetch", async () => {
  const urls: string[] = [];
  const request = ((input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve(Response.json({
      output_text: JSON.stringify({ places: [] }),
    }));
  }) as typeof fetch;
  const client = createPlaceAiClient(
    env({
      PLACE_AI_PRIMARY_PROVIDER: "openai",
      OPENAI_API_KEY: "openai-key",
      OPENAI_MODEL: "gpt-test",
    }),
    { fetch: request },
  );

  const result = await client.extractPlaces("장소가 없는 캡션");

  assertEquals(urls, ["https://api.openai.com/v1/responses"]);
  assertEquals(result, {
    data: [],
    model: "gpt-test",
    usage: undefined,
    provider: "openai",
    fallbackUsed: false,
  });
});

Deno.test(
  "factory exhausts Gemini API keys before using provider fallback",
  async () => {
    const geminiKeys: Array<string | null> = [];
    const request = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com")) {
        geminiKeys.push(new Headers(init?.headers).get("x-goog-api-key"));
        return Promise.resolve(
          new Response("sensitive upstream body", { status: 429 }),
        );
      }
      return Promise.resolve(Response.json({
        output_text: JSON.stringify({ places: [] }),
      }));
    }) as typeof fetch;
    const client = createPlaceAiClient(
      env({
        PLACE_AI_PRIMARY_PROVIDER: "gemini",
        PLACE_AI_FALLBACK_PROVIDER: "openai",
        GEMINI_API_KEY: "gemini-primary",
        GEMINI_API_KEY_FALLBACKS: "gemini-secondary",
        OPENAI_API_KEY: "openai-key",
        OPENAI_MODEL: "gpt-test",
      }),
      { fetch: request },
    );

    const result = await client.extractPlaces("장소가 없는 캡션");

    assertEquals(geminiKeys, ["gemini-primary", "gemini-secondary"]);
    assertEquals(result.provider, "openai");
    assertEquals(result.fallbackUsed, true);
  },
);
