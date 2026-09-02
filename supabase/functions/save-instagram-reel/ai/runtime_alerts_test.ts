import {
  createInMemoryRuntimeAlertDedupe,
  createInMemoryRuntimeAlertTransitionQueue,
  type GeminiRuntimeAlertOutcome,
  sendGeminiRuntimeDiscordAlert,
} from "./runtime_alerts.ts";

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

function requestPayload(init?: RequestInit): Record<string, unknown> {
  assert(typeof init?.body === "string", "Expected a Discord JSON body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function payloadText(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function embedTitle(payload: Record<string, unknown>): string | null {
  const embeds = payload.embeds;
  if (!Array.isArray(embeds) || embeds.length === 0) return null;
  const embed = embeds[0];
  return typeof embed === "object" && embed !== null &&
      typeof (embed as Record<string, unknown>).title === "string"
    ? (embed as Record<string, string>).title
    : null;
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function embedFields(
  payload: Record<string, unknown>,
): Record<string, unknown>[] {
  const embeds = payload.embeds;
  if (!Array.isArray(embeds) || embeds.length === 0) return [];
  const embed = embeds[0];
  if (typeof embed !== "object" || embed === null) return [];
  const fields = (embed as Record<string, unknown>).fields;
  return Array.isArray(fields)
    ? fields.filter((field): field is Record<string, unknown> =>
      typeof field === "object" && field !== null && !Array.isArray(field)
    )
    : [];
}

const NOW = new Date("2026-08-31T12:34:56.000Z");

Deno.test("known Gemini quota transition warns once after Primary to Fallback", async () => {
  const payloads: Record<string, unknown>[] = [];
  const apiKey = ["AIza", "ThisMustNeverAppearInDiscord123456789"].join("");
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    payloads.push(requestPayload(init));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  const dedupe = createInMemoryRuntimeAlertDedupe();
  const dependencies = {
    webhookUrl: "https://discord.example/runtime",
    fetch: request,
    dedupe,
    now: () => NOW,
  };
  const details = {
    transitionId: "rpm-transition-1",
    operation: "PLACE_EXTRACTION",
    model: "gemini-test",
    fromCredentialRole: "Primary",
    fromCredentialSlot: 1,
    toCredentialRole: "Fallback",
    toCredentialSlot: 2,
    quotaKind: "RPM",
    retryAt: "2026-08-31T12:35:56.000Z",
    apiKey,
    prompt: "private caption",
    errorBody: "sensitive upstream response",
  };

  const first = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_fallback_activated",
    details,
    dependencies,
  );
  const duplicate = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_fallback_activated",
    details,
    dependencies,
  );

  assertEquals(first, {
    status: "sent",
    severity: "WARNING",
    kind: "PRIMARY_FALLBACK_ACTIVATED",
  });
  assertEquals(duplicate, {
    status: "deduplicated",
    severity: "WARNING",
    kind: "PRIMARY_FALLBACK_ACTIVATED",
  });
  assertEquals(payloads.length, 1);
  assertEquals(
    embedTitle(payloads[0]),
    "[WARN] Gemini Primary → Fallback 전환",
  );
  const text = payloadText(payloads[0]);
  assert(text.includes("WARNING"));
  assert(text.includes("Primary"));
  assert(text.includes("Fallback"));
  assert(text.includes("RPM"));
  assert(!text.includes(apiKey));
  assert(!text.includes("private caption"));
  assert(!text.includes("sensitive upstream response"));
});

Deno.test("TPM and RPD transitions retain their distinct quota labels", async () => {
  const payloads: Record<string, unknown>[] = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    payloads.push(requestPayload(init));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  const dependencies = {
    webhookUrl: "https://discord.example/runtime",
    fetch: request,
    dedupe: createInMemoryRuntimeAlertDedupe(),
  };

  for (const quotaKind of ["TPM", "RPD"] as const) {
    await sendGeminiRuntimeDiscordAlert(
      "ai_gemini_api_key_fallback_activated",
      {
        transitionId: `${quotaKind}-transition`,
        fromCredentialSlot: 1,
        toCredentialSlot: 2,
        quotaKind,
      },
      dependencies,
    );
  }

  assertEquals(payloads.length, 2);
  assert(payloadText(payloads[0]).includes("TPM"));
  assert(payloadText(payloads[1]).includes("RPD"));
});

Deno.test("unknown Gemini 429 reports only safe classification diagnostics", async () => {
  let payload: Record<string, unknown> | null = null;
  const apiKey = ["AIza", "SecretKeyMaterial1234567890"].join("");
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    payload = requestPayload(init);
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  const outcome = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_cooldown_started",
    {
      transitionId: "unknown-transition",
      model: "gemini-test",
      credentialRole: "Primary",
      credentialSlot: 1,
      quotaKind: "UNKNOWN",
      classificationReason: "quota_failure_shape_not_recognized",
      quotaIds: [
        "GenerateContentMysteryLimit",
        "AnotherQuota",
        ...Array.from(
          { length: 6 },
          (_, index) => `LongQuota${index}-${"x".repeat(300)}`,
        ),
      ],
      retryHintSource: "ADAPTIVE_BACKOFF",
      rawErrorBody: "provider body must stay private",
      apiKey,
    },
    {
      webhookUrl: "https://discord.example/runtime",
      fetch: request,
      dedupe: createInMemoryRuntimeAlertDedupe(),
      now: () => NOW,
    },
  );

  assertEquals(outcome, {
    status: "sent",
    severity: "WARNING",
    kind: "UNKNOWN_RATE_LIMIT",
  });
  assert(payload !== null);
  assertEquals(embedTitle(payload), "[WARN] Gemini Primary UNKNOWN 429");
  const text = payloadText(payload);
  assert(text.includes("UNKNOWN 429"));
  assert(text.includes("UNSAFE_CLASSIFICATION_REASON"));
  assert(!text.includes("quota_failure_shape_not_recognized"));
  assert(text.includes("GenerateContentMysteryLimit"));
  assert(text.includes("AnotherQuota"));
  assert(text.includes("Credential slot"));
  assert(text.includes("ADAPTIVE_BACKOFF"));
  for (const field of embedFields(payload)) {
    assert(
      typeof field.value !== "string" || field.value.length <= 1_024,
      "Discord field values must stay within 1024 characters",
    );
  }
  assert(!text.includes("provider body must stay private"));
  assert(!text.includes(apiKey));
});

Deno.test("unknown Gemini diagnostics replace untrusted reason and retry text", async () => {
  let payload: Record<string, unknown> | null = null;
  const secretApiKey = ["AIza", "UntrustedDiagnosticSecret123456789"].join("");
  const privatePrompt = "private reel caption that must not reach Discord";
  const privateBody = "private upstream response body";
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    payload = requestPayload(init);
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_cooldown_started",
    {
      transitionId: "untrusted-diagnostics",
      quotaKind: "UNKNOWN",
      classificationReason: `${privatePrompt} ${secretApiKey} ${privateBody}`,
      retryHintSource: `${privateBody} ${secretApiKey}`,
    },
    {
      webhookUrl: "https://discord.example/runtime",
      fetch: request,
      dedupe: createInMemoryRuntimeAlertDedupe(),
    },
  );

  assert(payload !== null);
  const text = payloadText(payload);
  assert(text.includes("UNSAFE_CLASSIFICATION_REASON"));
  assert(text.includes("UNSAFE_RETRY_HINT_SOURCE"));
  assert(!text.includes(privatePrompt));
  assert(!text.includes(secretApiKey));
  assert(!text.includes(privateBody));
});

Deno.test("Primary and service recoveries produce RECOVERED alerts", async () => {
  const payloads: Record<string, unknown>[] = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    payloads.push(requestPayload(init));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  const dependencies = {
    webhookUrl: "https://discord.example/runtime",
    fetch: request,
    dedupe: createInMemoryRuntimeAlertDedupe(),
  };

  const primary = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_primary_recovered",
    {
      transitionId: "primary-recovery",
      credentialRole: "Primary",
      credentialSlot: 1,
      model: "gemini-extract",
    },
    dependencies,
  );
  const service = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_service_recovered",
    {
      transitionId: "service-recovery",
      credentialRole: "Fallback",
      credentialSlot: 2,
      model: "gemini-judge",
    },
    dependencies,
  );

  assertEquals(primary?.severity, "RECOVERED");
  assertEquals(primary?.kind, "PRIMARY_RECOVERED");
  assertEquals(service?.severity, "RECOVERED");
  assertEquals(service?.kind, "SERVICE_RECOVERED");
  assertEquals(payloads.length, 2);
  assertEquals(
    embedTitle(payloads[0]),
    "[RECOVERED] Gemini Fallback → Primary 복귀",
  );
  assertEquals(
    embedTitle(payloads[1]),
    "[RECOVERED] Gemini 서비스 복구",
  );
});

Deno.test("all-key and auth critical alerts dedupe only the same incident", async () => {
  const payloads: Record<string, unknown>[] = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    payloads.push(requestPayload(init));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  const dependencies = {
    webhookUrl: "https://discord.example/runtime",
    fetch: request,
    dedupe: createInMemoryRuntimeAlertDedupe(),
  };

  const unavailable = {
    model: "gemini-test",
    quotaKind: "RPD",
    credentialCount: 3,
  };
  await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_keys_unavailable",
    { ...unavailable, incidentId: "outage-1" },
    dependencies,
  );
  await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_keys_unavailable",
    { ...unavailable, incidentId: "outage-1" },
    dependencies,
  );
  await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_keys_unavailable",
    { ...unavailable, incidentId: "outage-2" },
    dependencies,
  );
  await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_auth_failed",
    {
      incidentId: "auth-primary",
      model: "gemini-test",
      credentialRole: "Primary",
      credentialSlot: 1,
      status: 401,
    },
    dependencies,
  );
  await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_auth_failed",
    {
      incidentId: "auth-fallback",
      model: "gemini-test",
      credentialRole: "Fallback",
      credentialSlot: 2,
      status: 403,
    },
    dependencies,
  );
  const ignoredStatus = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_auth_failed",
    { status: 429 },
    dependencies,
  );

  assertEquals(payloads.length, 4);
  for (const payload of payloads) {
    assert(payloadText(payload).includes("CRITICAL"));
  }
  assert(payloadText(payloads[0]).includes("Primary"));
  assert(payloadText(payloads[0]).includes("Fallback"));
  assert(payloadText(payloads[2]).includes("401"));
  assert(payloadText(payloads[3]).includes("403"));
  assertEquals(
    embedTitle(payloads[0]),
    "[CRITICAL] Gemini 전체 API 키 사용 불가",
  );
  assertEquals(
    embedTitle(payloads[2]),
    "[CRITICAL] Gemini API 키 인증 오류",
  );
  assertEquals(ignoredStatus, null);
});

Deno.test("per-request completion and unrelated events are ignored", async () => {
  let requestCount = 0;
  const dependencies = {
    webhookUrl: "https://discord.example/runtime",
    fetch: (() => {
      requestCount += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch,
    dedupe: createInMemoryRuntimeAlertDedupe(),
  };

  const completed = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_fallback_completed",
    { credentialSlot: 2 },
    dependencies,
  );
  const unrelated = await sendGeminiRuntimeDiscordAlert(
    "ai_provider_call_completed",
    { provider: "gemini" },
    dependencies,
  );
  const preAttempt = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_fallback_started",
    {
      fromCredentialRole: "Primary",
      toCredentialRole: "Fallback",
      quotaKind: "RPM",
    },
    dependencies,
  );

  assertEquals(completed, null);
  assertEquals(unrelated, null);
  assertEquals(preAttempt, null);
  assertEquals(requestCount, 0);
});

Deno.test("a transient network failure retries inside the transition task", async () => {
  let requestCount = 0;
  const sleepDelays: number[] = [];
  const localLogs: Array<[string, Record<string, unknown>]> = [];
  const request = (() => {
    requestCount += 1;
    if (requestCount === 1) throw new TypeError("network detail is private");
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  const dependencies = {
    webhookUrl: "https://discord.example/runtime",
    fetch: request,
    dedupe: createInMemoryRuntimeAlertDedupe(),
    sleep: (delayMs: number) => {
      sleepDelays.push(delayMs);
      return Promise.resolve();
    },
    log: (event: string, details: Record<string, unknown>) => {
      localLogs.push([event, details]);
    },
  };
  const details = {
    incidentId: "retryable-auth-alert",
    model: "gemini-test",
    credentialRole: "Primary",
    status: 401,
  };

  let first: GeminiRuntimeAlertOutcome | null = null;
  try {
    first = await sendGeminiRuntimeDiscordAlert(
      "ai_gemini_api_key_auth_failed",
      details,
      dependencies,
    );
  } catch {
    throw new Error("Delivery failures must not reject");
  }
  const duplicate = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_auth_failed",
    details,
    dependencies,
  );

  assertEquals(first?.status, "sent");
  assertEquals(duplicate?.status, "deduplicated");
  assertEquals(requestCount, 2);
  assertEquals(sleepDelays, [250]);
  assertEquals(
    localLogs[0][0],
    "ai_runtime_discord_alert_delivery_retry_scheduled",
  );
  assertEquals(localLogs[0][1].errorName, "TypeError");
  assertEquals(localLogs[0][1].nextAttempt, 2);
  assertEquals(
    localLogs.at(-1)?.[0],
    "ai_runtime_discord_alert_delivered",
  );
  assertEquals(localLogs.at(-1)?.[1].attemptCount, 2);
  assert(!JSON.stringify(localLogs).includes("network detail is private"));
});

Deno.test("a never-settling Discord fetch is aborted and bounded per attempt", async () => {
  let requestCount = 0;
  let abortedRequestCount = 0;
  let nextTimerId = 0;
  const activeTimers = new Map<number, () => void>();
  const clearedTimers: number[] = [];
  const sleepDelays: number[] = [];
  const request = ((_input: string | URL | Request, init?: RequestInit) => {
    requestCount += 1;
    const signal = init?.signal;
    assert(signal, "Expected delivery timeout signal");
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          abortedRequestCount += 1;
          reject(new DOMException("request aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }) as typeof fetch;

  const outcome = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_auth_failed",
    {
      incidentId: "never-settling-discord-request",
      model: "gemini-test",
      credentialRole: "Primary",
      status: 401,
    },
    {
      webhookUrl: "https://discord.example/runtime",
      fetch: request,
      dedupe: createInMemoryRuntimeAlertDedupe(),
      sleep: (delayMs: number) => {
        sleepDelays.push(delayMs);
        return Promise.resolve();
      },
      scheduleTimeout: (callback) => {
        const timerId = ++nextTimerId;
        activeTimers.set(timerId, callback);
        queueMicrotask(() => activeTimers.get(timerId)?.());
        return timerId;
      },
      clearScheduledTimeout: (timerId) => {
        if (typeof timerId !== "number") {
          throw new Error("Expected numeric fake timer ID");
        }
        clearedTimers.push(timerId);
        activeTimers.delete(timerId);
      },
    },
  );

  assertEquals(outcome?.status, "delivery_failed");
  assertEquals(requestCount, 3);
  assertEquals(abortedRequestCount, 3);
  assertEquals(sleepDelays, [250, 1_000]);
  assertEquals(clearedTimers, [1, 2, 3]);
  assertEquals(activeTimers.size, 0);
});

Deno.test("Discord 429 and 5xx honor capped Retry-After then short backoff", async () => {
  let requestCount = 0;
  const sleepDelays: number[] = [];
  const localLogs: Array<[string, Record<string, unknown>]> = [];
  const request = (() => {
    requestCount += 1;
    if (requestCount === 1) {
      return Promise.resolve(
        new Response("private 429 body", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
      );
    }
    if (requestCount === 2) {
      return Promise.resolve(
        new Response("private 503 body", {
          status: 503,
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  const outcome = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_keys_unavailable",
    {
      incidentId: "discord-rate-limit",
      quotaKind: "RPD",
      model: "gemini-test",
    },
    {
      webhookUrl: "https://discord.example/runtime",
      fetch: request,
      dedupe: createInMemoryRuntimeAlertDedupe(),
      sleep: (delayMs: number) => {
        sleepDelays.push(delayMs);
        return Promise.resolve();
      },
      log: (event: string, details: Record<string, unknown>) => {
        localLogs.push([event, details]);
      },
    },
  );

  assertEquals(outcome?.status, "sent");
  assertEquals(requestCount, 3);
  assertEquals(sleepDelays, [15_000, 1_000]);
  assertEquals(localLogs[0][1].upstreamStatus, 429);
  assertEquals(localLogs[1][1].upstreamStatus, 503);
  assert(!JSON.stringify(localLogs).includes("private 429 body"));
  assert(!JSON.stringify(localLogs).includes("private 503 body"));
});

Deno.test("exhausted retries release dedupe while non-retryable 4xx fails once", async () => {
  let networkRequestCount = 0;
  let networkRecovered = false;
  const sleepDelays: number[] = [];
  const dedupe = createInMemoryRuntimeAlertDedupe();
  const details = {
    incidentId: "retry-exhausted",
    model: "gemini-test",
    credentialRole: "Primary",
    status: 401,
  };
  const networkDependencies = {
    webhookUrl: "https://discord.example/runtime",
    fetch: (() => {
      networkRequestCount += 1;
      if (!networkRecovered) throw new TypeError("private network message");
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch,
    dedupe,
    sleep: (delayMs: number) => {
      sleepDelays.push(delayMs);
      return Promise.resolve();
    },
  };

  const exhausted = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_auth_failed",
    details,
    networkDependencies,
  );
  networkRecovered = true;
  const afterRelease = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_key_auth_failed",
    details,
    networkDependencies,
  );

  assertEquals(exhausted?.status, "delivery_failed");
  assertEquals(afterRelease?.status, "sent");
  assertEquals(networkRequestCount, 4);
  assertEquals(sleepDelays, [250, 1_000]);

  let badRequestCount = 0;
  const badRequestSleeps: number[] = [];
  const badRequest = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_keys_unavailable",
    { incidentId: "discord-bad-request", quotaKind: "RPD" },
    {
      webhookUrl: "https://discord.example/runtime",
      fetch: (() => {
        badRequestCount += 1;
        return Promise.resolve(
          new Response("private 400 body", {
            status: 400,
          }),
        );
      }) as typeof fetch,
      dedupe: createInMemoryRuntimeAlertDedupe(),
      sleep: (delayMs: number) => {
        badRequestSleeps.push(delayMs);
        return Promise.resolve();
      },
    },
  );

  assertEquals(badRequest?.status, "delivery_failed");
  assertEquals(badRequestCount, 1);
  assertEquals(badRequestSleeps, []);
});

Deno.test("legacy unavailable incidents use unavailableAt and retryAt identity", async () => {
  const payloads: Record<string, unknown>[] = [];
  const statuses = [204, 400, 204];
  const dependencies = {
    webhookUrl: "https://discord.example/runtime",
    fetch: ((_input: string | URL | Request, init?: RequestInit) => {
      payloads.push(requestPayload(init));
      return Promise.resolve(
        new Response(null, { status: statuses.shift() ?? 500 }),
      );
    }) as typeof fetch,
    dedupe: createInMemoryRuntimeAlertDedupe(),
    transitionQueue: createInMemoryRuntimeAlertTransitionQueue(),
  };
  const retryAt = "2026-09-01T07:00:00.000Z";

  const firstOutage = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_keys_unavailable",
    {
      model: "gemini-legacy-identity",
      unavailableAt: "2026-08-31T10:00:00.000Z",
      retryAt,
      quotaKind: "RPD",
    },
    dependencies,
  );
  const lostRecovery = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_service_recovered",
    {
      model: "gemini-legacy-identity",
      unavailableAt: "2026-08-31T10:00:00.000Z",
      recoveredAt: "2026-08-31T11:00:00.000Z",
      retryAt,
      quotaKind: "RPD",
    },
    dependencies,
  );
  const secondOutage = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_keys_unavailable",
    {
      model: "gemini-legacy-identity",
      unavailableAt: "2026-08-31T12:00:00.000Z",
      retryAt,
      quotaKind: "RPD",
    },
    dependencies,
  );

  assertEquals(firstOutage?.status, "sent");
  assertEquals(lostRecovery?.status, "delivery_failed");
  assertEquals(secondOutage?.status, "sent");
  assertEquals(payloads.length, 3);
  assertEquals(
    embedTitle(payloads[0]),
    "[CRITICAL] Gemini 전체 API 키 사용 불가",
  );
  assertEquals(
    embedTitle(payloads[2]),
    "[CRITICAL] Gemini 전체 API 키 사용 불가",
  );
});

Deno.test("same-model transition queue prevents a retrying recovery from being overtaken", async () => {
  const retrySleepStarted = deferredSignal();
  const releaseRetrySleep = deferredSignal();
  const requestTitles: string[] = [];
  let requestCount = 0;
  const dedupe = createInMemoryRuntimeAlertDedupe();
  const dependencies = {
    webhookUrl: "https://discord.example/runtime",
    fetch: ((_input: string | URL | Request, init?: RequestInit) => {
      requestCount += 1;
      requestTitles.push(embedTitle(requestPayload(init)) ?? "missing");
      return Promise.resolve(
        new Response(null, { status: requestCount === 1 ? 503 : 204 }),
      );
    }) as typeof fetch,
    dedupe,
    transitionQueue: createInMemoryRuntimeAlertTransitionQueue(),
    sleep: (_delayMs: number) => {
      retrySleepStarted.resolve();
      return releaseRetrySleep.promise;
    },
  };

  const olderRecovery = sendGeminiRuntimeDiscordAlert(
    "ai_gemini_service_recovered",
    {
      incidentId: 41,
      model: "gemini-ordered",
      unavailableAt: "2026-08-31T10:00:00.000Z",
      recoveredAt: "2026-08-31T10:01:00.000Z",
      retryAt: "2026-08-31T10:01:00.000Z",
      quotaKind: "RPM",
    },
    dependencies,
  );
  await retrySleepStarted.promise;

  const newerOutageDetails = {
    incidentId: 42,
    model: "gemini-ordered",
    unavailableAt: "2026-08-31T10:02:00.000Z",
    retryAt: "2026-08-31T10:03:00.000Z",
    quotaKind: "RPM",
  };
  const newerOutage = sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_keys_unavailable",
    newerOutageDetails,
    dependencies,
  );

  // The newer outage is queued; it cannot overtake the older recovery retry.
  assertEquals(requestCount, 1);
  releaseRetrySleep.resolve();
  const [recoveryOutcome, outageOutcome] = await Promise.all([
    olderRecovery,
    newerOutage,
  ]);

  assertEquals(recoveryOutcome?.status, "sent");
  assertEquals(outageOutcome?.status, "sent");
  assertEquals(requestTitles, [
    "[RECOVERED] Gemini 서비스 복구",
    "[RECOVERED] Gemini 서비스 복구",
    "[CRITICAL] Gemini 전체 API 키 사용 불가",
  ]);

  const duplicateOutage = await sendGeminiRuntimeDiscordAlert(
    "ai_gemini_api_keys_unavailable",
    newerOutageDetails,
    dependencies,
  );
  assertEquals(duplicateOutage?.status, "deduplicated");
  assertEquals(requestCount, 3);
});
