// Gemini API 키의 순서와 429 쿨다운, 예비 키 전환, 복구 이벤트를 관리한다.
// v10 장소 추출(providers/gemini.ts)과 v11 원본 분석(source_gemini.ts)이 같은 키 상태를 함께 쓴다.
import { aiHttpError, AiProviderError } from "./errors.ts";
import type { AiErrorBodyStatus } from "./http.ts";
import type { AiLog } from "./provider.ts";
import type { AiOperation } from "./types.ts";

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

export interface GeminiServiceUnavailableState {
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

export interface GeminiApiKeyAuthIncidentState {
  incidentId: number;
}

export interface GeminiCredentialAttempt {
  apiKeyIndex: number;
  startedAtMs: number;
  cooldownGeneration: number | null;
  fallbackTransitionGenerations: Map<number, number>;
  authIncidentId: number | null;
  serviceIncidentId: number | null;
}

/** 일시적 오류(503 등)로 잠시 건너뛰는 key. 같은 사건은 복구될 때까지 같은 번호를 쓴다. */
export interface GeminiOverloadState {
  incidentId: number;
  cooldownUntilMs: number;
}

/** 선불 잔액이 떨어져 잠시 건너뛰는 key. 같은 사건은 다시 성공할 때까지 같은 번호를 쓴다. */
export interface GeminiBillingState {
  incidentId: number;
  cooldownUntilMs: number;
}

export interface GeminiApiKeyStateStore {
  cooldowns: Map<string, GeminiApiKeyCooldownState>;
  unavailableServices: Map<string, GeminiServiceUnavailableState>;
  authIncidents: Map<string, GeminiApiKeyAuthIncidentState>;
  nextCooldownGeneration: number;
  nextServiceIncidentId: number;
  nextAuthIncidentId: number;
  overloads: Map<string, GeminiOverloadState>;
  nextOverloadIncidentId: number;
  billingDepleted: Map<string, GeminiBillingState>;
  nextBillingIncidentId: number;
}

const sharedGeminiApiKeyState: GeminiApiKeyStateStore = {
  cooldowns: new Map(),
  unavailableServices: new Map(),
  authIncidents: new Map(),
  nextCooldownGeneration: 1,
  nextServiceIncidentId: 1,
  nextAuthIncidentId: 1,
  overloads: new Map(),
  nextOverloadIncidentId: 1,
  billingDepleted: new Map(),
  nextBillingIncidentId: 1,
};
const ADAPTIVE_COOLDOWN_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
// 선불 잔액이 떨어진 key는 충전될 때까지 실패하므로 이 시간 동안 부르지 않고, 지나면 한 번 다시 써 본다.
const BILLING_COOLDOWN_MS = 10 * 60_000;
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
    overloads: new Map(),
    nextOverloadIncidentId: 1,
    billingDepleted: new Map(),
    nextBillingIncidentId: 1,
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

export function retryAfterMs(
  response: Response,
  nowMs: number,
): number | undefined {
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

// 선불 잔액이 떨어지면 Gemini는 402를 주고, 같은 문구를 담은 429를 준 사례도 있다.
function isBillingDepleted(failure: GeminiHttpStatusError): boolean {
  if (failure.status === 402) return true;
  if (failure.status !== 429) return false;
  const message = record(record(failure.payload)?.error)?.message;
  return typeof message === "string" &&
    /prepayment credits are depleted/i.test(message);
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

/**
 * Gemini가 성공이 아닌 HTTP 상태로 답했다는 것을 키 관리에 알린다.
 * 429 본문은 쿼터 종류를 가리는 데만 쓰고 로그나 알림에 원문을 남기지 않는다.
 */
export class GeminiHttpStatusError extends Error {
  constructor(
    readonly response: Response,
    readonly payload: unknown | null = null,
    readonly errorBodyStatus?: AiErrorBodyStatus,
    message = `gemini_http_${response.status}`,
  ) {
    super(message);
    this.name = "GeminiHttpStatusError";
  }

  get status(): number {
    return this.response.status;
  }
}

/**
 * 일시적 오류에서 key를 넘기는 규칙. 뒤에 쓸 key가 있으면 같은 key로 재시도하지 않고 바로 넘기고,
 * 그 key는 cooldownMs 동안 다른 key보다 뒤로 미룬다. 넘기지 않으면 v10처럼 429에서만 key를 바꾼다.
 */
export interface GeminiOverloadPolicy {
  cooldownMs: number;
  isOverload(error: unknown): boolean;
}

export interface GeminiCredentialPoolDependencies {
  log?: AiLog;
  now?: () => number;
  state?: GeminiApiKeyStateStore;
  overload?: GeminiOverloadPolicy;
}

/** call에 넘기는 시도 정보. 마지막 key일 때만 같은 key로 재시도하게 할 수 있다. */
export interface GeminiCredentialCall {
  credentialSlot: number;
  isLastCredential: boolean;
}

export interface GeminiCredentialPool {
  readonly credentialCount: number;
  /**
   * 쓸 수 있는 키를 순서대로 골라 call을 실행한다. call이 429를 GeminiHttpStatusError로
   * 알리면 그 키를 쿨다운하고 다음 키로 다시 부르며, 401과 403은 인증 사고로 기록하고
   * 그대로 실패시킨다. 402나 선불 잔액 소진 문구의 429는 그 키를 잠시 건너뛰고 다음 키로
   * 부른다. 그 밖의 오류는 키를 바꾸지 않고 그대로 던진다.
   */
  run<T>(
    operation: AiOperation,
    model: string,
    call: (apiKey: string, attempt: GeminiCredentialCall) => Promise<T>,
  ): Promise<T>;
}

export function createGeminiCredentialPool(
  apiKeys: readonly string[],
  dependencies: GeminiCredentialPoolDependencies = {},
): GeminiCredentialPool {
  const now = dependencies.now ?? Date.now;
  const state = dependencies.state ?? sharedGeminiApiKeyState;

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
    return eligibleAttempt(model, attemptedApiKeys, true) ??
      eligibleAttempt(model, attemptedApiKeys, false);
  }

  function eligibleAttempt(
    model: string,
    attemptedApiKeys: ReadonlySet<number>,
    skipOverloaded: boolean,
  ): GeminiCredentialAttempt | null {
    const startedAtMs = now();
    for (let apiKeyIndex = 0; apiKeyIndex < apiKeys.length; apiKeyIndex += 1) {
      if (attemptedApiKeys.has(apiKeyIndex)) continue;
      const cooldown = state.cooldowns.get(stateKey(apiKeyIndex, model));
      if (cooldown && cooldown.cooldownUntilMs > startedAtMs) continue;
      if (
        (state.billingDepleted.get(stateKey(apiKeyIndex, model))
          ?.cooldownUntilMs ?? 0) > startedAtMs
      ) continue;
      if (
        skipOverloaded &&
        (state.overloads.get(stateKey(apiKeyIndex, model))?.cooldownUntilMs ??
            0) > startedAtMs
      ) continue;

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

  function recordAuthFailure(
    operation: AiOperation,
    model: string,
    apiKeyIndex: number,
    status: number,
  ): void {
    const authStateKey = stateKey(apiKeyIndex, model);
    if (state.authIncidents.has(authStateKey)) return;
    const incidentId = state.nextAuthIncidentId;
    state.nextAuthIncidentId += 1;
    state.authIncidents.set(authStateKey, { incidentId });
    dependencies.log?.("ai_gemini_api_key_auth_failed", {
      operation,
      model,
      credentialRole: credentialRole(apiKeyIndex),
      credentialSlot: apiKeyIndex + 1,
      status,
      incidentId,
    });
  }

  function startCooldown(
    operation: AiOperation,
    model: string,
    apiKeyIndex: number,
    failure: GeminiHttpStatusError,
  ): void {
    const failedAt = now();
    const metadata = rateLimitMetadata(
      failure.payload,
      failure.errorBodyStatus,
    );
    const keyState = state.cooldowns.get(stateKey(apiKeyIndex, model));
    const unknownRateLimitStrikes = metadata.quotaKind === "UNKNOWN"
      ? (keyState?.unknownRateLimitStrikes ?? 0) + 1
      : keyState?.unknownRateLimitStrikes ?? 0;
    const cooldown = effectiveCooldown(
      metadata,
      failure.response,
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
  }

  function startOverloadCooldown(
    operation: AiOperation,
    model: string,
    apiKeyIndex: number,
    cause: unknown,
    policy: GeminiOverloadPolicy,
    attemptedApiKeys: ReadonlySet<number>,
  ): void {
    const overloadStateKey = stateKey(apiKeyIndex, model);
    const existing = state.overloads.get(overloadStateKey);
    const incidentId = existing?.incidentId ?? state.nextOverloadIncidentId++;
    const cooldownUntilMs = now() + policy.cooldownMs;
    state.overloads.set(overloadStateKey, { incidentId, cooldownUntilMs });
    const next = nextEligibleAttempt(model, attemptedApiKeys);
    dependencies.log?.("ai_gemini_api_key_overloaded", {
      operation,
      model,
      credentialRole: credentialRole(apiKeyIndex),
      credentialSlot: apiKeyIndex + 1,
      ...(next
        ? {
          toCredentialRole: credentialRole(next.apiKeyIndex),
          toCredentialSlot: next.apiKeyIndex + 1,
        }
        : {}),
      credentialCount: apiKeys.length,
      ...(cause instanceof GeminiHttpStatusError
        ? { status: cause.status }
        : {}),
      incidentId,
      cooldownMs: policy.cooldownMs,
      retryAt: new Date(cooldownUntilMs).toISOString(),
    });
  }

  function startBillingCooldown(
    operation: AiOperation,
    model: string,
    apiKeyIndex: number,
    status: number,
    attemptedApiKeys: ReadonlySet<number>,
  ): void {
    const billingStateKey = stateKey(apiKeyIndex, model);
    const existing = state.billingDepleted.get(billingStateKey);
    const incidentId = existing?.incidentId ?? state.nextBillingIncidentId++;
    const cooldownUntilMs = now() + BILLING_COOLDOWN_MS;
    state.billingDepleted.set(billingStateKey, { incidentId, cooldownUntilMs });
    const next = nextEligibleAttempt(model, attemptedApiKeys);
    dependencies.log?.("ai_gemini_api_key_billing_depleted", {
      operation,
      model,
      credentialRole: credentialRole(apiKeyIndex),
      credentialSlot: apiKeyIndex + 1,
      ...(next
        ? {
          toCredentialRole: credentialRole(next.apiKeyIndex),
          toCredentialSlot: next.apiKeyIndex + 1,
        }
        : {}),
      credentialCount: apiKeys.length,
      status,
      incidentId,
      cooldownMs: BILLING_COOLDOWN_MS,
      retryAt: new Date(cooldownUntilMs).toISOString(),
    });
  }

  function recordBillingRecovery(
    operation: AiOperation,
    model: string,
    apiKeyIndex: number,
  ): void {
    const billingStateKey = stateKey(apiKeyIndex, model);
    const billing = state.billingDepleted.get(billingStateKey);
    if (!billing) return;
    state.billingDepleted.delete(billingStateKey);
    dependencies.log?.("ai_gemini_api_key_billing_recovered", {
      operation,
      model,
      credentialRole: credentialRole(apiKeyIndex),
      credentialSlot: apiKeyIndex + 1,
      incidentId: billing.incidentId,
      recoveredAt: new Date(now()).toISOString(),
    });
  }

  function recordOverloadRecovery(
    operation: AiOperation,
    model: string,
    apiKeyIndex: number,
  ): void {
    const overloadStateKey = stateKey(apiKeyIndex, model);
    const overload = state.overloads.get(overloadStateKey);
    if (!overload) return;
    state.overloads.delete(overloadStateKey);
    dependencies.log?.("ai_gemini_api_key_overload_recovered", {
      operation,
      model,
      credentialRole: credentialRole(apiKeyIndex),
      credentialSlot: apiKeyIndex + 1,
      incidentId: overload.incidentId,
      recoveredAt: new Date(now()).toISOString(),
    });
  }

  return {
    credentialCount: apiKeys.length,
    async run<T>(
      operation: AiOperation,
      model: string,
      call: (apiKey: string, attempt: GeminiCredentialCall) => Promise<T>,
    ): Promise<T> {
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

        const isLastCredential =
          nextEligibleAttempt(model, attemptedApiKeys) === null;

        let value: T;
        try {
          value = await call(apiKeys[apiKeyIndex], {
            credentialSlot: apiKeyIndex + 1,
            isLastCredential,
          });
        } catch (cause) {
          const overload = dependencies.overload;
          if (overload && !isLastCredential && overload.isOverload(cause)) {
            startOverloadCooldown(
              operation,
              model,
              apiKeyIndex,
              cause,
              overload,
              attemptedApiKeys,
            );
            continue;
          }
          if (!(cause instanceof GeminiHttpStatusError)) throw cause;
          if (isBillingDepleted(cause)) {
            lastRateLimitError = new AiProviderError(
              "gemini",
              operation,
              "QUOTA_EXCEEDED",
              { status: cause.status, model, retryable: true },
            );
            startBillingCooldown(
              operation,
              model,
              apiKeyIndex,
              cause.status,
              attemptedApiKeys,
            );
            continue;
          }
          const error = aiHttpError("gemini", operation, model, cause.status);
          if (cause.status === 401 || cause.status === 403) {
            recordAuthFailure(operation, model, apiKeyIndex, cause.status);
          }
          if (cause.status !== 429) throw error;
          lastRateLimitError = error;
          startCooldown(operation, model, apiKeyIndex, cause);
          continue;
        }
        recordSuccessfulCredential(operation, model, attempt);
        recordOverloadRecovery(operation, model, apiKeyIndex);
        recordBillingRecovery(operation, model, apiKeyIndex);
        return value;
      }
    },
  };
}
