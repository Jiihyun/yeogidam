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

export type ProviderUnlinkStage =
  | "provider_request"
  | "configuration"
  | "token_exchange"
  | "token_missing"
  | "identity_mismatch"
  | "token_revoke";

export class ProviderUnlinkError extends Error {
  constructor(
    public readonly provider: string,
    public readonly stage: ProviderUnlinkStage = "provider_request",
    public readonly upstreamStatus?: number,
    public readonly upstreamCode?: string,
  ) {
    super(`provider_unlink_failed:${provider}:${stage}`);
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
  return decodeJwtPart(token.split(".")[1]);
}

function decodeJwtPart(part: string | undefined): Record<string, unknown> {
  if (!part) return {};
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

const appleOAuthErrorCodes = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);

function appleOAuthErrorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return undefined;
  }
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && appleOAuthErrorCodes.has(error)
    ? error
    : undefined;
}

function isValidAppleClientSecret(
  clientSecret: string,
  clientId: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const [encodedHeader, encodedClaims, signature, ...extra] = clientSecret
    .split(
      ".",
    );
  if (!encodedHeader || !encodedClaims || !signature || extra.length > 0) {
    return false;
  }

  const header = decodeJwtPart(encodedHeader);
  const claims = decodeJwtPart(encodedClaims);
  const issuedAt = claims.iat;
  const expiresAt = claims.exp;
  const maximumLifetimeSeconds = 15_777_000;

  return header.alg === "ES256" &&
    typeof header.kid === "string" && header.kid.length > 0 &&
    typeof claims.iss === "string" && claims.iss.length > 0 &&
    claims.sub === clientId &&
    claims.aud === "https://appleid.apple.com" &&
    typeof issuedAt === "number" && Number.isFinite(issuedAt) &&
    typeof expiresAt === "number" && Number.isFinite(expiresAt) &&
    issuedAt <= now + 300 &&
    expiresAt > now &&
    expiresAt > issuedAt &&
    expiresAt - issuedAt <= maximumLifetimeSeconds;
}

async function unlinkApple(
  identity: OAuthIdentity,
  authorizationCode: string | undefined,
  clientId: string | undefined,
  clientSecret: string | undefined,
  fetcher: Fetcher,
): Promise<void> {
  if (!authorizationCode || !clientId || !clientSecret) {
    throw new ProviderUnlinkError(
      "apple",
      "configuration",
      undefined,
      "missing_configuration",
    );
  }
  if (!isValidAppleClientSecret(clientSecret, clientId)) {
    throw new ProviderUnlinkError(
      "apple",
      "configuration",
      undefined,
      "invalid_client_secret",
    );
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetcher("https://appleid.apple.com/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
  } catch {
    throw new ProviderUnlinkError(
      "apple",
      "token_exchange",
      undefined,
      "network_error",
    );
  }
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok) {
    throw new ProviderUnlinkError(
      "apple",
      "token_exchange",
      tokenResponse.status,
      appleOAuthErrorCode(token),
    );
  }
  const claims = typeof token.id_token === "string"
    ? decodeJwtPayload(token.id_token)
    : {};
  const revocationToken = typeof token.refresh_token === "string"
    ? token.refresh_token
    : typeof token.access_token === "string"
    ? token.access_token
    : null;
  if (typeof token.id_token !== "string" || !revocationToken) {
    throw new ProviderUnlinkError("apple", "token_missing");
  }
  if (!sameProviderUser(claims.sub, identity.providerUserId)) {
    throw new ProviderUnlinkError("apple", "identity_mismatch");
  }

  let revokeResponse: Response;
  try {
    revokeResponse = await fetcher(
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
  } catch {
    throw new ProviderUnlinkError(
      "apple",
      "token_revoke",
      undefined,
      "network_error",
    );
  }
  if (!revokeResponse.ok) {
    const revokeError = await revokeResponse.json().catch(() => ({}));
    throw new ProviderUnlinkError(
      "apple",
      "token_revoke",
      revokeResponse.status,
      appleOAuthErrorCode(revokeError),
    );
  }
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
