type JsonRecord = Record<string, unknown>;

export type QuotaKind = "RPM" | "RPD" | "TPM";
export type ProjectRole = "primary" | "fallback";
export type AlertSeverity = "WARNING";

export type RpdAlertPolicy = {
  quotaKind: "RPD";
  projectRole: ProjectRole;
  thresholdPercent: number;
  severity: AlertSeverity;
};

export interface CloudIncidentDedupeStore {
  claim(key: string): boolean;
  release(key: string): void;
}

export type GeminiQuotaDiscordDependencies = {
  webhookUsername?: string;
  webhookPassword?: string;
  discordWebhookUrl?: string;
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
  dedupe?: CloudIncidentDedupeStore;
};

type Incident = JsonRecord & {
  incident_id?: unknown;
  renotify?: unknown;
  scoping_project_id?: unknown;
  url?: unknown;
  started_at?: unknown;
  state?: unknown;
  metric?: unknown;
  resource?: unknown;
  policy_name?: unknown;
  policy_user_labels?: unknown;
  condition_name?: unknown;
  observed_value?: unknown;
};

type AlertPayload = JsonRecord & {
  incident?: unknown;
};

const QUOTA_DETAILS: Record<QuotaKind, string> = {
  RPM: "최근 1분 요청 수",
  RPD: "최근 23시간 요청 수 (일일 한도 근사)",
  TPM: "최근 1분 입력 토큰 수",
};

const PROJECT_ROLE_NAMES: Record<ProjectRole, string> = {
  primary: "Primary",
  fallback: "Fallback",
};

const PROJECT_IDS: Record<ProjectRole, string> = {
  primary: "gen-lang-client-0666690473",
  fallback: "yeogidam",
};

const SUPPORTED_RPD_THRESHOLD_PERCENT = 80;
const SUPPORTED_RPD_SEVERITY: AlertSeverity = "WARNING";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

class InMemoryCloudIncidentDedupe implements CloudIncidentDedupeStore {
  readonly #claimed = new Set<string>();

  claim(key: string): boolean {
    if (this.#claimed.has(key)) return false;
    if (this.#claimed.size >= 1_000) {
      const oldest = this.#claimed.values().next().value;
      if (typeof oldest === "string") this.#claimed.delete(oldest);
    }
    this.#claimed.add(key);
    return true;
  }

  release(key: string): void {
    this.#claimed.delete(key);
  }
}

const sharedIncidentDedupe = new InMemoryCloudIncidentDedupe();

export function createInMemoryCloudIncidentDedupe(): CloudIncidentDedupeStore {
  return new InMemoryCloudIncidentDedupe();
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...headers },
  });
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberValue(value: unknown): number | null {
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized === "") return null;
  const number = typeof normalized === "number"
    ? normalized
    : typeof normalized === "string"
    ? Number(normalized)
    : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const result = stringValue(value);
    if (result) return result;
  }
  return null;
}

function secureEqual(actual: string, expected: string): boolean {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  const length = Math.max(actualBytes.length, expectedBytes.length);
  let difference = actualBytes.length ^ expectedBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }

  return difference === 0;
}

function isAuthorized(
  request: Request,
  username: string,
  password: string,
): boolean {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Basic\s+([^\s]+)$/i);
  if (!match) return false;

  let expected: string;
  try {
    expected = btoa(`${username}:${password}`);
  } catch {
    return false;
  }
  return secureEqual(match[1], expected);
}

function recordValue(record: unknown, key: string): unknown {
  return asRecord(record)?.[key];
}

export function quotaKindFromIncident(incident: Incident): QuotaKind | null {
  const labeledKind = firstString(
    recordValue(incident.policy_user_labels, "quota_kind"),
    recordValue(incident.policy_user_labels, "quota-kind"),
  )?.toUpperCase();
  if (labeledKind === "RPM" || labeledKind === "RPD" || labeledKind === "TPM") {
    return labeledKind;
  }
  return null;
}

function projectRoleFromIncident(incident: Incident): ProjectRole | null {
  const role = firstString(
    recordValue(incident.policy_user_labels, "project_role"),
    recordValue(incident.policy_user_labels, "project-role"),
  )?.toLowerCase();
  return role === "primary" || role === "fallback" ? role : null;
}

function thresholdPercentFromIncident(incident: Incident): number | null {
  const rawThreshold = firstString(
    recordValue(incident.policy_user_labels, "threshold_percent"),
    recordValue(incident.policy_user_labels, "threshold-percent"),
  );
  if (!rawThreshold) return null;

  const threshold = numberValue(rawThreshold.replace(/%$/, ""));
  return threshold !== null && threshold > 0 && threshold <= 100
    ? threshold
    : null;
}

function severityFromIncident(incident: Incident): AlertSeverity | null {
  const severity = firstString(
    recordValue(incident.policy_user_labels, "severity"),
    recordValue(incident.policy_user_labels, "alert_severity"),
  )?.toUpperCase();
  return severity === SUPPORTED_RPD_SEVERITY ? severity : null;
}

function sourceProjectIdFromIncident(incident: Incident): string | null {
  const metricLabels = asRecord(asRecord(incident.metric)?.labels);
  const resourceLabels = asRecord(asRecord(incident.resource)?.labels);
  return firstString(
    resourceLabels?.resource_container,
    resourceLabels?.project_id,
    metricLabels?.resource_container,
  );
}

function kstTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${
    value("minute")
  } KST`;
}

function formatObservedPercent(ratio: number | null): string {
  if (ratio === null || ratio < 0) return "사용률 정보 없음";
  const percent = ratio * 100;
  const digits = Number.isInteger(percent) ? 0 : 1;
  return `${percent.toFixed(digits)}%`;
}

function formatThresholdPercent(percent: number): string {
  const digits = Number.isInteger(percent) ? 0 : 1;
  return `${percent.toFixed(digits)}%`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function discordPayloadForIncident(
  incident: Incident,
  policy: RpdAlertPolicy,
  fallbackDate: Date,
): Record<string, unknown> {
  const metric = asRecord(incident.metric);
  const metricLabels = asRecord(metric?.labels);
  const resource = asRecord(incident.resource);
  const resourceLabels = asRecord(resource?.labels);
  const startedAt = numberValue(incident.started_at);
  const detectedAt = startedAt !== null
    ? new Date(startedAt * 1_000)
    : fallbackDate;
  const observedPercentage = formatObservedPercent(
    numberValue(incident.observed_value),
  );
  const thresholdPercentage = formatThresholdPercent(policy.thresholdPercent);
  const projectRole = PROJECT_ROLE_NAMES[policy.projectRole];
  const model = firstString(
    metricLabels?.model,
    resourceLabels?.model,
  ) ?? "모델 정보 없음";
  const project = firstString(
    sourceProjectIdFromIncident(incident),
    incident.scoping_project_id,
  ) ?? "프로젝트 정보 없음";
  const limitName = firstString(metricLabels?.limit_name);
  const incidentUrl = stringValue(incident.url);
  const detectedAtText = kstTimestamp(detectedAt);

  const fields: Array<Record<string, unknown>> = [
    { name: "프로젝트 역할", value: projectRole, inline: true },
    { name: "알림 등급", value: policy.severity, inline: true },
    {
      name: "설정 임계치",
      value: thresholdPercentage,
      inline: true,
    },
    {
      name: "사용량 기준",
      value: QUOTA_DETAILS[policy.quotaKind],
      inline: true,
    },
    { name: "현재 사용률", value: observedPercentage, inline: true },
    { name: "감지 시각", value: detectedAtText, inline: false },
    { name: "모델", value: truncate(model, 1_024), inline: true },
    {
      name: "Google Cloud 프로젝트",
      value: truncate(project, 1_024),
      inline: true,
    },
  ];
  if (limitName) {
    fields.push({
      name: "Google 한도 이름",
      value: truncate(limitName, 1_024),
      inline: false,
    });
  }

  return {
    username: "여기담 Gemini 모니터링",
    content: truncate(
      `⚠️ ${policy.severity} · Gemini ${projectRole} RPD 사용량이 ${observedPercentage}에 도달했습니다 (경고선 ${thresholdPercentage}) · ${detectedAtText}`,
      2_000,
    ),
    allowed_mentions: { parse: [] },
    embeds: [{
      title:
        `[WARN][${projectRole.toUpperCase()}] Gemini RPD ${thresholdPercentage}`,
      description: `${projectRole} 프로젝트의 ${
        QUOTA_DETAILS[policy.quotaKind]
      }가 ${thresholdPercentage} 경고선에 도달했습니다.`,
      color: 0xF59E0B,
      ...(incidentUrl ? { url: incidentUrl } : {}),
      fields,
      footer: {
        text:
          "Google Cloud Monitoring · 수집/평가 지연으로 늦게 도착할 수 있음",
      },
    }],
  };
}

function ignored(reason: string): Response {
  return jsonResponse(202, { ok: true, ignored: reason });
}

export async function handleGeminiQuotaDiscord(
  request: Request,
  dependencies: GeminiQuotaDiscordDependencies,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, {
      Allow: "POST",
    });
  }

  const username = stringValue(dependencies.webhookUsername);
  const password = stringValue(dependencies.webhookPassword);
  if (!username || !password) {
    dependencies.log?.({ event: "gemini_quota_webhook_auth_config_missing" });
    return jsonResponse(500, { ok: false, error: "server_not_configured" });
  }

  if (!isAuthorized(request, username, password)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" }, {
      "WWW-Authenticate": 'Basic realm="gemini-quota-alert"',
    });
  }

  const discordWebhookUrl = stringValue(dependencies.discordWebhookUrl);
  if (!discordWebhookUrl) {
    dependencies.log?.({ event: "gemini_quota_discord_config_missing" });
    return jsonResponse(500, { ok: false, error: "server_not_configured" });
  }

  let payload: AlertPayload;
  try {
    const parsed = await request.json();
    const record = asRecord(parsed);
    if (!record) throw new Error("body_not_object");
    payload = record;
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const incident = asRecord(payload.incident) as Incident | null;
  if (!incident) return ignored("non_incident_payload");
  if (incident.state !== "open") return ignored("incident_not_open");
  if (incident.renotify === true) return ignored("repeated_notification");

  const quotaKind = quotaKindFromIncident(incident);
  if (!quotaKind) return ignored("unknown_quota_kind");
  if (quotaKind !== "RPD") return ignored("unsupported_quota_kind");

  const projectRole = projectRoleFromIncident(incident);
  if (!projectRole) return ignored("unknown_project_role");

  const sourceProjectId = sourceProjectIdFromIncident(incident);
  if (!sourceProjectId) return ignored("missing_source_project");
  if (sourceProjectId !== PROJECT_IDS[projectRole]) {
    return ignored("project_role_mismatch");
  }

  const thresholdPercent = thresholdPercentFromIncident(incident);
  if (thresholdPercent === null) return ignored("invalid_threshold");
  if (thresholdPercent !== SUPPORTED_RPD_THRESHOLD_PERCENT) {
    return ignored("unsupported_threshold");
  }

  const severity = severityFromIncident(incident);
  if (!severity) return ignored("unsupported_severity");

  const policy: RpdAlertPolicy = {
    quotaKind,
    projectRole,
    thresholdPercent,
    severity,
  };

  const discordPayload = discordPayloadForIncident(
    incident,
    policy,
    (dependencies.now ?? (() => new Date()))(),
  );

  const incidentId = stringValue(incident.incident_id);
  const dedupeKey = [
    incidentId ?? stringValue(incident.policy_name) ?? "missing-id",
    projectRole,
    sourceProjectId,
    numberValue(incident.started_at)?.toString() ?? "missing-start",
  ].join(":");
  const dedupe = dependencies.dedupe ?? sharedIncidentDedupe;
  if (!dedupe.claim(dedupeKey)) return ignored("duplicate_incident");

  let discordResponse: Response;
  try {
    discordResponse = await (dependencies.fetch ?? fetch)(discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(discordPayload),
    });
  } catch (error) {
    dedupe.release(dedupeKey);
    dependencies.log?.({
      event: "gemini_quota_discord_delivery_failed",
      incidentId: stringValue(incident.incident_id),
      quotaKind,
      projectRole,
      thresholdPercent,
      severity,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return jsonResponse(502, { ok: false, error: "discord_unavailable" });
  }

  if (!discordResponse.ok) {
    dedupe.release(dedupeKey);
    dependencies.log?.({
      event: "gemini_quota_discord_delivery_rejected",
      incidentId: stringValue(incident.incident_id),
      quotaKind,
      projectRole,
      thresholdPercent,
      severity,
      upstreamStatus: discordResponse.status,
    });
    return jsonResponse(502, { ok: false, error: "discord_rejected" });
  }

  dependencies.log?.({
    event: "gemini_quota_discord_delivered",
    incidentId: stringValue(incident.incident_id),
    quotaKind,
    projectRole,
    thresholdPercent,
    severity,
  });
  return new Response(null, { status: 204 });
}
