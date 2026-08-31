import type { AiLog } from "./provider.ts";

export type GeminiRuntimeAlertSeverity =
  | "WARNING"
  | "CRITICAL"
  | "RECOVERED";

export type GeminiRuntimeAlertKind =
  | "PRIMARY_FALLBACK_ACTIVATED"
  | "UNKNOWN_RATE_LIMIT"
  | "PRIMARY_RECOVERED"
  | "SERVICE_RECOVERED"
  | "API_KEYS_UNAVAILABLE"
  | "AUTH_FAILED";

export interface RuntimeAlertDedupeStore {
  /** Atomically reserves a transition. False means it was already reserved. */
  claim(key: string): boolean;
  /** Makes a failed delivery eligible for a later retry. */
  release(key: string): void;
}

export interface RuntimeAlertTransitionQueue {
  /** Runs transitions for one model scope in their invocation order. */
  run<T>(scope: string, task: () => Promise<T>): Promise<T>;
}

export interface GeminiRuntimeDiscordAlertDependencies {
  webhookUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Injected in tests; production uses a regular timer. */
  sleep?: (delayMs: number) => Promise<void>;
  /** Injected in tests; production uses the regular timer functions. */
  scheduleTimeout?: (
    callback: () => void,
    delayMs: number,
  ) => unknown;
  clearScheduledTimeout?: (timer: unknown) => void;
  dedupe?: RuntimeAlertDedupeStore;
  transitionQueue?: RuntimeAlertTransitionQueue;
  log?: AiLog;
}

export type GeminiRuntimeAlertOutcome = {
  status: "sent" | "deduplicated" | "delivery_failed" | "not_configured";
  severity: GeminiRuntimeAlertSeverity;
  kind: GeminiRuntimeAlertKind;
};

type JsonRecord = Record<string, unknown>;
type DiscordField = { name: string; value: string; inline?: boolean };

interface RuntimeAlert {
  severity: GeminiRuntimeAlertSeverity;
  kind: GeminiRuntimeAlertKind;
  title: string;
  description: string;
  fields: DiscordField[];
  dedupeKey: string;
  scope: string;
}

const FALLBACK_ACTIVATED_EVENTS = new Set([
  "ai_gemini_api_key_fallback_activated",
]);
const API_KEYS_UNAVAILABLE_EVENTS = new Set([
  "ai_gemini_api_keys_unavailable",
  "ai_gemini_api_keys_exhausted",
]);
// These are protocol codes emitted by the Gemini provider. Do not forward
// arbitrary diagnostic text to Discord: callers may otherwise accidentally
// place a prompt or an upstream response body in an alert field.
const SAFE_UNKNOWN_CLASSIFICATION_REASONS = new Set([
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
const SAFE_RETRY_HINT_SOURCES = new Set([
  "RETRY_AFTER",
  "RETRY_INFO",
  "RETRY_AFTER_AND_RETRY_INFO",
  "PACIFIC_MIDNIGHT",
  "MINUTE_DEFAULT",
  "ADAPTIVE_BACKOFF",
]);
const UNSAFE_CLASSIFICATION_REASON = "UNSAFE_CLASSIFICATION_REASON";
const UNSAFE_RETRY_HINT_SOURCE = "UNSAFE_RETRY_HINT_SOURCE";

const COLORS: Record<GeminiRuntimeAlertSeverity, number> = {
  WARNING: 0xF59E0B,
  CRITICAL: 0xDC2626,
  RECOVERED: 0x22C55E,
};

const ICONS: Record<GeminiRuntimeAlertSeverity, string> = {
  WARNING: "⚠️",
  CRITICAL: "🚨",
  RECOVERED: "✅",
};

const DISCORD_DELIVERY_ATTEMPTS = 3;
const FALLBACK_RETRY_DELAYS_MS = [250, 1_000] as const;
// Keeps one waitUntil task bounded even if Discord returns a very long delay.
const MAX_RETRY_AFTER_MS = 15_000;
// Bounds an individual network attempt as well as the retry delays.
const DISCORD_DELIVERY_TIMEOUT_MS = 5_000;

class InMemoryRuntimeAlertDedupe implements RuntimeAlertDedupeStore {
  readonly #claimed = new Set<string>();

  claim(key: string): boolean {
    if (this.#claimed.has(key)) return false;
    this.#claimed.add(key);
    return true;
  }

  release(key: string): void {
    this.#claimed.delete(key);
  }
}

class InMemoryRuntimeAlertTransitionQueue
  implements RuntimeAlertTransitionQueue {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(scope: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(scope, tail);

    return (async () => {
      try {
        await previous.catch(() => undefined);
        return await task();
      } finally {
        release();
        if (this.#tails.get(scope) === tail) this.#tails.delete(scope);
      }
    })();
  }
}

const sharedDedupe = new InMemoryRuntimeAlertDedupe();
const sharedTransitionQueue = new InMemoryRuntimeAlertTransitionQueue();

export function createInMemoryRuntimeAlertDedupe(): RuntimeAlertDedupeStore {
  return new InMemoryRuntimeAlertDedupe();
}

export function createInMemoryRuntimeAlertTransitionQueue(): RuntimeAlertTransitionQueue {
  return new InMemoryRuntimeAlertTransitionQueue();
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function finiteNumber(value: unknown): number | null {
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized === "") return null;
  const parsed = typeof normalized === "number"
    ? normalized
    : typeof normalized === "string"
    ? Number(normalized)
    : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function firstValue(details: JsonRecord, names: readonly string[]): unknown {
  for (const name of names) {
    if (details[name] !== undefined && details[name] !== null) {
      return details[name];
    }
  }
  return undefined;
}

function firstString(
  details: JsonRecord,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = stringValue(details[name]);
    if (value) return value;
  }
  return null;
}

function truncate(value: string, maxLength = 1_024): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeText(value: string, maxLength = 1_024): string {
  return truncate(
    value
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]")
      .replace(/\b(?:sk|key)-[0-9A-Za-z_-]{16,}\b/gi, "[REDACTED]")
      .replace(/\s+/g, " ")
      .trim(),
    maxLength,
  );
}

function keyPart(value: unknown): string {
  const text = typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : stringValue(value) ?? "";
  return encodeURIComponent(text.slice(0, 256));
}

function quotaKind(
  details: JsonRecord,
): "RPM" | "TPM" | "RPD" | "UNKNOWN" {
  const value = firstString(details, ["quotaKind", "quotaScope"])
    ?.toUpperCase();
  return value === "RPM" || value === "TPM" || value === "RPD"
    ? value
    : "UNKNOWN";
}

function credentialSlot(
  details: JsonRecord,
  names: readonly string[],
): number | null {
  const value = finiteNumber(firstValue(details, names));
  return value !== null && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizedRole(value: unknown, slot: number | null):
  | "Primary"
  | "Fallback"
  | null {
  const role = stringValue(value)?.toLocaleLowerCase("en-US");
  if (role === "primary") return "Primary";
  if (role === "fallback") return "Fallback";
  if (slot === 1) return "Primary";
  if (slot !== null && slot > 1) return "Fallback";
  return null;
}

function sourceRole(details: JsonRecord): "Primary" | "Fallback" | null {
  const slot = credentialSlot(details, [
    "fromCredentialSlot",
    "credentialSlot",
    "slot",
  ]);
  return normalizedRole(
    firstValue(details, ["fromCredentialRole", "credentialRole"]),
    slot,
  );
}

function targetRole(details: JsonRecord): "Primary" | "Fallback" | null {
  const slot = credentialSlot(details, ["toCredentialSlot"]);
  return normalizedRole(details.toCredentialRole, slot);
}

function quotaIds(details: JsonRecord): string[] {
  const raw = Array.isArray(details.quotaIds)
    ? details.quotaIds
    : details.quotaId === undefined
    ? []
    : [details.quotaId];
  const safe = raw
    .map((value) => stringValue(value))
    .filter((value): value is string => value !== null)
    .map((value) => safeText(value, 200))
    .filter(Boolean);
  return [...new Set(safe)].slice(0, 8);
}

function classificationReason(details: JsonRecord): string {
  const value = firstString(details, ["classificationReason"]);
  return value && SAFE_UNKNOWN_CLASSIFICATION_REASONS.has(value)
    ? value
    : UNSAFE_CLASSIFICATION_REASON;
}

function retryHintSource(details: JsonRecord): string | null {
  const value = firstString(details, ["retryHintSource"]);
  if (!value) return null;
  return SAFE_RETRY_HINT_SOURCES.has(value) ? value : UNSAFE_RETRY_HINT_SOURCE;
}

function model(details: JsonRecord): string {
  return safeText(firstString(details, ["model"]) ?? "Unknown model", 200);
}

function modelScope(details: JsonRecord): string {
  return keyPart(firstString(details, ["model"]) ?? "*");
}

function operationField(details: JsonRecord): DiscordField | null {
  const operation = firstString(details, ["operation"]);
  return operation
    ? { name: "Operation", value: safeText(operation, 200), inline: true }
    : null;
}

function modelField(details: JsonRecord): DiscordField {
  return { name: "Model", value: model(details), inline: true };
}

function isoTimestamp(value: unknown): string | null {
  const epochMs = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Date.parse(value)
    : Number.NaN;
  if (!Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function retryField(details: JsonRecord): DiscordField | null {
  const retryAt = firstString(details, [
    "retryAt",
    "cooldownUntil",
    "cooldownUntilIso",
  ]);
  const retryAtIso = isoTimestamp(retryAt);
  if (retryAtIso) {
    return {
      name: "Retry after",
      value: retryAtIso,
      inline: false,
    };
  }

  const cooldownUntilMs = finiteNumber(details.cooldownUntilMs);
  const cooldownUntilIso = isoTimestamp(cooldownUntilMs);
  if (cooldownUntilIso) {
    return {
      name: "Retry after",
      value: cooldownUntilIso,
      inline: false,
    };
  }

  const cooldownMs = finiteNumber(details.cooldownMs);
  return cooldownMs !== null && cooldownMs >= 0
    ? {
      name: "Cooldown",
      value: `${Math.ceil(cooldownMs / 1_000)} seconds`,
      inline: false,
    }
    : null;
}

function incidentIdentity(details: JsonRecord): string | null {
  const value = firstValue(details, [
    "incidentId",
    "transitionId",
    "cooldownId",
    "breakerGeneration",
    "stateVersion",
  ]);
  if (typeof value === "number" && Number.isFinite(value)) {
    return keyPart(value);
  }
  const text = stringValue(value);
  return text ? keyPart(text) : null;
}

function retryIdentity(details: JsonRecord): string | null {
  const value = firstValue(details, [
    "retryAt",
    "cooldownUntil",
    "cooldownUntilIso",
    "cooldownUntilMs",
    "cooldownStartedAt",
  ]);
  if (typeof value === "number" && Number.isFinite(value)) {
    return keyPart(value);
  }
  const text = stringValue(value);
  return text ? keyPart(text) : null;
}

function transitionIdentity(details: JsonRecord, fallback: string): string {
  return incidentIdentity(details) ?? retryIdentity(details) ?? fallback;
}

function unavailableIdentity(details: JsonRecord): string {
  const explicit = incidentIdentity(details);
  if (explicit) return explicit;

  const unavailableAt = firstString(details, ["unavailableAt"]);
  const retryAt = firstValue(details, [
    "retryAt",
    "cooldownUntil",
    "cooldownUntilIso",
    "cooldownUntilMs",
  ]);
  const parts = [unavailableAt, retryAt]
    .filter((value) => value !== undefined && value !== null)
    .map(keyPart)
    .filter(Boolean);
  return parts.length > 0 ? parts.join(":") : "active";
}

function commonFields(details: JsonRecord): DiscordField[] {
  const fields: DiscordField[] = [modelField(details)];
  const operation = operationField(details);
  if (operation) fields.push(operation);
  const retry = retryField(details);
  if (retry) fields.push(retry);
  return fields;
}

function unknownFields(details: JsonRecord): DiscordField[] {
  const reason = classificationReason(details);
  const ids = quotaIds(details);
  const fields: DiscordField[] = [
    {
      name: "Classification reason",
      value: reason,
      inline: false,
    },
    {
      name: "Quota IDs",
      value: ids.length > 0 ? truncate(ids.join("\n"), 1_024) : "None provided",
      inline: false,
    },
  ];
  const retryHint = retryHintSource(details);
  if (retryHint) {
    fields.push({
      name: "Retry hint source",
      value: retryHint,
      inline: true,
    });
  }
  return fields;
}

function fallbackAlert(details: JsonRecord): RuntimeAlert | null {
  const fromRole = sourceRole(details) ?? "Primary";
  const toRole = targetRole(details) ?? "Fallback";
  if (fromRole !== "Primary" || toRole !== "Fallback") return null;

  const kind = quotaKind(details);
  if (kind === "UNKNOWN") return unknownRateLimitAlert(details);

  const scope = modelScope(details);
  const fromSlot = credentialSlot(details, ["fromCredentialSlot"]);
  const toSlot = credentialSlot(details, ["toCredentialSlot"]);
  const identity = transitionIdentity(
    details,
    `${kind}:${fromSlot ?? "primary"}:${toSlot ?? "fallback"}`,
  );
  return {
    severity: "WARNING",
    kind: "PRIMARY_FALLBACK_ACTIVATED",
    title: "[WARN] Gemini Primary → Fallback 전환",
    description:
      `Primary reached its ${kind} quota. Fallback is now handling requests.`,
    fields: [
      { name: "Severity", value: "WARNING", inline: true },
      { name: "Route", value: "Primary → Fallback", inline: true },
      { name: "Quota", value: kind, inline: true },
      ...commonFields(details),
    ],
    dedupeKey: `open:${scope}:fallback:${identity}`,
    scope,
  };
}

function unknownRateLimitAlert(details: JsonRecord): RuntimeAlert {
  const scope = modelScope(details);
  const role = sourceRole(details) ?? "Primary";
  const slot = credentialSlot(details, [
    "fromCredentialSlot",
    "credentialSlot",
    "slot",
  ]);
  const ids = quotaIds(details);
  const reason = classificationReason(details);
  const identity = transitionIdentity(
    details,
    [role, slot ?? "", reason, ...ids].map(keyPart).join(":"),
  );
  return {
    severity: "WARNING",
    kind: "UNKNOWN_RATE_LIMIT",
    title: `[WARN] Gemini ${role} UNKNOWN 429`,
    description:
      "Gemini returned 429, but it could not be classified as RPM, TPM, or RPD.",
    fields: [
      { name: "Severity", value: "WARNING", inline: true },
      { name: "Credential", value: role, inline: true },
      ...(slot === null
        ? []
        : [{ name: "Credential slot", value: String(slot), inline: true }]),
      ...commonFields(details),
      ...unknownFields(details),
    ],
    dedupeKey: `open:${scope}:unknown:${identity}`,
    scope,
  };
}

function unavailableAlert(details: JsonRecord): RuntimeAlert {
  const scope = modelScope(details);
  const kind = quotaKind(details);
  const identity = unavailableIdentity(details);
  const credentialCount = finiteNumber(
    firstValue(details, ["credentialCount", "coolingCredentialCount"]),
  );
  const fields: DiscordField[] = [
    { name: "Severity", value: "CRITICAL", inline: true },
    { name: "Quota", value: kind, inline: true },
    ...commonFields(details),
  ];
  if (credentialCount !== null && credentialCount >= 0) {
    fields.push({
      name: "Unavailable credentials",
      value: String(Math.floor(credentialCount)),
      inline: true,
    });
  }
  if (kind === "UNKNOWN") fields.push(...unknownFields(details));

  return {
    severity: "CRITICAL",
    kind: "API_KEYS_UNAVAILABLE",
    title: "[CRITICAL] Gemini 전체 API 키 사용 불가",
    description:
      "Primary and every Fallback API key are unavailable. Gemini requests cannot proceed.",
    fields,
    dedupeKey: `open:${scope}:unavailable:${identity}`,
    scope,
  };
}

function authAlert(details: JsonRecord): RuntimeAlert | null {
  const status = finiteNumber(details.status);
  if (status !== 401 && status !== 403) return null;

  const scope = modelScope(details);
  const slot = credentialSlot(details, ["credentialSlot", "slot"]);
  const role = normalizedRole(details.credentialRole, slot) ?? "Primary";
  const identity = incidentIdentity(details) ?? "active";
  return {
    severity: "CRITICAL",
    kind: "AUTH_FAILED",
    title: "[CRITICAL] Gemini API 키 인증 오류",
    description:
      `${role} received HTTP ${status}. Check the configured Gemini credential and its permissions.`,
    fields: [
      { name: "Severity", value: "CRITICAL", inline: true },
      { name: "Credential", value: role, inline: true },
      { name: "HTTP status", value: String(status), inline: true },
      ...commonFields(details),
    ],
    dedupeKey: `open:${scope}:auth:${role.toLocaleLowerCase("en-US")}:${
      slot ?? "unknown"
    }:${status}:${identity}`,
    scope,
  };
}

function recoveredAlert(
  event: string,
  details: JsonRecord,
): RuntimeAlert | null {
  const scope = modelScope(details);
  const serviceRecovery = event === "ai_gemini_service_recovered";
  const slot = credentialSlot(details, ["credentialSlot", "slot"]);
  const role = normalizedRole(details.credentialRole, slot);
  if (!serviceRecovery && role !== null && role !== "Primary") return null;

  const identity = serviceRecovery
    ? unavailableIdentity(details)
    : transitionIdentity(details, "active");
  return {
    severity: "RECOVERED",
    kind: serviceRecovery ? "SERVICE_RECOVERED" : "PRIMARY_RECOVERED",
    title: serviceRecovery
      ? "[RECOVERED] Gemini 서비스 복구"
      : "[RECOVERED] Gemini Fallback → Primary 복귀",
    description: serviceRecovery
      ? "The Gemini service is available again."
      : "Primary is available again and can resume handling requests.",
    fields: [
      { name: "Severity", value: "RECOVERED", inline: true },
      {
        name: "Recovered target",
        value: serviceRecovery ? "Service" : "Primary",
        inline: true,
      },
      ...commonFields(details),
    ],
    dedupeKey: `recovered:${scope}:${
      serviceRecovery ? "service" : "primary"
    }:${identity}`,
    scope,
  };
}

function alertForEvent(
  event: string,
  rawDetails: Record<string, unknown>,
): RuntimeAlert | null {
  const details = record(rawDetails);
  if (FALLBACK_ACTIVATED_EVENTS.has(event)) return fallbackAlert(details);
  if (
    event === "ai_gemini_api_key_cooldown_started" &&
    quotaKind(details) === "UNKNOWN"
  ) {
    return unknownRateLimitAlert(details);
  }
  if (API_KEYS_UNAVAILABLE_EVENTS.has(event)) {
    return unavailableAlert(details);
  }
  if (event === "ai_gemini_api_key_auth_failed") return authAlert(details);
  if (
    event === "ai_gemini_primary_recovered" ||
    event === "ai_gemini_service_recovered"
  ) {
    return recoveredAlert(event, details);
  }
  return null;
}

function currentTimestamp(dependencies: GeminiRuntimeDiscordAlertDependencies) {
  try {
    const date = dependencies.now?.() ?? new Date();
    if (Number.isFinite(date.getTime())) return date.toISOString();
  } catch {
    // Timestamp failure must not prevent a runtime alert.
  }
  return undefined;
}

function discordPayload(
  alert: RuntimeAlert,
  dependencies: GeminiRuntimeDiscordAlertDependencies,
): JsonRecord {
  const timestamp = currentTimestamp(dependencies);
  return {
    username: "Yeogidam Gemini Runtime",
    content: truncate(
      `${ICONS[alert.severity]} ${alert.title}`,
      2_000,
    ),
    allowed_mentions: { parse: [] },
    embeds: [{
      title: truncate(alert.title, 256),
      description: truncate(alert.description, 4_096),
      color: COLORS[alert.severity],
      fields: alert.fields.slice(0, 25),
      ...(timestamp ? { timestamp } : {}),
      footer: { text: "Gemini runtime alert" },
    }],
  };
}

function logSafely(
  log: AiLog | undefined,
  event: string,
  details: Record<string, unknown>,
): void {
  try {
    log?.(event, details);
  } catch {
    // Alert delivery and the application request must not depend on logging.
  }
}

function dedupeFingerprint(key: string): string {
  let hash = 0x811C9DC5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function currentTimeMs(
  dependencies: GeminiRuntimeDiscordAlertDependencies,
): number {
  try {
    const value = dependencies.now?.().getTime();
    if (value !== undefined && Number.isFinite(value)) return value;
  } catch {
    // Retry-After can fall back to the process clock.
  }
  return Date.now();
}

function retryAfterMs(
  response: Response,
  dependencies: GeminiRuntimeDiscordAlertDependencies,
): number | null {
  const raw = response.headers.get("Retry-After")?.trim();
  if (!raw) return null;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1_000));
    }
  }

  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) return null;
  return Math.min(
    MAX_RETRY_AFTER_MS,
    Math.max(0, retryAt - currentTimeMs(dependencies)),
  );
}

function isRetryableDiscordStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function fallbackRetryDelay(attemptIndex: number): number {
  return FALLBACK_RETRY_DELAYS_MS[
    Math.min(attemptIndex, FALLBACK_RETRY_DELAYS_MS.length - 1)
  ];
}

async function requestDiscordWithTimeout(
  request: typeof fetch,
  webhookUrl: string,
  body: string,
  dependencies: GeminiRuntimeDiscordAlertDependencies,
): Promise<Response> {
  const controller = new AbortController();
  const scheduleTimeout = dependencies.scheduleTimeout ?? setTimeout;
  let timer: unknown;
  let timeoutScheduled = false;
  let rejectTimeout!: (reason?: unknown) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });

  try {
    timer = scheduleTimeout(() => {
      controller.abort();
      rejectTimeout(
        new DOMException("Discord delivery timed out", "TimeoutError"),
      );
    }, DISCORD_DELIVERY_TIMEOUT_MS);
    timeoutScheduled = true;
    return await Promise.race([
      request(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      }),
      timeout,
    ]);
  } finally {
    if (timeoutScheduled) {
      if (dependencies.clearScheduledTimeout) {
        dependencies.clearScheduledTimeout(timer);
      } else {
        clearTimeout(timer as ReturnType<typeof setTimeout>);
      }
    }
  }
}

async function waitBeforeRetry(
  delayMs: number,
  dependencies: GeminiRuntimeDiscordAlertDependencies,
  context: Record<string, unknown>,
): Promise<void> {
  const sleep = dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  try {
    await sleep(delayMs);
  } catch (error) {
    logSafely(
      dependencies.log,
      "ai_runtime_discord_alert_retry_sleep_failed",
      {
        ...context,
        errorName: error instanceof Error ? error.name : "unknown",
      },
    );
  }
}

async function deliverGeminiRuntimeDiscordAlert(
  event: string,
  alert: RuntimeAlert,
  webhookUrl: string,
  dependencies: GeminiRuntimeDiscordAlertDependencies,
): Promise<GeminiRuntimeAlertOutcome> {
  const dedupe = dependencies.dedupe ?? sharedDedupe;
  try {
    if (!dedupe.claim(alert.dedupeKey)) {
      return {
        status: "deduplicated",
        severity: alert.severity,
        kind: alert.kind,
      };
    }
  } catch (error) {
    logSafely(dependencies.log, "ai_runtime_discord_alert_dedupe_failed", {
      sourceEvent: event,
      severity: alert.severity,
      alertKind: alert.kind,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }

  const fingerprint = dedupeFingerprint(alert.dedupeKey);
  const request = dependencies.fetch ?? fetch;
  const body = JSON.stringify(discordPayload(alert, dependencies));
  let delivered = false;
  let attemptCount = 0;
  let lastErrorName: string | undefined;
  let lastUpstreamStatus: number | undefined;

  for (
    let attemptIndex = 0;
    attemptIndex < DISCORD_DELIVERY_ATTEMPTS;
    attemptIndex += 1
  ) {
    attemptCount = attemptIndex + 1;
    let retryDelayMs: number | null = null;
    try {
      const response = await requestDiscordWithTimeout(
        request,
        webhookUrl,
        body,
        dependencies,
      );
      if (!response || typeof response.ok !== "boolean") {
        throw new TypeError("invalid_discord_response");
      }
      lastErrorName = undefined;
      lastUpstreamStatus = response.status;
      if (response.ok) {
        delivered = true;
        break;
      }
      if (
        !isRetryableDiscordStatus(response.status) ||
        attemptCount >= DISCORD_DELIVERY_ATTEMPTS
      ) break;
      retryDelayMs = retryAfterMs(response, dependencies) ??
        fallbackRetryDelay(attemptIndex);
    } catch (error) {
      lastUpstreamStatus = undefined;
      lastErrorName = error instanceof Error ? error.name : "unknown";
      if (attemptCount >= DISCORD_DELIVERY_ATTEMPTS) break;
      retryDelayMs = fallbackRetryDelay(attemptIndex);
    }

    logSafely(
      dependencies.log,
      "ai_runtime_discord_alert_delivery_retry_scheduled",
      {
        sourceEvent: event,
        severity: alert.severity,
        alertKind: alert.kind,
        incidentFingerprint: fingerprint,
        attemptCount,
        nextAttempt: attemptCount + 1,
        retryDelayMs,
        ...(lastUpstreamStatus === undefined
          ? {}
          : { upstreamStatus: lastUpstreamStatus }),
        ...(lastErrorName === undefined ? {} : { errorName: lastErrorName }),
      },
    );
    await waitBeforeRetry(retryDelayMs, dependencies, {
      sourceEvent: event,
      severity: alert.severity,
      alertKind: alert.kind,
      incidentFingerprint: fingerprint,
      attemptCount,
    });
  }

  if (!delivered) {
    try {
      dedupe.release(alert.dedupeKey);
    } catch {
      // A broken injected store must not affect the application request.
    }
    logSafely(dependencies.log, "ai_runtime_discord_alert_delivery_failed", {
      sourceEvent: event,
      severity: alert.severity,
      alertKind: alert.kind,
      incidentFingerprint: fingerprint,
      attemptCount,
      ...(lastUpstreamStatus === undefined
        ? {}
        : { upstreamStatus: lastUpstreamStatus }),
      ...(lastErrorName === undefined ? {} : { errorName: lastErrorName }),
    });
    return {
      status: "delivery_failed",
      severity: alert.severity,
      kind: alert.kind,
    };
  }

  logSafely(dependencies.log, "ai_runtime_discord_alert_delivered", {
    sourceEvent: event,
    severity: alert.severity,
    alertKind: alert.kind,
    incidentFingerprint: fingerprint,
    attemptCount,
  });
  return { status: "sent", severity: alert.severity, kind: alert.kind };
}

/**
 * Converts selected AiLog events into Discord alerts. Unrelated and
 * per-request success events return null. Same-model transitions are delivered
 * in invocation order, so a retrying recovery cannot overtake a newer outage.
 * Each waitUntil task retries transient network, 429, and 5xx failures up to
 * three total attempts, with each network attempt bounded by a timeout.
 * Response bodies are never read.
 */
export async function sendGeminiRuntimeDiscordAlert(
  event: string,
  details: Record<string, unknown>,
  dependencies: GeminiRuntimeDiscordAlertDependencies,
): Promise<GeminiRuntimeAlertOutcome | null> {
  const alert = alertForEvent(event, details);
  if (!alert) return null;

  const webhookUrl = stringValue(dependencies.webhookUrl);
  if (!webhookUrl) {
    logSafely(dependencies.log, "ai_runtime_discord_alert_config_missing", {
      sourceEvent: event,
      severity: alert.severity,
      alertKind: alert.kind,
    });
    return {
      status: "not_configured",
      severity: alert.severity,
      kind: alert.kind,
    };
  }

  const transitionQueue = dependencies.transitionQueue ??
    sharedTransitionQueue;
  return await transitionQueue.run(
    alert.scope,
    () =>
      deliverGeminiRuntimeDiscordAlert(
        event,
        alert,
        webhookUrl,
        dependencies,
      ),
  );
}
