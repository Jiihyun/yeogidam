import {
  AiContractError,
  CANDIDATE_JUDGMENT_JSON_SCHEMA,
  parseCandidateJudgmentPayload,
  parseJsonPayload,
  parsePlaceExtractionPayload,
  PLACE_EXTRACTION_JSON_SCHEMA,
} from "../contracts.ts";
import { aiHttpError, AiProviderError } from "../errors.ts";
import {
  type AiErrorBodyStatus,
  AiRequestTimeoutError,
  AiResponseJsonError,
  fetchJsonWithTimeout,
} from "../http.ts";
import {
  buildCandidateJudgmentPrompt,
  buildPlaceExtractionPrompt,
} from "../prompts.ts";
import type {
  AiLog,
  PlaceAiProvider,
  ProviderCallResult,
  ProviderUsage,
} from "../provider.ts";
import type {
  AiCandidateJudgment,
  AiOperation,
  KakaoCandidateReviewItem,
  PlaceGuess,
} from "../types.ts";

export interface GeminiProviderConfig {
  apiKey: string;
  fallbackApiKeys?: readonly string[];
  extractionModel: string;
  judgmentModel: string;
  timeoutMs: number;
}

interface GeminiProviderDependencies {
  fetch?: typeof fetch;
  log?: AiLog;
  now?: () => number;
  state?: GeminiApiKeyStateStore;
}

export type GeminiQuotaKind = "RPM" | "TPM" | "RPD" | "UNKNOWN";
export type GeminiQuotaScope = "DAY" | "MINUTE" | "UNKNOWN";
export type GeminiCredentialRole = "Primary" | "Fallback";
export type GeminiQuotaClassificationReason =
  | "EMPTY_ERROR_BODY"
  | "ERROR_BODY_TOO_LARGE"
  | "INVALID_ERROR_JSON"
  | "ERROR_BODY_READ_TIMEOUT"
  | "ERROR_BODY_READ_FAILED"
  | "MISSING_ERROR_DETAILS"
  | "MISSING_QUOTA_FAILURE"
  | "MISSING_QUOTA_SIGNAL"
  | "UNRECOGNIZED_QUOTA_SIGNAL"
  | "AMBIGUOUS_QUOTA_KIND";
export type GeminiRetryHintSource =
  | "RETRY_AFTER"
  | "RETRY_INFO"
  | "RETRY_AFTER_AND_RETRY_INFO"
  | "PACIFIC_MIDNIGHT"
  | "MINUTE_DEFAULT"
  | "ADAPTIVE_BACKOFF";

export interface GeminiApiKeyCooldownState {
  generation: number;
  transitionGeneration: number;
  cooldownUntilMs: number;
  unknownRateLimitStrikes: number;
  quotaScope: GeminiQuotaScope;
  quotaKind: GeminiQuotaKind;
  classificationReason?: GeminiQuotaClassificationReason;
  quotaIds: string[];
  retryAt: string;
  retryHintSource: GeminiRetryHintSource;
  cooldownMs: number;
  model: string;
  operation: AiOperation;
  credentialRole: GeminiCredentialRole;
  credentialSlot: number;
  fallbackActivationPending: boolean;
  fallbackActivated: boolean;
}

interface GeminiServiceUnavailableState {
  incidentId: number;
  unavailableAt: string;
  operation: AiOperation;
  model: string;
  credentialRole: GeminiCredentialRole;
  credentialSlot: number;
  quotaScope: GeminiQuotaScope;
  quotaKind: GeminiQuotaKind;
  classificationReason?: GeminiQuotaClassificationReason;
  quotaIds: string[];
  cooldownMs: number;
  retryAt: string;
  retryHintSource: GeminiRetryHintSource;
}

interface GeminiApiKeyAuthIncidentState {
  incidentId: number;
}

interface GeminiCredentialAttempt {
  apiKeyIndex: number;
  startedAtMs: number;
  cooldownGeneration: number | null;
  fallbackTransitionGenerations: Map<number, number>;
  authIncidentId: number | null;
  serviceIncidentId: number | null;
}

export interface GeminiApiKeyStateStore {
  cooldowns: Map<string, GeminiApiKeyCooldownState>;
  unavailableServices: Map<string, GeminiServiceUnavailableState>;
  authIncidents: Map<string, GeminiApiKeyAuthIncidentState>;
  nextCooldownGeneration: number;
  nextServiceIncidentId: number;
  nextAuthIncidentId: number;
}

const sharedGeminiApiKeyState: GeminiApiKeyStateStore = {
  cooldowns: new Map(),
  unavailableServices: new Map(),
  authIncidents: new Map(),
  nextCooldownGeneration: 1,
  nextServiceIncidentId: 1,
  nextAuthIncidentId: 1,
};
const ADAPTIVE_COOLDOWN_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const LOS_ANGELES_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function createGeminiApiKeyStateStore(): GeminiApiKeyStateStore {
  return {
    cooldowns: new Map(),
    unavailableServices: new Map(),
    authIncidents: new Map(),
    nextCooldownGeneration: 1,
    nextServiceIncidentId: 1,
    nextAuthIncidentId: 1,
  };
}

function zonedDateTimeParts(epochMs: number): Record<string, number> {
  const values: Record<string, number> = {};
  for (const part of LOS_ANGELES_DATE_TIME.formatToParts(epochMs)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values;
}

function nextLosAngelesMidnightMs(nowMs: number): number {
  const current = zonedDateTimeParts(nowMs);
  const targetLocalMs = Date.UTC(
    current.year,
    current.month - 1,
    current.day + 1,
  );
  let candidateMs = targetLocalMs + 8 * 60 * 60_000;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const candidate = zonedDateTimeParts(candidateMs);
    const representedLocalMs = Date.UTC(
      candidate.year,
      candidate.month - 1,
      candidate.day,
      candidate.hour,
      candidate.minute,
      candidate.second,
    );
    const correctionMs = targetLocalMs - representedLocalMs;
    if (correctionMs === 0) return candidateMs;
    candidateMs += correctionMs;
  }
  return candidateMs;
}

function retryAfterMs(response: Response, nowMs: number): number | undefined {
  const retryAfter = response.headers.get("Retry-After")?.trim();
  if (!retryAfter) return undefined;

  if (/^\d+$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    const milliseconds = seconds * 1_000;
    if (Number.isSafeInteger(milliseconds)) return milliseconds;
  }

  const retryAt = Date.parse(retryAfter);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - nowMs) : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

interface GeminiRateLimitMetadata {
  quotaScope: GeminiQuotaScope;
  quotaKind: GeminiQuotaKind;
  classificationReason?: GeminiQuotaClassificationReason;
  quotaIds: string[];
  retryInfoMs?: number;
}

function googleDurationMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const match = /^(\d+)(?:\.(\d{1,9}))?s$/.exec(value);
    if (!match) return undefined;
    const seconds = Number(match[1]);
    const fraction = Number(`0.${match[2] ?? "0"}`);
    const milliseconds = (seconds + fraction) * 1_000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }

  const duration = record(value);
  if (
    !duration ||
    (!("seconds" in duration) && !("nanos" in duration))
  ) return undefined;
  const seconds = Number(duration.seconds ?? 0);
  const nanos = Number(duration.nanos ?? 0);
  const milliseconds = seconds * 1_000 + nanos / 1_000_000;
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? milliseconds
    : undefined;
}

function maxDefined(
  ...values: Array<number | undefined>
): number | undefined {
  let maximum: number | undefined;
  for (const value of values) {
    if (value !== undefined && (maximum === undefined || value > maximum)) {
      maximum = value;
    }
  }
  return maximum;
}

function quotaKindForSignal(
  signal: string,
): Exclude<GeminiQuotaKind, "UNKNOWN"> | null {
  const normalized = signal.toLocaleLowerCase("en-US");
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (/\brpd\b/.test(normalized)) return "RPD";
  if (/\btpm\b/.test(normalized)) return "TPM";
  if (/\brpm\b/.test(normalized)) return "RPM";

  const perDay = compact.includes("perday") || normalized.includes("daily");
  const perMinute = compact.includes("perminute");
  const tokenQuota = /tokens?/.test(normalized);
  const requestQuota = /requests?/.test(normalized);
  if (perDay && requestQuota) return "RPD";
  if (perMinute && tokenQuota) return "TPM";
  if (perMinute && requestQuota) return "RPM";
  return null;
}

function quotaScopeForSignals(
  signals: readonly string[],
  kinds: ReadonlySet<Exclude<GeminiQuotaKind, "UNKNOWN">>,
): GeminiQuotaScope {
  const normalized = signals.join(" ").toLocaleLowerCase("en-US");
  if (
    kinds.has("RPD") || /\b(?:rpd|tpd)\b|per[_ -]?day|daily/.test(normalized)
  ) return "DAY";
  if (
    kinds.has("RPM") || kinds.has("TPM") ||
    /\b(?:rpm|tpm)\b|per[_ -]?minute/.test(normalized)
  ) return "MINUTE";
  return "UNKNOWN";
}

/**
 * Best-effort only: Gemini does not document google.rpc error details as a
 * stable API contract. Unknown shapes deliberately fall back to adaptive
 * cooldown without retaining or logging provider text.
 */
function rateLimitMetadata(
  payload: unknown,
  errorBodyStatus?: AiErrorBodyStatus,
): GeminiRateLimitMetadata {
  const unreadableReason = errorBodyStatus === "EMPTY"
    ? "EMPTY_ERROR_BODY"
    : errorBodyStatus === "TOO_LARGE"
    ? "ERROR_BODY_TOO_LARGE"
    : errorBodyStatus === "INVALID_JSON"
    ? "INVALID_ERROR_JSON"
    : errorBodyStatus === "READ_TIMEOUT"
    ? "ERROR_BODY_READ_TIMEOUT"
    : errorBodyStatus === "READ_FAILED"
    ? "ERROR_BODY_READ_FAILED"
    : null;
  if (unreadableReason) {
    return {
      quotaScope: "UNKNOWN",
      quotaKind: "UNKNOWN",
      classificationReason: unreadableReason,
      quotaIds: [],
    };
  }
  const details = record(record(payload)?.error)?.details;
  if (!Array.isArray(details)) {
    return {
      quotaScope: "UNKNOWN",
      quotaKind: "UNKNOWN",
      classificationReason: "MISSING_ERROR_DETAILS",
      quotaIds: [],
    };
  }

  const quotaSignals: string[] = [];
  const quotaIds: string[] = [];
  let foundQuotaFailure = false;
  let retryInfoMs: number | undefined;
  for (const rawDetail of details) {
    const detail = record(rawDetail);
    if (!detail) continue;
    const detailType = typeof detail["@type"] === "string"
      ? detail["@type"]
      : "";
    if (detailType.endsWith("google.rpc.RetryInfo")) {
      retryInfoMs = maxDefined(
        retryInfoMs,
        googleDurationMs(detail.retryDelay),
      );
      continue;
    }
    if (!detailType.endsWith("google.rpc.QuotaFailure")) continue;
    foundQuotaFailure = true;

    const violations = detail.violations;
    if (!Array.isArray(violations)) continue;
    for (const rawViolation of violations) {
      const violation = record(rawViolation);
      if (!violation) continue;
      for (const field of ["quotaId", "quotaMetric", "description"]) {
        const signal = violation[field];
        if (typeof signal !== "string") continue;
        quotaSignals.push(signal);
        if (field === "quotaId" && !quotaIds.includes(signal)) {
          quotaIds.push(signal);
        }
      }
    }
  }

  const kinds = new Set<Exclude<GeminiQuotaKind, "UNKNOWN">>();
  for (const signal of quotaSignals) {
    const kind = quotaKindForSignal(signal);
    if (kind) kinds.add(kind);
  }
  const quotaKind: GeminiQuotaKind = kinds.size === 1
    ? [...kinds][0]
    : "UNKNOWN";
  const classificationReason = quotaKind === "UNKNOWN"
    ? !foundQuotaFailure
      ? "MISSING_QUOTA_FAILURE"
      : quotaSignals.length === 0
      ? "MISSING_QUOTA_SIGNAL"
      : kinds.size > 1
      ? "AMBIGUOUS_QUOTA_KIND"
      : "UNRECOGNIZED_QUOTA_SIGNAL"
    : undefined;
  return {
    quotaScope: quotaScopeForSignals(quotaSignals, kinds),
    quotaKind,
    ...(classificationReason ? { classificationReason } : {}),
    quotaIds,
    retryInfoMs,
  };
}

interface RetryHint {
  cooldownMs: number;
  source: GeminiRetryHintSource;
}

function serverRetryHint(
  response: Response,
  retryInfoMs: number | undefined,
  nowMs: number,
): RetryHint | null {
  const headerMs = retryAfterMs(response, nowMs);
  if (headerMs !== undefined && retryInfoMs !== undefined) {
    if (headerMs === retryInfoMs) {
      return {
        cooldownMs: headerMs,
        source: "RETRY_AFTER_AND_RETRY_INFO",
      };
    }
    return headerMs > retryInfoMs
      ? { cooldownMs: headerMs, source: "RETRY_AFTER" }
      : { cooldownMs: retryInfoMs, source: "RETRY_INFO" };
  }
  if (headerMs !== undefined) {
    return { cooldownMs: headerMs, source: "RETRY_AFTER" };
  }
  return retryInfoMs === undefined
    ? null
    : { cooldownMs: retryInfoMs, source: "RETRY_INFO" };
}

function effectiveCooldown(
  metadata: GeminiRateLimitMetadata,
  response: Response,
  failedAt: number,
  unknownRateLimitStrikes: number,
): RetryHint & { retryAt: string } {
  const serverHint = serverRetryHint(response, metadata.retryInfoMs, failedAt);
  let policyHint: RetryHint;
  if (metadata.quotaKind === "RPD") {
    policyHint = {
      cooldownMs: nextLosAngelesMidnightMs(failedAt) - failedAt,
      source: "PACIFIC_MIDNIGHT",
    };
  } else if (
    metadata.quotaKind === "RPM" || metadata.quotaKind === "TPM"
  ) {
    policyHint = serverHint ?? {
      cooldownMs: 60_000,
      source: "MINUTE_DEFAULT",
    };
  } else {
    policyHint = {
      cooldownMs: ADAPTIVE_COOLDOWN_MS[
        Math.min(
          unknownRateLimitStrikes - 1,
          ADAPTIVE_COOLDOWN_MS.length - 1,
        )
      ],
      source: "ADAPTIVE_BACKOFF",
    };
  }

  const selected = serverHint && serverHint.cooldownMs > policyHint.cooldownMs
    ? serverHint
    : policyHint;
  return {
    ...selected,
    retryAt: new Date(failedAt + selected.cooldownMs).toISOString(),
  };
}

function quotaEventDetails(
  state: Pick<
    GeminiApiKeyCooldownState,
    | "quotaScope"
    | "quotaKind"
    | "classificationReason"
    | "quotaIds"
    | "cooldownMs"
    | "retryAt"
    | "retryHintSource"
  >,
): Record<string, unknown> {
  return {
    quotaScope: state.quotaScope,
    quotaKind: state.quotaKind,
    ...(state.quotaKind === "UNKNOWN" && state.classificationReason
      ? { classificationReason: state.classificationReason }
      : {}),
    quotaIds: [...state.quotaIds],
    cooldownMs: state.cooldownMs,
    retryAt: state.retryAt,
    retryHintSource: state.retryHintSource,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function usage(payload: unknown): ProviderUsage | undefined {
  const metadata = record(record(payload)?.usageMetadata);
  if (!metadata) return undefined;
  const inputTokens = finiteNumber(metadata.promptTokenCount);
  const outputTokens = finiteNumber(metadata.candidatesTokenCount);
  return inputTokens === undefined && outputTokens === undefined
    ? undefined
    : { inputTokens, outputTokens };
}

function contentBlocked(payload: unknown): boolean {
  const root = record(payload);
  const promptFeedback = record(root?.promptFeedback);
  if (typeof promptFeedback?.blockReason === "string") return true;
  const candidates = root?.candidates;
  if (!Array.isArray(candidates)) return false;
  return candidates.some((candidate) => {
    const finishReason = record(candidate)?.finishReason;
    return finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT";
  });
}

function responseText(payload: unknown): string | null {
  const candidates = record(payload)?.candidates;
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    const parts = record(record(candidate)?.content)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const text = record(part)?.text;
      if (typeof text === "string" && text.trim()) return text;
    }
  }
  return null;
}

export function createGeminiProvider(
  config: GeminiProviderConfig,
  dependencies: GeminiProviderDependencies = {},
): PlaceAiProvider {
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const state = dependencies.state ?? sharedGeminiApiKeyState;
  const apiKeys = [config.apiKey, ...(config.fallbackApiKeys ?? [])];

  function stateKey(apiKeyIndex: number, model: string): string {
    return `${apiKeys[apiKeyIndex]}\u0000${model}`;
  }

  function serviceStateKey(model: string): string {
    return `${apiKeys.join("\u0000")}\u0001${model}`;
  }

  function credentialRole(apiKeyIndex: number): GeminiCredentialRole {
    return apiKeyIndex === 0 ? "Primary" : "Fallback";
  }

  function credentialOrder(model: string, currentTime = now()): number[] {
    return apiKeys
      .map((_, apiKeyIndex) => apiKeyIndex)
      .filter((apiKeyIndex) =>
        (state.cooldowns.get(stateKey(apiKeyIndex, model))?.cooldownUntilMs ??
          0) <=
          currentTime
      );
  }

  function nextEligibleAttempt(
    model: string,
    attemptedApiKeys: ReadonlySet<number>,
  ): GeminiCredentialAttempt | null {
    const startedAtMs = now();
    for (let apiKeyIndex = 0; apiKeyIndex < apiKeys.length; apiKeyIndex += 1) {
      if (attemptedApiKeys.has(apiKeyIndex)) continue;
      const cooldown = state.cooldowns.get(stateKey(apiKeyIndex, model));
      if (cooldown && cooldown.cooldownUntilMs > startedAtMs) continue;

      const fallbackTransitionGenerations = new Map<number, number>();
      for (
        let failedApiKeyIndex = 0;
        failedApiKeyIndex < apiKeyIndex;
        failedApiKeyIndex += 1
      ) {
        const failedState = state.cooldowns.get(
          stateKey(failedApiKeyIndex, model),
        );
        if (failedState?.fallbackActivationPending) {
          fallbackTransitionGenerations.set(
            failedApiKeyIndex,
            failedState.transitionGeneration,
          );
        }
      }

      return {
        apiKeyIndex,
        startedAtMs,
        cooldownGeneration: cooldown?.generation ?? null,
        fallbackTransitionGenerations,
        authIncidentId: state.authIncidents.get(
          stateKey(apiKeyIndex, model),
        )?.incidentId ?? null,
        serviceIncidentId: state.unavailableServices.get(
          serviceStateKey(model),
        )?.incidentId ?? null,
      };
    }
    return null;
  }

  function markServiceUnavailable(
    operation: AiOperation,
    model: string,
    unavailableAtMs: number,
    triggeringApiKeyIndex: number,
  ): void {
    const availabilityKey = serviceStateKey(model);
    if (
      state.unavailableServices.has(availabilityKey) ||
      credentialOrder(model, unavailableAtMs).length > 0
    ) return;

    const cooling = apiKeys.flatMap((_, apiKeyIndex) => {
      const cooldown = state.cooldowns.get(stateKey(apiKeyIndex, model));
      return cooldown ? [{ apiKeyIndex, cooldown }] : [];
    });
    const nextRetry = cooling.reduce((earliest, candidate) =>
      candidate.cooldown.cooldownUntilMs < earliest.cooldown.cooldownUntilMs
        ? candidate
        : earliest
    );
    const unavailableState: GeminiServiceUnavailableState = {
      incidentId: state.nextServiceIncidentId,
      unavailableAt: new Date(unavailableAtMs).toISOString(),
      operation,
      model,
      credentialRole: credentialRole(nextRetry.apiKeyIndex),
      credentialSlot: nextRetry.apiKeyIndex + 1,
      quotaScope: nextRetry.cooldown.quotaScope,
      quotaKind: nextRetry.cooldown.quotaKind,
      ...(nextRetry.cooldown.classificationReason
        ? { classificationReason: nextRetry.cooldown.classificationReason }
        : {}),
      quotaIds: [...nextRetry.cooldown.quotaIds],
      cooldownMs: Math.max(
        0,
        nextRetry.cooldown.cooldownUntilMs - unavailableAtMs,
      ),
      retryAt: nextRetry.cooldown.retryAt,
      retryHintSource: nextRetry.cooldown.retryHintSource,
    };
    state.nextServiceIncidentId += 1;
    state.unavailableServices.set(availabilityKey, unavailableState);
    dependencies.log?.("ai_gemini_api_keys_unavailable", {
      operation,
      model,
      credentialRole: unavailableState.credentialRole,
      credentialSlot: unavailableState.credentialSlot,
      triggeringCredentialRole: credentialRole(triggeringApiKeyIndex),
      triggeringCredentialSlot: triggeringApiKeyIndex + 1,
      credentialCount: apiKeys.length,
      incidentId: unavailableState.incidentId,
      unavailableAt: unavailableState.unavailableAt,
      ...quotaEventDetails(unavailableState),
    });
  }

  function recordSuccessfulCredential(
    operation: AiOperation,
    model: string,
    attempt: GeminiCredentialAttempt,
  ): void {
    const apiKeyIndex = attempt.apiKeyIndex;
    const successfulStateKey = stateKey(apiKeyIndex, model);
    const recoveredState = state.cooldowns.get(successfulStateKey);
    const credentialStateUnchanged =
      (recoveredState?.generation ?? null) === attempt.cooldownGeneration;
    for (
      let failedApiKeyIndex = 0;
      failedApiKeyIndex < apiKeyIndex;
      failedApiKeyIndex += 1
    ) {
      const failedStateKey = stateKey(failedApiKeyIndex, model);
      const failedState = state.cooldowns.get(failedStateKey);
      if (
        !credentialStateUnchanged ||
        !failedState?.fallbackActivationPending ||
        attempt.fallbackTransitionGenerations.get(failedApiKeyIndex) !==
          failedState.transitionGeneration
      ) continue;
      dependencies.log?.("ai_gemini_api_key_fallback_activated", {
        operation: failedState.operation,
        activatedOperation: operation,
        model,
        fromCredentialRole: failedState.credentialRole,
        fromCredentialSlot: failedState.credentialSlot,
        toCredentialRole: credentialRole(apiKeyIndex),
        toCredentialSlot: apiKeyIndex + 1,
        ...quotaEventDetails(failedState),
      });
      failedState.fallbackActivationPending = false;
      failedState.fallbackActivated = true;
    }

    const clearsObservedCooldown = credentialStateUnchanged &&
      recoveredState !== undefined;
    if (
      apiKeyIndex === 0 && clearsObservedCooldown &&
      recoveredState.fallbackActivated
    ) {
      dependencies.log?.("ai_gemini_primary_recovered", {
        operation,
        cooldownOperation: recoveredState.operation,
        model,
        credentialRole: "Primary",
        credentialSlot: 1,
        recoveredAt: new Date(now()).toISOString(),
        ...quotaEventDetails(recoveredState),
      });
    }
    if (clearsObservedCooldown) state.cooldowns.delete(successfulStateKey);

    const authIncident = state.authIncidents.get(successfulStateKey);
    if (
      authIncident && attempt.authIncidentId === authIncident.incidentId
    ) state.authIncidents.delete(successfulStateKey);

    const availabilityKey = serviceStateKey(model);
    const unavailableState = state.unavailableServices.get(availabilityKey);
    if (
      credentialStateUnchanged && unavailableState &&
      attempt.serviceIncidentId === unavailableState.incidentId
    ) {
      dependencies.log?.("ai_gemini_service_recovered", {
        operation,
        unavailableOperation: unavailableState.operation,
        model,
        credentialRole: credentialRole(apiKeyIndex),
        credentialSlot: apiKeyIndex + 1,
        incidentId: unavailableState.incidentId,
        unavailableAt: unavailableState.unavailableAt,
        recoveredAt: new Date(now()).toISOString(),
        ...quotaEventDetails(unavailableState),
      });
      state.unavailableServices.delete(availabilityKey);
    }
  }

  async function generate(
    operation: AiOperation,
    model: string,
    prompt: string,
    schema: unknown,
    temperature?: number,
  ): Promise<{
    payload: unknown;
    text: string;
    attempt: GeminiCredentialAttempt;
  }> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${
      encodeURIComponent(model)
    }:generateContent`;
    const attemptedApiKeys = new Set<number>();
    let lastRateLimitError: AiProviderError | null = null;
    let lastAttemptedApiKeyIndex: number | null = null;

    while (true) {
      const attempt = nextEligibleAttempt(model, attemptedApiKeys);
      if (!attempt) {
        markServiceUnavailable(
          operation,
          model,
          now(),
          lastAttemptedApiKeyIndex ?? apiKeys.length - 1,
        );
        if (lastRateLimitError) throw lastRateLimitError;
        throw aiHttpError("gemini", operation, model, 429);
      }
      const apiKeyIndex = attempt.apiKeyIndex;
      attemptedApiKeys.add(apiKeyIndex);
      lastAttemptedApiKeyIndex = apiKeyIndex;
      let response: Response;
      let payload: unknown | null;
      let errorBodyStatus: AiErrorBodyStatus | undefined;
      try {
        const result = await fetchJsonWithTimeout(
          request,
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKeys[apiKeyIndex],
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                ...(temperature === undefined ? {} : { temperature }),
                responseMimeType: "application/json",
                responseJsonSchema: schema,
              },
            }),
          },
          config.timeoutMs,
        );
        response = result.response;
        payload = result.payload;
        errorBodyStatus = result.errorBodyStatus;
      } catch (cause) {
        if (cause instanceof AiRequestTimeoutError) {
          throw new AiProviderError("gemini", operation, "TIMEOUT", {
            model,
            retryable: true,
            cause,
          });
        }
        if (cause instanceof AiResponseJsonError) {
          throw new AiProviderError(
            "gemini",
            operation,
            "INVALID_RESPONSE",
            { model, retryable: true, cause },
          );
        }
        throw new AiProviderError("gemini", operation, "NETWORK", {
          model,
          retryable: true,
          cause,
        });
      }

      if (!response.ok) {
        const error = aiHttpError(
          "gemini",
          operation,
          model,
          response.status,
        );
        if (response.status === 401 || response.status === 403) {
          const authStateKey = stateKey(apiKeyIndex, model);
          if (!state.authIncidents.has(authStateKey)) {
            const incidentId = state.nextAuthIncidentId;
            state.nextAuthIncidentId += 1;
            state.authIncidents.set(authStateKey, { incidentId });
            dependencies.log?.("ai_gemini_api_key_auth_failed", {
              operation,
              model,
              credentialRole: credentialRole(apiKeyIndex),
              credentialSlot: apiKeyIndex + 1,
              status: response.status,
              incidentId,
            });
          }
        }
        if (response.status !== 429) throw error;

        lastRateLimitError = error;
        const failedAt = now();
        const metadata = rateLimitMetadata(payload, errorBodyStatus);
        const keyState = state.cooldowns.get(stateKey(apiKeyIndex, model));
        const unknownRateLimitStrikes = metadata.quotaKind === "UNKNOWN"
          ? (keyState?.unknownRateLimitStrikes ?? 0) + 1
          : keyState?.unknownRateLimitStrikes ?? 0;
        const cooldown = effectiveCooldown(
          metadata,
          response,
          failedAt,
          unknownRateLimitStrikes,
        );
        const candidateCooldownUntilMs = failedAt + cooldown.cooldownMs;
        const retainedCooldown = keyState !== undefined &&
            keyState.cooldownUntilMs > candidateCooldownUntilMs
          ? keyState
          : null;
        const effectiveCooldownUntilMs = retainedCooldown
          ? retainedCooldown.cooldownUntilMs
          : candidateCooldownUntilMs;
        const effectiveQuota = retainedCooldown ?? metadata;
        const cooldownState: GeminiApiKeyCooldownState = {
          generation: state.nextCooldownGeneration,
          transitionGeneration: keyState?.transitionGeneration ??
            state.nextCooldownGeneration,
          cooldownUntilMs: effectiveCooldownUntilMs,
          unknownRateLimitStrikes,
          quotaScope: effectiveQuota.quotaScope,
          quotaKind: effectiveQuota.quotaKind,
          ...(effectiveQuota.classificationReason
            ? { classificationReason: effectiveQuota.classificationReason }
            : {}),
          quotaIds: [...effectiveQuota.quotaIds],
          retryAt: new Date(effectiveCooldownUntilMs).toISOString(),
          retryHintSource: retainedCooldown?.retryHintSource ?? cooldown.source,
          cooldownMs: Math.max(0, effectiveCooldownUntilMs - failedAt),
          model,
          operation: retainedCooldown?.operation ?? operation,
          credentialRole: credentialRole(apiKeyIndex),
          credentialSlot: apiKeyIndex + 1,
          fallbackActivationPending: keyState?.fallbackActivationPending ??
            apiKeyIndex < apiKeys.length - 1,
          fallbackActivated: keyState?.fallbackActivated ?? false,
        };
        state.nextCooldownGeneration += 1;
        state.cooldowns.set(stateKey(apiKeyIndex, model), cooldownState);
        dependencies.log?.("ai_gemini_api_key_cooldown_started", {
          operation,
          model,
          credentialRole: cooldownState.credentialRole,
          credentialSlot: cooldownState.credentialSlot,
          ...quotaEventDetails(cooldownState),
        });
        continue;
      }

      const text = responseText(payload);
      const blocked = contentBlocked(payload);
      if (!text) {
        throw new AiProviderError(
          "gemini",
          operation,
          blocked ? "CONTENT_BLOCKED" : "INVALID_RESPONSE",
          {
            status: response.status,
            model,
            retryable: !blocked,
          },
        );
      }

      return { payload, text, attempt };
    }
  }

  return {
    name: "gemini",
    async extractPlaces(
      caption: string,
    ): Promise<ProviderCallResult<PlaceGuess[]>> {
      const model = config.extractionModel;
      const response = await generate(
        "PLACE_EXTRACTION",
        model,
        buildPlaceExtractionPrompt(caption),
        PLACE_EXTRACTION_JSON_SCHEMA,
      );
      try {
        const data = parsePlaceExtractionPayload(
          parseJsonPayload(response.text),
        );
        recordSuccessfulCredential(
          "PLACE_EXTRACTION",
          model,
          response.attempt,
        );
        return {
          data,
          model,
          usage: usage(response.payload),
        };
      } catch (cause) {
        if (!(cause instanceof AiContractError)) throw cause;
        throw new AiProviderError(
          "gemini",
          "PLACE_EXTRACTION",
          "INVALID_RESPONSE",
          { model, retryable: true, cause },
        );
      }
    },
    async judgeKakaoCandidates(
      caption: string,
      items: KakaoCandidateReviewItem[],
    ): Promise<ProviderCallResult<AiCandidateJudgment[]>> {
      const model = config.judgmentModel;
      const response = await generate(
        "KAKAO_CANDIDATE_JUDGMENT",
        model,
        buildCandidateJudgmentPrompt(caption, items),
        CANDIDATE_JUDGMENT_JSON_SCHEMA,
        0,
      );
      try {
        const data = parseCandidateJudgmentPayload(
          parseJsonPayload(response.text),
          items.map((item) => item.guessIndex),
        );
        recordSuccessfulCredential(
          "KAKAO_CANDIDATE_JUDGMENT",
          model,
          response.attempt,
        );
        return {
          data,
          model,
          usage: usage(response.payload),
        };
      } catch (cause) {
        if (!(cause instanceof AiContractError)) throw cause;
        throw new AiProviderError(
          "gemini",
          "KAKAO_CANDIDATE_JUDGMENT",
          "INVALID_RESPONSE",
          { model, retryable: true, cause },
        );
      }
    },
  };
}
