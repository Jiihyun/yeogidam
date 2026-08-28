import {
  ProviderUnlinkError,
  unlinkOAuthProviders,
} from "./provider_unlink.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function base64URLJSON(value: Record<string, unknown>): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function appleClientSecret(
  clientId = "com.yeogidamm.app",
  claimOverrides: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64URLJSON({ alg: "ES256", kid: "TESTKEY123" }),
    base64URLJSON({
      iss: "8QNP67WLL6",
      sub: clientId,
      aud: "https://appleid.apple.com",
      iat: now - 60,
      exp: now + 3600,
      ...claimOverrides,
    }),
    "test-signature",
  ].join(".");
}

function appleIDToken(subject = "apple-user"): string {
  return `header.${base64URLJSON({ sub: subject })}.signature`;
}

Deno.test("Kakao token owner is verified before unlink", async () => {
  const calls: string[] = [];
  await unlinkOAuthProviders(
    {
      identities: [{ provider: "kakao", providerUserId: "12345" }],
      providerTokens: { kakao: "kakao-token" },
    },
    (input) => {
      const url = String(input);
      calls.push(url);
      return Promise.resolve(
        url.endsWith("access_token_info")
          ? jsonResponse({ id: 12345 })
          : jsonResponse({ id: 12345 }),
      );
    },
  );
  assert(calls.length === 2, "Kakao verify and unlink must both be called");
  assert(calls[1].endsWith("/unlink"), "Kakao unlink endpoint was not called");
});

Deno.test("Google token for another user is never revoked", async () => {
  let revokeCalled = false;
  let caught: unknown;
  try {
    await unlinkOAuthProviders(
      {
        identities: [{ provider: "google", providerUserId: "expected-sub" }],
        providerTokens: { google: "google-token" },
      },
      (input) => {
        const url = String(input);
        if (url.includes("/revoke")) revokeCalled = true;
        return Promise.resolve(jsonResponse({ sub: "another-user" }));
      },
    );
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof ProviderUnlinkError, "mismatch must fail");
  assert(!revokeCalled, "another user's Google token must not be revoked");
});

Deno.test("Google token is revoked after user verification", async () => {
  const calls: string[] = [];
  await unlinkOAuthProviders(
    {
      identities: [{ provider: "google", providerUserId: "google-sub" }],
      providerTokens: { google: "google-token" },
    },
    (input) => {
      const url = String(input);
      calls.push(url);
      return Promise.resolve(
        url.includes("userinfo")
          ? jsonResponse({ sub: "google-sub" })
          : new Response(null, { status: 200 }),
      );
    },
  );
  assert(calls.length === 2, "Google verify and revoke must both be called");
});

Deno.test("social identity without a fresh provider credential fails safely", async () => {
  let caught: unknown;
  try {
    await unlinkOAuthProviders({
      identities: [{ provider: "kakao", providerUserId: "12345" }],
    });
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof ProviderUnlinkError, "missing token must fail");
});

Deno.test("Apple code is exchanged and its refresh token is revoked", async () => {
  const calls: string[] = [];
  await unlinkOAuthProviders(
    {
      identities: [{ provider: "apple", providerUserId: "apple-user" }],
      appleAuthorizationCode: "fresh-code",
      appleClientId: "com.yeogidamm.app",
      appleClientSecret: appleClientSecret(),
    },
    (input, init) => {
      const url = String(input);
      calls.push(url);
      const body = new URLSearchParams(String(init?.body));
      assert(init?.method === "POST", "Apple endpoints must use POST");
      assert(
        body.get("client_id") === "com.yeogidamm.app",
        "Apple client id is missing",
      );
      return Promise.resolve(
        url.endsWith("/token")
          ? jsonResponse({
            id_token: appleIDToken(),
            refresh_token: "apple-refresh-token",
          })
          : new Response(null, { status: 200 }),
      );
    },
  );
  assert(calls.length === 2, "Apple token and revoke endpoints must be called");
  assert(calls[1].endsWith("/revoke"), "Apple revoke endpoint was not called");
});

Deno.test("invalid Apple client secret is rejected before token exchange", async () => {
  let fetchCalled = false;
  let caught: unknown;
  try {
    await unlinkOAuthProviders(
      {
        identities: [{ provider: "apple", providerUserId: "apple-user" }],
        appleAuthorizationCode: "fresh-code",
        appleClientId: "com.yeogidamm.app",
        appleClientSecret: appleClientSecret("another.client.id"),
      },
      () => {
        fetchCalled = true;
        return Promise.resolve(jsonResponse({}));
      },
    );
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof ProviderUnlinkError, "invalid secret must fail");
  assert(caught.stage === "configuration", "wrong failure stage");
  assert(
    caught.upstreamCode === "invalid_client_secret",
    "wrong configuration code",
  );
  assert(!fetchCalled, "invalid secret must not be sent to Apple");
});

for (const upstreamCode of ["invalid_client", "invalid_grant"]) {
  Deno.test(`Apple ${upstreamCode} is preserved safely`, async () => {
    let revokeCalled = false;
    let caught: unknown;
    try {
      await unlinkOAuthProviders(
        {
          identities: [{ provider: "apple", providerUserId: "apple-user" }],
          appleAuthorizationCode: "fresh-code",
          appleClientId: "com.yeogidamm.app",
          appleClientSecret: appleClientSecret(),
        },
        (input) => {
          if (String(input).endsWith("/revoke")) revokeCalled = true;
          return Promise.resolve(jsonResponse({ error: upstreamCode }, 400));
        },
      );
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof ProviderUnlinkError, "Apple error must fail");
    assert(caught.stage === "token_exchange", "wrong failure stage");
    assert(caught.upstreamStatus === 400, "upstream status was lost");
    assert(caught.upstreamCode === upstreamCode, "upstream code was lost");
    assert(!revokeCalled, "revoke must not run after exchange failure");
  });
}

Deno.test("Apple revoke failure is distinguished from exchange failure", async () => {
  let caught: unknown;
  try {
    await unlinkOAuthProviders(
      {
        identities: [{ provider: "apple", providerUserId: "apple-user" }],
        appleAuthorizationCode: "fresh-code",
        appleClientId: "com.yeogidamm.app",
        appleClientSecret: appleClientSecret(),
      },
      (input) =>
        Promise.resolve(
          String(input).endsWith("/token")
            ? jsonResponse({
              id_token: appleIDToken(),
              refresh_token: "apple-refresh-token",
            })
            : jsonResponse({ error: "invalid_client" }, 400),
        ),
    );
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof ProviderUnlinkError, "revoke error must fail");
  assert(caught.stage === "token_revoke", "wrong failure stage");
  assert(caught.upstreamStatus === 400, "upstream status was lost");
  assert(caught.upstreamCode === "invalid_client", "upstream code was lost");
});
