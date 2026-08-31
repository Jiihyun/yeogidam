type JsonRecord = Record<string, unknown>;

const OPERATIONS = new Set([
  "PLACE_EXTRACTION",
  "KAKAO_CANDIDATE_JUDGMENT",
]);
const PROVIDERS = new Set(["gemini", "openai"]);
const CREDENTIAL_ROLES = new Set(["Primary", "Fallback"]);
const QUOTA_KINDS = new Set(["RPM", "TPM", "RPD", "UNKNOWN"]);
const QUOTA_SCOPES = new Set(["DAY", "MINUTE", "UNKNOWN"]);
const CLASSIFICATION_REASONS = new Set([
  "EMPTY_ERROR_BODY",
  "ERROR_BODY_TOO_LARGE",
  "INVALID_ERROR_JSON",
  "ERROR_BODY_READ_TIMEOUT",
  "ERROR_BODY_READ_FAILED",
  "MISSING_ERROR_DETAILS",
  "MISSING_QUOTA_FAILURE",
  "MISSING_QUOTA_SIGNAL",
  "UNRECOGNIZED_QUOTA_SIGNAL",
  "AMBIGUOUS_QUOTA_KIND",
]);
const RETRY_HINT_SOURCES = new Set([
  "RETRY_AFTER",
  "RETRY_INFO",
  "RETRY_AFTER_AND_RETRY_INFO",
  "PACIFIC_MIDNIGHT",
  "MINUTE_DEFAULT",
  "ADAPTIVE_BACKOFF",
]);
const FAILURE_KINDS = new Set([
  "AUTH",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK",
  "UPSTREAM",
  "BAD_REQUEST",
  "CONTENT_BLOCKED",
  "INVALID_RESPONSE",
  "CANCELLED",
  "UNEXPECTED_INTERNAL",
]);
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;
const QUOTA_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;

function stringFromSet(value: unknown, allowed: Set<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function finiteInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER):
  | number
  | null {
  return typeof value === "number" && Number.isInteger(value) &&
      Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function finiteNumber(value: unknown, min = 0): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min
    ? value
    : null;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function modelName(value: unknown): string | null {
  return typeof value === "string" && MODEL_PATTERN.test(value) ? value : null;
}

function quotaIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string =>
    typeof id === "string" && QUOTA_ID_PATTERN.test(id)
  ).slice(0, 8);
  return ids.length > 0 ? ids : null;
}

function usage(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as JsonRecord;
  const inputTokens = finiteInteger(raw.inputTokens);
  const outputTokens = finiteInteger(raw.outputTokens);
  if (inputTokens === null && outputTokens === null) return null;
  return {
    ...(inputTokens === null ? {} : { inputTokens }),
    ...(outputTokens === null ? {} : { outputTokens }),
  };
}

/**
 * Keeps only fixed-shape operational metadata from AI provider events. This is
 * intentionally a top-level allowlist: arbitrary provider error objects,
 * messages, prompts, keys, and response bodies never reach logs.
 */
export function sanitizeAiRuntimeLogDetails(details: JsonRecord): JsonRecord {
  const sanitized: JsonRecord = {};
  const operation = stringFromSet(details.operation, OPERATIONS);
  const activatedOperation = stringFromSet(
    details.activatedOperation,
    OPERATIONS,
  );
  const cooldownOperation = stringFromSet(
    details.cooldownOperation,
    OPERATIONS,
  );
  const unavailableOperation = stringFromSet(
    details.unavailableOperation,
    OPERATIONS,
  );
  const provider = stringFromSet(details.provider, PROVIDERS);
  const fromProvider = stringFromSet(details.fromProvider, PROVIDERS);
  const toProvider = stringFromSet(details.toProvider, PROVIDERS);
  const model = modelName(details.model);
  const credentialRole = stringFromSet(
    details.credentialRole,
    CREDENTIAL_ROLES,
  );
  const fromCredentialRole = stringFromSet(
    details.fromCredentialRole,
    CREDENTIAL_ROLES,
  );
  const toCredentialRole = stringFromSet(
    details.toCredentialRole,
    CREDENTIAL_ROLES,
  );
  const triggeringCredentialRole = stringFromSet(
    details.triggeringCredentialRole,
    CREDENTIAL_ROLES,
  );
  const quotaKind = stringFromSet(details.quotaKind, QUOTA_KINDS);
  const quotaScope = stringFromSet(details.quotaScope, QUOTA_SCOPES);
  const classificationReason = stringFromSet(
    details.classificationReason,
    CLASSIFICATION_REASONS,
  );
  const retryHintSource = stringFromSet(
    details.retryHintSource,
    RETRY_HINT_SOURCES,
  );
  const failureKind = stringFromSet(details.failureKind, FAILURE_KINDS);
  const safeQuotaIds = quotaIds(details.quotaIds);
  const safeUsage = usage(details.usage);

  Object.assign(sanitized, {
    ...(operation ? { operation } : {}),
    ...(activatedOperation ? { activatedOperation } : {}),
    ...(cooldownOperation ? { cooldownOperation } : {}),
    ...(unavailableOperation ? { unavailableOperation } : {}),
    ...(provider ? { provider } : {}),
    ...(fromProvider ? { fromProvider } : {}),
    ...(toProvider ? { toProvider } : {}),
    ...(model ? { model } : {}),
    ...(credentialRole ? { credentialRole } : {}),
    ...(fromCredentialRole ? { fromCredentialRole } : {}),
    ...(toCredentialRole ? { toCredentialRole } : {}),
    ...(triggeringCredentialRole ? { triggeringCredentialRole } : {}),
    ...(quotaKind ? { quotaKind } : {}),
    ...(quotaScope ? { quotaScope } : {}),
    ...(classificationReason ? { classificationReason } : {}),
    ...(retryHintSource ? { retryHintSource } : {}),
    ...(failureKind ? { failureKind } : {}),
    ...(safeQuotaIds ? { quotaIds: safeQuotaIds } : {}),
    ...(safeUsage ? { usage: safeUsage } : {}),
  });

  for (
    const [name, value, min, max] of [
      ["credentialSlot", details.credentialSlot, 1, 100],
      ["fromCredentialSlot", details.fromCredentialSlot, 1, 100],
      ["toCredentialSlot", details.toCredentialSlot, 1, 100],
      [
        "triggeringCredentialSlot",
        details.triggeringCredentialSlot,
        1,
        100,
      ],
      ["credentialCount", details.credentialCount, 0, 100],
      ["incidentId", details.incidentId, 0, Number.MAX_SAFE_INTEGER],
      ["attemptCount", details.attemptCount, 0, Number.MAX_SAFE_INTEGER],
      ["resultCount", details.resultCount, 0, Number.MAX_SAFE_INTEGER],
      ["status", details.status, 100, 599],
    ] as const
  ) {
    const number = finiteInteger(value, min, max);
    if (number !== null) sanitized[name] = number;
  }

  for (
    const [name, value] of [
      ["durationMs", details.durationMs],
      ["cooldownMs", details.cooldownMs],
    ] as const
  ) {
    const number = finiteNumber(value);
    if (number !== null) sanitized[name] = number;
  }

  for (
    const [name, value] of [
      ["retryAt", details.retryAt],
      ["unavailableAt", details.unavailableAt],
      ["recoveredAt", details.recoveredAt],
    ] as const
  ) {
    const timestamp = isoTimestamp(value);
    if (timestamp) sanitized[name] = timestamp;
  }

  for (const name of ["fallbackUsed", "retryable"] as const) {
    if (typeof details[name] === "boolean") sanitized[name] = details[name];
  }

  return sanitized;
}
