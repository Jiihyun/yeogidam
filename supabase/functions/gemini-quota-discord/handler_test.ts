import {
  createInMemoryCloudIncidentDedupe,
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
      scoping_project_id: "gen-lang-client-0666690473",
      started_at: 1787920920,
      url:
        "https://console.cloud.google.com/monitoring/alerting/incidents/incident-123",
      policy_name: "Gemini Primary RPD 80% WARNING",
      condition_name: "Gemini Primary RPD 80% WARNING",
      policy_user_labels: {
        quota_kind: "rpd",
        project_role: "primary",
        threshold_percent: "80",
        severity: "warning",
      },
      observed_value: "0.8667",
      metric: {
        labels: {
          model: "gemini-3.5-flash-lite",
          limit_name:
            "GenerateContentRequestsPerDayPerProjectPerModel-FreeTier",
        },
      },
      resource: {
        labels: {
          resource_container: "gen-lang-client-0666690473",
          location: "global",
        },
      },
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
    dedupe: createInMemoryCloudIncidentDedupe(),
    ...overrides,
  };
}

Deno.test("gemini quota webhook delivers a Primary RPD warning", async () => {
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
  const embeds = discordBody.embeds as Array<Record<string, unknown>>;
  assert(
    embeds[0]?.title === "[WARN][PRIMARY] Gemini RPD 80%",
    "Primary embed title must use the agreed format",
  );
  assert(content.includes("Primary"), "Primary role is missing");
  assert(content.includes("RPD"), "quota kind is missing");
  assert(content.includes("WARNING"), "severity is missing");
  assert(content.includes("경고선 80%"), "policy threshold is missing");
  assert(content.includes("86.7%"), "observed ratio is missing");
  assert(content.includes("2026-08-28 21:42 KST"), "KST time is missing");
  assert(
    JSON.stringify(discordBody).includes("gemini-3.5-flash-lite"),
    "model is missing",
  );
});

Deno.test("gemini quota webhook delivers a Fallback RPD warning", async () => {
  let discordBodyText = "";
  const response = await handleGeminiQuotaDiscord(
    request(incident({
      policy_name: "Gemini Fallback RPD 80% WARNING",
      condition_name: "Gemini Fallback RPD 80% WARNING",
      policy_user_labels: {
        quota_kind: "RPD",
        project_role: "fallback",
        threshold_percent: "80",
        severity: "WARNING",
      },
      resource: {
        labels: {
          resource_container: "yeogidam",
          location: "global",
        },
      },
    })),
    dependencies({
      fetch: async (_input, init) => {
        discordBodyText = String(init?.body);
        return new Response(null, { status: 204 });
      },
    }),
  );

  assert(response.status === 204, "Fallback incident must be delivered");
  const discordBody = JSON.parse(discordBodyText) as Record<string, unknown>;
  const embeds = discordBody.embeds as Array<Record<string, unknown>>;
  assert(
    embeds[0]?.title === "[WARN][FALLBACK] Gemini RPD 80%",
    "Fallback embed title must use the agreed format",
  );
  assert(discordBodyText.includes("Fallback"), "Fallback role is missing");
  assert(
    discordBodyText.includes("yeogidam"),
    "source project is missing",
  );
  assert(
    !discordBodyText.includes(
      'Google Cloud 프로젝트","value":"gen-lang-client-0666690473',
    ),
    "scoping project must not replace the source project",
  );
});

Deno.test("gemini quota webhook validates each role against its source project", async () => {
  for (
    const sourceLabels of [
      { resource_container: "yeogidam" },
      {},
    ]
  ) {
    let sent = false;
    const response = await handleGeminiQuotaDiscord(
      request(incident({
        resource: { labels: sourceLabels },
      })),
      dependencies({
        fetch: async () => {
          sent = true;
          return new Response(null, { status: 204 });
        },
      }),
    );

    assert(response.status === 202, "invalid source project must be ignored");
    assert(!sent, "invalid source project must not reach Discord");
  }
});

Deno.test("gemini quota webhook delivers the same incident only once", async () => {
  let deliveries = 0;
  const deps = dependencies({
    fetch: async () => {
      deliveries += 1;
      return new Response(null, { status: 204 });
    },
  });

  const first = await handleGeminiQuotaDiscord(request(incident()), deps);
  const duplicate = await handleGeminiQuotaDiscord(request(incident()), deps);

  assert(first.status === 204, "first incident must be delivered");
  assert(duplicate.status === 202, "duplicate incident must be acknowledged");
  assert(deliveries === 1, "duplicate incident must not reach Discord");
});

Deno.test("gemini quota webhook does not parse empty numbers as zero", async () => {
  let discordBodyText = "";
  const response = await handleGeminiQuotaDiscord(
    request(incident({ observed_value: "", started_at: "" })),
    dependencies({
      fetch: async (_input, init) => {
        discordBodyText = String(init?.body);
        return new Response(null, { status: 204 });
      },
    }),
  );

  assert(response.status === 204, "valid incident must be delivered");
  assert(
    discordBodyText.includes("사용률 정보 없음"),
    "empty observed value must stay unknown",
  );
  assert(
    discordBodyText.includes("2026-08-28 21:42 KST"),
    "empty started_at must use the receipt time",
  );
  assert(!discordBodyText.includes("1970-01-01"), "epoch must not be shown");
});

Deno.test("gemini quota webhook reads quota kind only from policy labels", () => {
  assert(
    quotaKindFromIncident({
      policy_user_labels: { quota_kind: "rpd" },
    }) === "RPD",
    "labeled RPD was not recognized",
  );
  assert(
    quotaKindFromIncident({
      policy_user_labels: { quota_kind: "tpm" },
      condition_name: "localized condition name",
    }) === "TPM",
    "TPM policy label was not recognized",
  );
  assert(
    quotaKindFromIncident({ condition_name: "Gemini RPD 80%" }) === null,
    "policy names must not substitute for routing labels",
  );
});

Deno.test("gemini quota webhook ignores RPM and TPM cloud incidents", async () => {
  for (const quotaKind of ["rpm", "tpm"]) {
    let sent = false;
    const response = await handleGeminiQuotaDiscord(
      request(incident({
        policy_user_labels: {
          quota_kind: quotaKind,
          project_role: "primary",
          threshold_percent: "80",
          severity: "warning",
        },
      })),
      dependencies({
        fetch: async () => {
          sent = true;
          return new Response(null, { status: 204 });
        },
      }),
    );

    assert(response.status === 202, `${quotaKind} must be acknowledged`);
    assert(!sent, `${quotaKind} must not reach Discord`);
  }
});

Deno.test("gemini quota webhook accepts only the finalized RPD policy labels", async () => {
  const invalidLabels = [
    {
      quota_kind: "rpd",
      threshold_percent: "80",
      severity: "warning",
    },
    {
      quota_kind: "rpd",
      project_role: "primary",
      threshold_percent: "75",
      severity: "warning",
    },
    {
      quota_kind: "rpd",
      project_role: "primary",
      threshold_percent: "80",
      severity: "critical",
    },
  ];

  for (const policy_user_labels of invalidLabels) {
    let sent = false;
    const response = await handleGeminiQuotaDiscord(
      request(incident({ policy_user_labels })),
      dependencies({
        fetch: async () => {
          sent = true;
          return new Response(null, { status: 204 });
        },
      }),
    );

    assert(response.status === 202, "unsupported policy must be acknowledged");
    assert(!sent, "unsupported policy must not reach Discord");
  }
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
      policy_user_labels: {},
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
  let deliveries = 0;
  const deps = dependencies({
    fetch: async () => {
      deliveries += 1;
      return deliveries === 1
        ? new Response("sensitive upstream body", { status: 429 })
        : new Response(null, { status: 204 });
    },
  });
  const rejected = await handleGeminiQuotaDiscord(request(incident()), deps);
  const responseBody = await rejected.text();
  const retried = await handleGeminiQuotaDiscord(request(incident()), deps);

  assert(rejected.status === 502, "Discord rejection must return 502");
  assert(
    !responseBody.includes("sensitive upstream body"),
    "upstream body must not leak",
  );
  assert(retried.status === 204, "failed delivery must release incident claim");
  assert(deliveries === 2, "released incident must be deliverable again");
});
