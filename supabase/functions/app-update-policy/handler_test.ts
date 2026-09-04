import {
  type AppUpdatePolicyDependencies,
  compareAppVersions,
  handleAppUpdatePolicy,
} from "./handler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function request(
  query = "?platform=ios&appVersion=1.0.0",
  method = "GET",
): Request {
  return new Request(
    `http://localhost/functions/v1/app-update-policy${query}`,
    { method },
  );
}

function dependencies(
  overrides: Partial<AppUpdatePolicyDependencies> = {},
): AppUpdatePolicyDependencies {
  return {
    requestId: () => "request-update-1",
    policies: {
      ios: {
        minimumSupportedVersion: "1.1.0",
        storeUrl: "https://apps.apple.com/app/id6801408355",
      },
      android: {
        minimumSupportedVersion: "2.0.0",
        storeUrl:
          "https://play.google.com/store/apps/details?id=com.example.app",
      },
    },
    ...overrides,
  };
}

async function responseBody(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

Deno.test("app-update-policy responds to CORS preflight", () => {
  const response = handleAppUpdatePolicy(
    request("", "OPTIONS"),
    dependencies(),
  );

  assert(response.status === 200, "OPTIONS must succeed");
  assert(
    response.headers.get("Access-Control-Allow-Methods") === "GET, OPTIONS",
    "CORS methods are missing",
  );
});

Deno.test("app-update-policy rejects unsupported methods", async () => {
  const response = handleAppUpdatePolicy(
    request("?platform=ios&appVersion=1.0.0", "POST"),
    dependencies(),
  );

  assert(response.status === 405, "POST must be rejected");
  assert(
    (await responseBody(response)).errorCode === "COMMON405_001",
    "wrong error code",
  );
  assert(
    response.headers.get("Allow") === "GET, OPTIONS",
    "Allow header is missing",
  );
});

Deno.test("app-update-policy requires one valid platform parameter", async () => {
  const invalidQueries = [
    "?appVersion=1.0.0",
    "?platform=&appVersion=1.0.0",
    "?platform=web&appVersion=1.0.0",
    "?platform=ios&platform=android&appVersion=1.0.0",
  ];

  for (const query of invalidQueries) {
    const response = handleAppUpdatePolicy(request(query), dependencies());
    const body = await responseBody(response);
    assert(response.status === 400, `${query} must be rejected`);
    assert(body.errorCode === "COMMON400_002", `${query}: wrong error code`);
    assert(
      (body.details as Record<string, unknown>)?.field === "platform",
      `${query}: wrong error field`,
    );
  }
});

Deno.test("app-update-policy requires one numeric appVersion parameter", async () => {
  const invalidVersions = [
    null,
    "",
    "1",
    "1.0.0.0",
    "v1.1.0",
    "1.1.0-beta",
    "1..0",
  ];

  for (const appVersion of invalidVersions) {
    const query = appVersion === null
      ? "?platform=ios"
      : `?platform=ios&appVersion=${encodeURIComponent(appVersion)}`;
    const response = handleAppUpdatePolicy(request(query), dependencies());
    const body = await responseBody(response);
    assert(response.status === 400, `${String(appVersion)} must be rejected`);
    assert(body.errorCode === "COMMON400_002", "wrong error code");
    assert(
      (body.details as Record<string, unknown>)?.field === "appVersion",
      "wrong error field",
    );
  }
});

Deno.test("app-update-policy compares numeric version segments", () => {
  assert(compareAppVersions("1.0", "1.0.0") === 0, "1.0 must equal 1.0.0");
  assert(compareAppVersions("1.0.9", "1.1.0") < 0, "older version mismatch");
  assert(compareAppVersions("1.10.0", "1.9.0") > 0, "numeric ordering failed");
});

Deno.test("app-update-policy requires an update below the minimum version", async () => {
  const response = handleAppUpdatePolicy(
    request("?platform=ios&appVersion=1.0.9"),
    dependencies(),
  );
  const body = await responseBody(response);

  assert(response.status === 200, "valid request must succeed");
  assert(body.updateRequired === true, "older app must require an update");
  assert(body.minimumSupportedVersion === "1.1.0", "minimum is missing");
  assert(
    body.storeUrl === "https://apps.apple.com/app/id6801408355",
    "store URL is missing",
  );
});

Deno.test("app-update-policy allows the minimum and newer versions", async () => {
  for (const appVersion of ["1.1", "1.1.0", "1.2.0"]) {
    const response = handleAppUpdatePolicy(
      request(`?platform=ios&appVersion=${appVersion}`),
      dependencies(),
    );
    const body = await responseBody(response);
    assert(response.status === 200, `${appVersion} must succeed`);
    assert(
      body.updateRequired === false,
      `${appVersion} must not require an update`,
    );
  }
});

Deno.test("app-update-policy selects a policy by platform", async () => {
  const response = handleAppUpdatePolicy(
    request("?platform=android&appVersion=1.9.0"),
    dependencies(),
  );
  const body = await responseBody(response);

  assert(body.updateRequired === true, "Android policy was not applied");
  assert(body.minimumSupportedVersion === "2.0.0", "wrong Android minimum");
  assert(
    body.storeUrl ===
      "https://play.google.com/store/apps/details?id=com.example.app",
    "wrong Android store URL",
  );
});

Deno.test("app-update-policy fails closed when its policy is unavailable", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const invalidPolicies = [
    {},
    {
      ios: {
        minimumSupportedVersion: "latest",
        storeUrl: "https://apps.apple.com/app/id6801408355",
      },
    },
    {
      ios: {
        minimumSupportedVersion: "1.1.0",
        storeUrl: "javascript:alert(1)",
      },
    },
  ];

  for (const policies of invalidPolicies) {
    const response = handleAppUpdatePolicy(
      request(),
      dependencies({ policies, log: (entry) => logs.push(entry) }),
    );
    const body = await responseBody(response);
    assert(response.status === 503, "invalid policy must return 503");
    assert(body.errorCode === "UPDATE503_001", "wrong policy error code");
  }
  assert(logs.length === invalidPolicies.length, "each failure must be logged");
});

Deno.test("app-update-policy sends non-cacheable traceable JSON", () => {
  const response = handleAppUpdatePolicy(request(), dependencies());

  assert(
    response.headers.get("Content-Type") === "application/json; charset=utf-8",
    "JSON content type is missing",
  );
  assert(response.headers.get("Cache-Control") === "no-store", "cache allowed");
  assert(
    response.headers.get("X-Request-Id") === "request-update-1",
    "request id is missing",
  );
});
