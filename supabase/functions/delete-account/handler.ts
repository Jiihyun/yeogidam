import { createRequestId, errorResponse } from "../_shared/error_code.ts";

export const deleteAccountCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "DELETE, OPTIONS",
};

export type DeleteAccountDependencies = {
  authenticate: (
    accessToken: string,
  ) => Promise<{ account: AuthenticatedAccount | null; error?: unknown }>;
  unlinkProviders: (
    account: AuthenticatedAccount,
    body: DeleteAccountBody,
  ) => Promise<{ error?: unknown }>;
  deleteUser: (userId: string) => Promise<{ error?: unknown }>;
  requestId?: () => string;
  log?: (entry: Record<string, unknown>) => void;
};

export type AuthenticatedAccount = {
  userId: string;
  identities: Array<{ provider: string; providerUserId: string }>;
};

export type DeleteAccountBody = {
  confirmation?: unknown;
  providerTokens?: {
    kakao?: unknown;
    google?: unknown;
  };
  appleAuthorizationCode?: unknown;
};

function isDeleteAccountBody(value: unknown): value is DeleteAccountBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || null;
}

export async function handleDeleteAccount(
  request: Request,
  dependencies: DeleteAccountDependencies,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: deleteAccountCorsHeaders });
  }

  const requestId = (dependencies.requestId ?? createRequestId)();
  const errorOptions = { headers: deleteAccountCorsHeaders };

  if (request.method !== "DELETE") {
    return errorResponse("METHOD_NOT_ALLOWED", requestId, errorOptions);
  }

  const token = bearerToken(request);
  if (!token) {
    return errorResponse("AUTH_REQUIRED", requestId, errorOptions);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST_BODY", requestId, {
      ...errorOptions,
      details: { field: "confirmation" },
    });
  }

  if (!isDeleteAccountBody(body)) {
    return errorResponse("INVALID_REQUEST_BODY", requestId, {
      ...errorOptions,
      details: { field: "confirmation" },
    });
  }

  if (body.confirmation !== "DELETE") {
    return errorResponse("INVALID_REQUEST_BODY", requestId, {
      ...errorOptions,
      details: { field: "confirmation" },
    });
  }

  let authentication: Awaited<
    ReturnType<DeleteAccountDependencies["authenticate"]>
  >;
  try {
    authentication = await dependencies.authenticate(token);
  } catch {
    dependencies.log?.({
      event: "account_deletion_auth_error",
      requestId,
      errorCode: "COMMON500_001",
    });
    return errorResponse("INTERNAL_ERROR", requestId, errorOptions);
  }
  if (authentication.error || !authentication.account) {
    dependencies.log?.({
      event: "account_deletion_auth_failed",
      requestId,
      errorCode: "ACCOUNT_DELETION_REAUTH_REQUIRED",
    });
    return errorResponse(
      "ACCOUNT_DELETION_REAUTH_REQUIRED",
      requestId,
      errorOptions,
    );
  }

  let unlinkResult: Awaited<
    ReturnType<DeleteAccountDependencies["unlinkProviders"]>
  >;
  try {
    unlinkResult = await dependencies.unlinkProviders(
      authentication.account,
      body,
    );
  } catch {
    unlinkResult = { error: new Error("provider_unlink_failed") };
  }
  if (unlinkResult.error) {
    dependencies.log?.({
      event: "account_deletion_provider_unlink_failed",
      requestId,
      errorCode: "USER502_001",
    });
    return errorResponse(
      "ACCOUNT_DELETION_PROVIDER_UNLINK_FAILED",
      requestId,
      errorOptions,
    );
  }

  let deletion: Awaited<ReturnType<DeleteAccountDependencies["deleteUser"]>>;
  try {
    deletion = await dependencies.deleteUser(authentication.account.userId);
  } catch {
    dependencies.log?.({
      event: "account_deletion_failed",
      requestId,
      errorCode: "USER500_001",
    });
    return errorResponse("ACCOUNT_DELETION_FAILED", requestId, errorOptions);
  }
  if (deletion.error) {
    dependencies.log?.({
      event: "account_deletion_failed",
      requestId,
      errorCode: "ACCOUNT_DELETION_FAILED",
    });
    return errorResponse("ACCOUNT_DELETION_FAILED", requestId, errorOptions);
  }

  dependencies.log?.({ event: "account_deleted", requestId });
  return new Response(null, {
    status: 204,
    headers: {
      ...deleteAccountCorsHeaders,
      "X-Request-Id": requestId,
    },
  });
}
