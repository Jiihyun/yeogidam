import {
  createRequestId,
  ErrorCode,
  errorResponse,
} from "../_shared/error_code.ts";

export type AppPlatform = "ios" | "android";

export type AppUpdatePolicy = {
  minimumSupportedVersion: string;
  storeUrl: string;
};

export type AppUpdatePolicyDependencies = {
  policies: Partial<Record<AppPlatform, AppUpdatePolicy>>;
  requestId?: () => string;
  log?: (entry: Record<string, unknown>) => void;
};

export const appUpdatePolicyCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "X-Request-Id",
};

const noStoreHeaders = {
  ...appUpdatePolicyCorsHeaders,
  "Cache-Control": "no-store",
};

const appVersionPattern = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,2}$/;

function versionParts(value: string): [number, number, number] | null {
  if (value.length > 32 || !appVersionPattern.test(value)) return null;

  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;

  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function compareAppVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts || !rightParts) {
    throw new TypeError("invalid_app_version");
  }

  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function singleQueryParameter(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1) return null;

  const value = values[0].trim();
  return value.length > 0 ? value : null;
}

function appPlatform(value: string): AppPlatform | null {
  return value === "ios" || value === "android" ? value : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function invalidQueryParameter(
  field: "platform" | "appVersion",
  requestId: string,
): Response {
  return errorResponse("INVALID_QUERY_PARAMETER", requestId, {
    headers: noStoreHeaders,
    details: { field },
  });
}

function jsonResponse(
  body: Record<string, unknown>,
  requestId: string,
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...noStoreHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "X-Request-Id": requestId,
    },
  });
}

export function handleAppUpdatePolicy(
  request: Request,
  dependencies: AppUpdatePolicyDependencies,
): Response {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: appUpdatePolicyCorsHeaders });
  }

  const requestId = (dependencies.requestId ?? createRequestId)();
  if (request.method !== "GET") {
    return errorResponse("METHOD_NOT_ALLOWED", requestId, {
      headers: { ...noStoreHeaders, Allow: "GET, OPTIONS" },
    });
  }

  const url = new URL(request.url);
  const platformValue = singleQueryParameter(url, "platform");
  const platform = platformValue ? appPlatform(platformValue) : null;
  if (!platform) return invalidQueryParameter("platform", requestId);

  const appVersion = singleQueryParameter(url, "appVersion");
  if (!appVersion || !versionParts(appVersion)) {
    return invalidQueryParameter("appVersion", requestId);
  }

  const policy = dependencies.policies[platform];
  const minimumSupportedVersion = policy?.minimumSupportedVersion.trim() ?? "";
  const storeUrl = policy?.storeUrl.trim() ?? "";
  if (
    !versionParts(minimumSupportedVersion) ||
    !isHttpsUrl(storeUrl)
  ) {
    dependencies.log?.({
      event: "app_update_policy_unavailable",
      requestId,
      platform,
      errorCode: ErrorCode.APP_UPDATE_POLICY_UNAVAILABLE.code,
    });
    return errorResponse("APP_UPDATE_POLICY_UNAVAILABLE", requestId, {
      headers: noStoreHeaders,
      details: { platform },
    });
  }

  return jsonResponse({
    updateRequired: compareAppVersions(
      appVersion,
      minimumSupportedVersion,
    ) < 0,
    minimumSupportedVersion,
    storeUrl,
  }, requestId);
}
