export type OAuthIdentity = {
  provider: string;
  providerUserId: string;
};

export type ProviderUnlinkInput = {
  identities: OAuthIdentity[];
  providerTokens?: { kakao?: string; google?: string };
  appleAuthorizationCode?: string;
  appleClientId?: string;
  appleClientSecret?: string;
};

type Fetcher = typeof fetch;

export class ProviderUnlinkError extends Error {
  constructor(public readonly provider: string) {
    super(`provider_unlink_failed:${provider}`);
    this.name = "ProviderUnlinkError";
  }
}

function identityFor(
  identities: OAuthIdentity[],
  provider: string,
): OAuthIdentity | undefined {
  return identities.find((identity) => identity.provider === provider);
}

function sameProviderUser(actual: unknown, expected: string): boolean {
  return String(actual ?? "") === expected;
}

async function unlinkKakao(
  identity: OAuthIdentity,
  accessToken: string | undefined,
  fetcher: Fetcher,
): Promise<void> {
  if (!accessToken) throw new ProviderUnlinkError("kakao");

  const infoResponse = await fetcher(
    "https://kapi.kakao.com/v1/user/access_token_info",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const info = await infoResponse.json().catch(() => ({}));
  if (
    !infoResponse.ok || !sameProviderUser(info.id, identity.providerUserId)
  ) {
    throw new ProviderUnlinkError("kakao");
  }

  const unlinkResponse = await fetcher(
    "https://kapi.kakao.com/v1/user/unlink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
    },
  );
  const result = await unlinkResponse.json().catch(() => ({}));
  if (
    !unlinkResponse.ok ||
    !sameProviderUser(result.id, identity.providerUserId)
  ) {
    throw new ProviderUnlinkError("kakao");
  }
}

async function unlinkGoogle(
  identity: OAuthIdentity,
  accessToken: string | undefined,
  fetcher: Fetcher,
): Promise<void> {
  if (!accessToken) throw new ProviderUnlinkError("google");

  const userInfoResponse = await fetcher(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const userInfo = await userInfoResponse.json().catch(() => ({}));
  if (
    !userInfoResponse.ok ||
    !sameProviderUser(userInfo.sub, identity.providerUserId)
  ) {
    throw new ProviderUnlinkError("google");
  }

  const revokeResponse = await fetcher(
    "https://oauth2.googleapis.com/revoke",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }),
    },
  );
  if (!revokeResponse.ok) throw new ProviderUnlinkError("google");
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) return {};
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

async function unlinkApple(
  identity: OAuthIdentity,
  authorizationCode: string | undefined,
  clientId: string | undefined,
  clientSecret: string | undefined,
  fetcher: Fetcher,
): Promise<void> {
  if (!authorizationCode || !clientId || !clientSecret) {
    throw new ProviderUnlinkError("apple");
  }

  const tokenResponse = await fetcher("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const token = await tokenResponse.json().catch(() => ({}));
  const claims = typeof token.id_token === "string"
    ? decodeJwtPayload(token.id_token)
    : {};
  const revocationToken = typeof token.refresh_token === "string"
    ? token.refresh_token
    : typeof token.access_token === "string"
    ? token.access_token
    : null;
  if (
    !tokenResponse.ok ||
    !revocationToken ||
    !sameProviderUser(claims.sub, identity.providerUserId)
  ) {
    throw new ProviderUnlinkError("apple");
  }

  const revokeResponse = await fetcher(
    "https://appleid.apple.com/auth/revoke",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: revocationToken,
        token_type_hint: typeof token.refresh_token === "string"
          ? "refresh_token"
          : "access_token",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
  );
  if (!revokeResponse.ok) throw new ProviderUnlinkError("apple");
}

export async function unlinkOAuthProviders(
  input: ProviderUnlinkInput,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const kakao = identityFor(input.identities, "kakao");
  if (kakao) {
    await unlinkKakao(kakao, input.providerTokens?.kakao, fetcher);
  }

  const google = identityFor(input.identities, "google");
  if (google) {
    await unlinkGoogle(google, input.providerTokens?.google, fetcher);
  }

  const apple = identityFor(input.identities, "apple");
  if (apple) {
    await unlinkApple(
      apple,
      input.appleAuthorizationCode,
      input.appleClientId,
      input.appleClientSecret,
      fetcher,
    );
  }
}
