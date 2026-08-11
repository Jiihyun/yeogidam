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
  const payload = btoa(JSON.stringify({ sub: "apple-user" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const calls: string[] = [];
  await unlinkOAuthProviders(
    {
      identities: [{ provider: "apple", providerUserId: "apple-user" }],
      appleAuthorizationCode: "fresh-code",
      appleClientId: "com.yeogidamm.app",
      appleClientSecret: "signed-client-secret",
    },
    (input) => {
      const url = String(input);
      calls.push(url);
      return Promise.resolve(
        url.endsWith("/token")
          ? jsonResponse({
            id_token: `header.${payload}.signature`,
            refresh_token: "apple-refresh-token",
          })
          : new Response(null, { status: 200 }),
      );
    },
  );
  assert(calls.length === 2, "Apple token and revoke endpoints must be called");
  assert(calls[1].endsWith("/revoke"), "Apple revoke endpoint was not called");
});
