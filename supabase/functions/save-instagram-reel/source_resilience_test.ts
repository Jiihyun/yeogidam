// Gemini 실패에 버티는 장치: 같은 키 재시도, 429 예비 키 전환, 과부하 전환과 알림.
import { AiProviderError } from "./ai/errors.ts";
import { createGeminiApiKeyStateStore } from "./ai/gemini_credentials.ts";
import {
  createInMemoryRuntimeAlertDedupe,
  createInMemoryRuntimeAlertTransitionQueue,
  sendGeminiRuntimeDiscordAlert,
} from "./ai/runtime_alerts.ts";
import type { SourcePlaceHint } from "./source_analysis.ts";
import { createSourceGeminiClient } from "./source_gemini.ts";

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
// 같은 key 재시도는 마지막 key에서만 하므로, 재시도 규칙은 key 하나로 검사한다.
const singleKey = { apiKey: "primary", model: "test-model" };

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

// 실제 Interactions API가 무료 등급 분당 한도에서 준 429 본문이다(2026-10-13 확인). details가 없다.
const INTERACTIONS_RPM_BODY = {
  error: {
    message:
      "Rate limit exceeded for model gemini-3.5-flash-lite (limit: 15 requests per minute on Free Tier). Please retry in 48s or upgrade your tier at https://ai.dev/rate-limit.",
    code: "too_many_requests",
  },
};

// 이벤트를 차례로 디스코드 알림에 넘겨, 실제로 보낸 알림 제목만 모은다.
async function postedTitles(
  events: { event: string; details: Record<string, unknown> }[],
): Promise<string[]> {
  const posted: string[] = [];
  const dedupe = createInMemoryRuntimeAlertDedupe();
  const transitionQueue = createInMemoryRuntimeAlertTransitionQueue();
  for (const { event, details } of events) {
    await sendGeminiRuntimeDiscordAlert(event, details, {
      webhookUrl: "https://discord.com/api/webhooks/test/token",
      dedupe,
      transitionQueue,
      fetch: async (_url, init) => {
        posted.push(JSON.parse(String(init?.body)).embeds[0].title);
        return new Response(null, { status: 204 });
      },
    });
  }
  return posted;
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

Deno.test("마지막 key는 503이면 같은 key로 1초, 3초 뒤 다시 보낸다", async () => {
  const delays: number[] = [];
  const keys: string[] = [];
  const events: string[] = [];
  const client = createSourceGeminiClient(singleKey, {
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
  const client = createSourceGeminiClient(singleKey, {
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

Deno.test("마지막 key가 세 번 모두 503이면 UPSTREAM으로 실패한다", async () => {
  const keys: string[] = [];
  const client = createSourceGeminiClient(singleKey, {
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
  const client = createSourceGeminiClient(singleKey, {
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

for (
  const failure of [
    "rate-limit",
    "overload-last-key",
    "overload-rotation",
  ] as const
) {
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
    const keyConfig = failure === "overload-last-key" ? singleKey : config;
    const client = createSourceGeminiClient(keyConfig, {
      state: createGeminiApiKeyStateStore(),
      // key마다 다시 올리는 Files API 경로를 검사하므로 인라인을 끈다.
      inlineMediaMaxBytes: 0,
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
            : failure === "overload-rotation"
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
      if (failure !== "overload-last-key") {
        // 429든 503이든 뒤에 key가 있으면 넘긴다. 올린 파일은 key의 프로젝트에 묶이므로 새 key로 다시 올리고, 앞 key의 파일은 앞 key로 지운다.
        equal(uploads, ["primary", "fallback"]);
        equal(deletions, [["primary", "primary"], ["fallback", "fallback"]]);
        equal(delays, []);
      } else {
        // 마지막 key의 과부하는 올린 파일을 그대로 두고 분석만 같은 key로 다시 보낸다.
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

Deno.test("뒤에 key가 있으면 503에서 재시도 없이 넘기고, 그 key는 60초 뒤에 다시 먼저 쓴다", async () => {
  let clock = 0;
  const keys: string[] = [];
  const events: { event: string; details: Record<string, unknown> }[] = [];
  let primaryHealthy = false;
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    now: () => clock,
    sleep: async () => {
      throw new Error("sleep must not be called");
    },
    log: (event, details) => events.push({ event, details }),
    fetch: async (_url, init) => {
      keys.push(keyOf(init));
      return keyOf(init) === "primary" && !primaryHealthy
        ? response({}, 503)
        : captionResponse();
    },
  });

  equal(await client.extractCaption("카페"), [hint]);
  equal(keys, ["primary", "fallback"]);
  const overloaded =
    events.find((item) => item.event === "ai_gemini_api_key_overloaded")!
      .details;
  equal(
    [
      overloaded.credentialSlot,
      overloaded.toCredentialSlot,
      overloaded.credentialCount,
      overloaded.status,
      overloaded.cooldownMs,
    ],
    [1, 2, 2, 503, 60_000],
  );

  // 60초 안에는 뒤 key로 바로 보낸다
  keys.length = 0;
  clock = 30_000;
  equal(await client.extractCaption("카페"), [hint]);
  equal(keys, ["fallback"]);

  // 60초가 지나면 앞 key를 다시 먼저 쓰고, 성공하면 해소를 남긴다
  keys.length = 0;
  clock = 61_000;
  primaryHealthy = true;
  equal(await client.extractCaption("카페"), [hint]);
  equal(keys, ["primary"]);
  equal(events.at(-1)?.event, "ai_gemini_api_key_overload_recovered");
});

Deno.test("넘겨받은 마지막 key에서만 같은 key로 재시도한다", async () => {
  const keys: string[] = [];
  const delays: number[] = [];
  let fallbackCalls = 0;
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    sleep: async (ms) => {
      delays.push(ms);
    },
    fetch: async (_url, init) => {
      keys.push(keyOf(init));
      if (keyOf(init) === "primary") return response({}, 503);
      return ++fallbackCalls < 3 ? response({}, 503) : captionResponse();
    },
  });
  equal(await client.extractCaption("카페"), [hint]);
  equal(keys, ["primary", "fallback", "fallback", "fallback"]);
  equal(delays, [1_000, 3_000]);
});

Deno.test("과부하가 이어져도 회복 전까지 같은 사건이라 디스코드에는 한 번만 알린다", async () => {
  let clock = 0;
  let primaryHealthy = false;
  const events: { event: string; details: Record<string, unknown> }[] = [];
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    now: () => clock,
    sleep: async () => {},
    log: (event, details) => events.push({ event, details }),
    fetch: async (_url, init) =>
      keyOf(init) === "primary" && !primaryHealthy
        ? response({}, 503)
        : captionResponse(),
  });
  await client.extractCaption("카페");
  clock = 61_000;
  await client.extractCaption("카페");
  clock = 122_000;
  primaryHealthy = true;
  await client.extractCaption("카페");

  const overloads = events.filter((item) =>
    item.event === "ai_gemini_api_key_overloaded"
  );
  equal(overloads.length, 2);
  equal(overloads[0].details.incidentId, overloads[1].details.incidentId);

  equal(await postedTitles(events), [
    "[WARN] Gemini Primary 과부하 → Fallback",
    "[RECOVERED] Gemini Primary 과부하 해소",
  ]);
});

Deno.test("앞 key가 429면 뒤 key로 넘기고 디스코드에 전환과 복귀를 한 번씩 알린다", async () => {
  let clock = 0;
  let primaryLimited = true;
  const keys: string[] = [];
  const events: { event: string; details: Record<string, unknown> }[] = [];
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    now: () => clock,
    sleep: async () => {},
    log: (event, details) => events.push({ event, details }),
    fetch: async (_url, init) => {
      keys.push(keyOf(init));
      return keyOf(init) === "primary" && primaryLimited
        ? response(RPM_QUOTA_BODY, 429)
        : captionResponse();
    },
  });
  await client.extractCaption("카페");
  await client.extractCaption("카페");
  clock = 61_000;
  primaryLimited = false;
  await client.extractCaption("카페");
  // 쿨다운 동안은 앞 key를 건너뛰고, 쿨다운이 끝나면 다시 앞 key를 먼저 쓴다.
  equal(keys, ["primary", "fallback", "fallback", "primary"]);

  equal(await postedTitles(events), [
    "[WARN] Gemini Primary → Fallback 전환",
    "[RECOVERED] Gemini Fallback → Primary 복귀",
  ]);
});

Deno.test("결제 key가 402면 10분 동안 건너뛰고 디스코드에 소진과 복구를 한 번씩 알린다", async () => {
  let clock = 0;
  let funded = false;
  const keys: string[] = [];
  const events: { event: string; details: Record<string, unknown> }[] = [];
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    now: () => clock,
    sleep: async () => {},
    log: (event, details) => events.push({ event, details }),
    fetch: async (_url, init) => {
      keys.push(keyOf(init));
      if (keyOf(init) === "primary") return response(RPM_QUOTA_BODY, 429);
      return funded ? captionResponse() : response({}, 402);
    },
  });
  const depleted = await rejection(client.extractCaption("카페"));
  equal(
    depleted instanceof AiProviderError && [depleted.kind, depleted.status],
    ["QUOTA_EXCEEDED", 402],
  );
  // 잔액이 떨어진 key는 10분 동안 부르지 않는다.
  clock = 5 * 60_000;
  await rejection(client.extractCaption("카페"));
  equal(keys, ["primary", "fallback", "primary"]);

  clock = 10 * 60_000 + 1;
  funded = true;
  equal(await client.extractCaption("카페"), [hint]);
  equal(keys, ["primary", "fallback", "primary", "primary", "fallback"]);
  equal(await postedTitles(events), [
    "[CRITICAL] Gemini Fallback 결제 잔액 소진",
    "[WARN] Gemini Primary → Fallback 전환",
    "[RECOVERED] Gemini Fallback 결제 잔액 복구",
  ]);
});

Deno.test("선불 잔액 소진 문구가 담긴 429도 결제 잔액 소진으로 본다", async () => {
  const events: { event: string; details: Record<string, unknown> }[] = [];
  const client = createSourceGeminiClient(singleKey, {
    state: createGeminiApiKeyStateStore(),
    sleep: async () => {},
    log: (event, details) => events.push({ event, details }),
    fetch: async () =>
      response({
        error: {
          code: 429,
          message: "Your prepayment credits are depleted.",
          status: "RESOURCE_EXHAUSTED",
        },
      }, 429),
  });
  const error = await rejection(client.extractCaption("카페"));
  equal(error instanceof AiProviderError && error.kind, "QUOTA_EXCEEDED");
  equal(events.map((item) => item.event), [
    "ai_gemini_api_key_billing_depleted",
  ]);
  equal(
    [events[0].details.credentialRole, events[0].details.status],
    ["Primary", 429],
  );
  equal(await postedTitles(events), [
    "[CRITICAL] Gemini Primary 결제 잔액 소진",
  ]);
});

Deno.test("Interactions API의 분당 한도 429는 문장으로 RPM을 가리고 전환을 알린다", async () => {
  const events: { event: string; details: Record<string, unknown> }[] = [];
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    now: () => 0,
    sleep: async () => {},
    log: (event, details) => events.push({ event, details }),
    fetch: async (_url, init) =>
      keyOf(init) === "primary"
        ? response(INTERACTIONS_RPM_BODY, 429, { "Retry-After": "48" })
        : captionResponse(),
  });
  equal(await client.extractCaption("카페"), [hint]);
  const cooldown =
    events.find((item) => item.event === "ai_gemini_api_key_cooldown_started")!
      .details;
  equal(
    [cooldown.quotaKind, cooldown.quotaScope, cooldown.cooldownMs],
    ["RPM", "MINUTE", 48_000],
  );
  equal(await postedTitles(events), ["[WARN] Gemini Primary → Fallback 전환"]);
});

Deno.test("같은 순간에 몰린 429는 한 사건으로 보고 쿨다운을 늘리지 않는다", async () => {
  const events: { event: string; details: Record<string, unknown> }[] = [];
  let waiting = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const client = createSourceGeminiClient(config, {
    state: createGeminiApiKeyStateStore(),
    now: () => 0,
    sleep: async () => {},
    log: (event, details) => events.push({ event, details }),
    fetch: async (_url, init) => {
      if (keyOf(init) !== "primary") return captionResponse();
      // 네 요청이 모두 앞 key를 고른 뒤에 한꺼번에 429를 받게 한다.
      waiting += 1;
      if (waiting === 4) release();
      await gate;
      return response({}, 429);
    },
  });
  const results = await Promise.all(
    Array.from({ length: 4 }, () => client.extractCaption("카페")),
  );
  equal(results, [[hint], [hint], [hint], [hint]]);
  // 네 요청 모두 쿨다운 이벤트를 남기지만 단계는 1분에 머물고, 같은 쿨다운을 가리킨다.
  const cooldowns = events.filter((item) =>
    item.event === "ai_gemini_api_key_cooldown_started"
  );
  equal(
    cooldowns.map((item) => [item.details.cooldownMs, item.details.retryAt]),
    Array(4).fill([60_000, new Date(60_000).toISOString()]),
  );
  equal(await postedTitles(events), ["[WARN] Gemini Primary UNKNOWN 429"]);
});
