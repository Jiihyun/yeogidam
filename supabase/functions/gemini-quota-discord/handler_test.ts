import {
  type GeminiQuotaDiscordDependencies,
  handleGeminiQuotaDiscord,
  quotaKindFromIncident,
} from "./handler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const username = "monitoring";
const password = "secret";

function authorization(): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function request(
  body: unknown,
  options: { method?: string; authorized?: boolean; rawBody?: string } = {},
): Request {
  return new Request("http://localhost/functions/v1/gemini-quota-discord", {
    method: options.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.authorized === false
        ? {}
        : { Authorization: authorization() }),
    },
    body: options.method === "GET"
      ? undefined
      : options.rawBody ?? JSON.stringify(body),
  });
}

function incident(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.2",
    incident: {
      incident_id: "incident-123",
      state: "open",
      renotify: false,
      scoping_project_id: "savvy-night-435401-a0",
      started_at: 1787920920,
      url:
        "https://console.cloud.google.com/monitoring/alerting/incidents/incident-123",
      policy_name: "Gemini RPM 80%",
      condition_name: "Gemini RPM 80%",
      observed_value: "0.8667",
      metric: {
        labels: {
          model: "gemini-3.5-flash-lite",
          limit_name:
            "GenerateContentRequestsPerMinutePerProjectPerModel-FreeTier",
        },
      },
      resource: { labels: { project_id: "savvy-night-435401-a0" } },
      ...overrides,
    },
  };
}

function dependencies(
  overrides: Partial<GeminiQuotaDiscordDependencies> = {},
): GeminiQuotaDiscordDependencies {
  return {
    webhookUsername: username,
    webhookPassword: password,
    discordWebhookUrl: "https://discord.com/api/webhooks/test/token",
    fetch: async () => new Response(null, { status: 204 }),
    now: () => new Date("2026-08-28T12:42:00Z"),
    ...overrides,
  };
}

Deno.test("gemini quota webhook accepts an open RPM incident", async () => {
  let targetUrl = "";
  let discordBodyText = "";
  const response = await handleGeminiQuotaDiscord(
    request(incident()),
    dependencies({
      fetch: async (input, init) => {
        targetUrl = String(input);
        discordBodyText = String(init?.body);
        return new Response(null, { status: 204 });
      },
    }),
  );

  assert(response.status === 204, "valid incident must be delivered");
  assert(targetUrl.includes("discord.com/api/webhooks"), "wrong target URL");
  const discordBody = JSON.parse(discordBodyText) as Record<string, unknown>;
  const content = String(discordBody.content ?? "");
  assert(content.includes("RPM"), "quota kind is missing");
  assert(content.includes("86.7%"), "observed ratio is missing");
  assert(content.includes("2026-08-28 21:42 KST"), "KST time is missing");
  assert(
    JSON.stringify(discordBody).includes("gemini-3.5-flash-lite"),
    "model is missing",
  );
});

Deno.test("gemini quota webhook recognizes RPD and TPM", () => {
  assert(
    quotaKindFromIncident({ condition_name: "Gemini RPD 80%" }) === "RPD",
    "RPD was not recognized",
  );
  assert(
    quotaKindFromIncident({
      policy_user_labels: { quota_kind: "tpm" },
      condition_name: "localized condition name",
    }) === "TPM",
    "TPM policy label was not recognized",
  );
});

Deno.test("gemini quota webhook ignores closed incidents", async () => {
  let sent = false;
  const response = await handleGeminiQuotaDiscord(
    request(incident({ state: "closed" })),
    dependencies({
      fetch: async () => {
        sent = true;
        return new Response(null, { status: 204 });
      },
    }),
  );
  assert(response.status === 202, "closed incident must be acknowledged");
  assert(!sent, "closed incident must not reach Discord");
});

Deno.test("gemini quota webhook ignores repeated notifications", async () => {
  let sent = false;
  const response = await handleGeminiQuotaDiscord(
    request(incident({ renotify: true })),
    dependencies({
      fetch: async () => {
        sent = true;
        return new Response(null, { status: 204 });
      },
    }),
  );
  assert(response.status === 202, "renotification must be acknowledged");
  assert(!sent, "renotification must not reach Discord");
});

Deno.test("gemini quota webhook ignores unrelated policies", async () => {
  let sent = false;
  const response = await handleGeminiQuotaDiscord(
    request(incident({
      policy_name: "Database CPU alert",
      condition_name: "CPU 80%",
    })),
    dependencies({
      fetch: async () => {
        sent = true;
        return new Response(null, { status: 204 });
      },
    }),
  );
  assert(response.status === 202, "unrelated policy must be acknowledged");
  assert(!sent, "unrelated policy must not reach Discord");
});

Deno.test("gemini quota webhook requires Basic authentication", async () => {
  const response = await handleGeminiQuotaDiscord(
    request(incident(), { authorized: false }),
    dependencies(),
  );
  assert(response.status === 401, "unauthorized request must be rejected");
  assert(
    response.headers.get("WWW-Authenticate")?.startsWith("Basic") === true,
    "Basic challenge is required by Cloud Monitoring",
  );
});

Deno.test("gemini quota webhook rejects malformed JSON", async () => {
  const response = await handleGeminiQuotaDiscord(
    request({}, { rawBody: "{" }),
    dependencies(),
  );
  assert(response.status === 400, "malformed JSON must be rejected");
});

Deno.test("gemini quota webhook accepts connection-test payloads", async () => {
  const response = await handleGeminiQuotaDiscord(
    request({ test: true }),
    dependencies(),
  );
  assert(response.status === 202, "non-incident payload must be acknowledged");
});

Deno.test("gemini quota webhook rejects unsupported methods", async () => {
  const response = await handleGeminiQuotaDiscord(
    request({}, { method: "GET" }),
    dependencies(),
  );
  assert(response.status === 405, "GET must be rejected");
});

Deno.test("gemini quota webhook reports missing server configuration", async () => {
  const response = await handleGeminiQuotaDiscord(
    request(incident()),
    dependencies({ discordWebhookUrl: undefined }),
  );
  assert(response.status === 500, "missing Discord URL must fail safely");
  assert(
    !(await response.text()).includes("discord.com"),
    "configuration response must not expose secrets",
  );
});

Deno.test("gemini quota webhook normalizes Discord failures", async () => {
  const response = await handleGeminiQuotaDiscord(
    request(incident()),
    dependencies({
      fetch: async () =>
        new Response("sensitive upstream body", { status: 429 }),
    }),
  );
  const responseBody = await response.text();
  assert(response.status === 502, "Discord rejection must return 502");
  assert(
    !responseBody.includes("sensitive upstream body"),
    "upstream body must not leak",
  );
});
