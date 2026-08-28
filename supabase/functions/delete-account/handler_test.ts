import {
  type DeleteAccountDependencies,
  handleDeleteAccount,
} from "./handler.ts";
import { ProviderUnlinkError } from "./provider_unlink.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function request(
  method: string,
  body?: string,
  token?: string,
): Request {
  return new Request("http://localhost/functions/v1/delete-account", {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body }),
  });
}

function dependencies(
  overrides: Partial<DeleteAccountDependencies> = {},
): DeleteAccountDependencies {
  return {
    requestId: () => "request-delete-1",
    authenticate: async () => ({
      account: { userId: "user-1", identities: [] },
    }),
    unlinkProviders: async () => ({}),
    deleteUser: async () => ({}),
    ...overrides,
  };
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = await response.json();
  return body?.errorCode;
}

Deno.test("delete-account responds to CORS preflight", async () => {
  const response = await handleDeleteAccount(
    request("OPTIONS"),
    dependencies(),
  );
  assert(response.status === 200, "OPTIONS must succeed");
  assert(
    response.headers.get("Access-Control-Allow-Methods") === "DELETE, OPTIONS",
    "CORS methods are missing",
  );
});

Deno.test("delete-account rejects unsupported methods", async () => {
  const response = await handleDeleteAccount(request("POST"), dependencies());
  assert(response.status === 405, "POST must be rejected");
  assert(
    await errorCode(response) === "COMMON405_001",
    "wrong error code",
  );
});

Deno.test("delete-account requires a bearer token", async () => {
  const response = await handleDeleteAccount(
    request("DELETE", JSON.stringify({ confirmation: "DELETE" })),
    dependencies(),
  );
  assert(response.status === 401, "missing token must be unauthorized");
  assert(await errorCode(response) === "AUTH401_001", "wrong error code");
});

Deno.test("delete-account rejects malformed JSON", async () => {
  const response = await handleDeleteAccount(
    request("DELETE", "{", "access-token"),
    dependencies(),
  );
  assert(response.status === 400, "invalid JSON must be rejected");
  assert(
    await errorCode(response) === "COMMON400_001",
    "wrong error code",
  );
});

Deno.test("delete-account rejects non-object JSON bodies", async () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["array", []],
    ["string", "DELETE"],
    ["number", 1],
    ["boolean", true],
  ];

  for (const [label, body] of cases) {
    let authenticateCalled = false;
    const response = await handleDeleteAccount(
      request("DELETE", JSON.stringify(body), "access-token"),
      dependencies({
        authenticate: async () => {
          authenticateCalled = true;
          return { account: null };
        },
      }),
    );

    assert(response.status === 400, `${label} body must be rejected`);
    assert(
      await errorCode(response) === "COMMON400_001",
      `${label} body returned the wrong error code`,
    );
    assert(!authenticateCalled, `${label} body must fail before auth`);
  }
});

Deno.test("delete-account requires an exact confirmation value", async () => {
  const response = await handleDeleteAccount(
    request(
      "DELETE",
      JSON.stringify({ confirmation: "delete" }),
      "access-token",
    ),
    dependencies(),
  );
  assert(response.status === 400, "wrong confirmation must be rejected");
  assert(
    await errorCode(response) === "COMMON400_001",
    "wrong error code",
  );
});

Deno.test("delete-account requires a valid current session", async () => {
  const response = await handleDeleteAccount(
    request(
      "DELETE",
      JSON.stringify({ confirmation: "DELETE" }),
      "expired-token",
    ),
    dependencies({
      authenticate: async () => ({
        account: null,
        error: new Error("expired"),
      }),
    }),
  );
  assert(response.status === 401, "expired token must be unauthorized");
  assert(
    await errorCode(response) === "USER401_001",
    "wrong error code",
  );
});

Deno.test("delete-account stops when OAuth provider unlink fails", async () => {
  let deleteCalled = false;
  const response = await handleDeleteAccount(
    request(
      "DELETE",
      JSON.stringify({
        confirmation: "DELETE",
        providerTokens: { kakao: "provider-token" },
      }),
      "access-token",
    ),
    dependencies({
      authenticate: async () => ({
        account: {
          userId: "user-1",
          identities: [{ provider: "kakao", providerUserId: "123" }],
        },
      }),
      unlinkProviders: async () => ({ error: new Error("unlink failed") }),
      deleteUser: async () => {
        deleteCalled = true;
        return {};
      },
    }),
  );
  assert(response.status === 502, "unlink failure must stop deletion");
  assert(await errorCode(response) === "USER502_001", "wrong error code");
  assert(
    !deleteCalled,
    "internal account must not be deleted after unlink failure",
  );
});

Deno.test("delete-account logs only safe Apple failure diagnostics", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const response = await handleDeleteAccount(
    request(
      "DELETE",
      JSON.stringify({
        confirmation: "DELETE",
        appleAuthorizationCode: "sensitive-one-time-code",
      }),
      "access-token",
    ),
    dependencies({
      authenticate: async () => ({
        account: {
          userId: "user-1",
          identities: [{ provider: "apple", providerUserId: "apple-sub" }],
        },
      }),
      unlinkProviders: async () => ({
        error: new ProviderUnlinkError(
          "apple",
          "token_exchange",
          400,
          "invalid_grant",
        ),
      }),
      log: (entry) => logs.push(entry),
    }),
  );
  const serializedLogs = JSON.stringify(logs);
  assert(response.status === 502, "Apple unlink failure must return 502");
  assert(serializedLogs.includes("token_exchange"), "stage was not logged");
  assert(serializedLogs.includes("invalid_grant"), "safe code was not logged");
  assert(
    !serializedLogs.includes("sensitive-one-time-code"),
    "authorization code must never be logged",
  );
});

Deno.test("delete-account normalizes unexpected auth service failures", async () => {
  const response = await handleDeleteAccount(
    request(
      "DELETE",
      JSON.stringify({ confirmation: "DELETE" }),
      "access-token",
    ),
    dependencies({
      authenticate: () => Promise.reject(new Error("upstream unavailable")),
    }),
  );
  assert(response.status === 500, "auth service failure must be normalized");
  assert(await errorCode(response) === "COMMON500_001", "wrong error code");
});

Deno.test("delete-account exposes no internal admin error", async () => {
  const response = await handleDeleteAccount(
    request(
      "DELETE",
      JSON.stringify({ confirmation: "DELETE" }),
      "access-token",
    ),
    dependencies({
      deleteUser: async () => ({
        error: new Error("service_role secret and SQL details"),
      }),
    }),
  );
  const rawBody = await response.text();
  assert(response.status === 500, "admin failure must be a server error");
  assert(rawBody.includes("USER500_001"), "wrong error code");
  assert(!rawBody.includes("service_role"), "secret details must be hidden");
  assert(!rawBody.includes("SQL"), "database details must be hidden");
});

Deno.test("delete-account hard deletes only the authenticated user", async () => {
  let deletedUserId: string | null = null;
  const response = await handleDeleteAccount(
    request(
      "DELETE",
      JSON.stringify({ confirmation: "DELETE" }),
      "access-token",
    ),
    dependencies({
      authenticate: async (token) => ({
        account: token === "access-token"
          ? { userId: "authenticated-user", identities: [] }
          : null,
      }),
      deleteUser: async (userId) => {
        deletedUserId = userId;
        return {};
      },
    }),
  );

  assert(response.status === 204, "successful deletion must return 204");
  assert(
    deletedUserId === "authenticated-user",
    "the authenticated user id must be passed to the admin API",
  );
  assert(
    response.headers.get("X-Request-Id") === "request-delete-1",
    "request id is missing",
  );
});
