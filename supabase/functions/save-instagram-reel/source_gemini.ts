// 2026-Yeogidam GeminiPlaceNameExtractor / GeminiFileClient의 이식.
// 모델 호출이 잠시 실패하면 같은 키로 다시 보내고, 429면 예비 키로 넘긴다.
import { AiConfigError, aiHttpError, AiProviderError } from "./ai/errors.ts";
import {
  createGeminiCredentialPool,
  type GeminiApiKeyStateStore,
  type GeminiCredentialCall,
  GeminiHttpStatusError,
  retryAfterMs,
} from "./ai/gemini_credentials.ts";
import { readBoundedErrorJson } from "./ai/http.ts";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import type { AiLog } from "./ai/provider.ts";
import type { AiOperation } from "./ai/types.ts";
import {
  type DownloadedInstagramMedia,
  downloadInstagramMedia,
  removeDownloadedMedia,
} from "./instagram_media.ts";
import { mediaHttp } from "./media_http.ts";
import type { SourcePlaceHint } from "./source_analysis.ts";
import {
  SOURCE_CAPTION_INSTRUCTION,
  SOURCE_MEDIA_INSTRUCTION,
} from "./source_prompts.ts";

type Json = Record<string, unknown>;
const BASE = "https://generativelanguage.googleapis.com";
const CAPTION_TIMEOUT_MS = 20_000;
const MEDIA_TIMEOUT_MS = 120_000;
const PROCESSING_TIMEOUT_MS = 120_000;
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
// 원본 합계가 이 크기 이하면 Files API 대신 요청 본문에 base64로 싣는다. Gemini 인라인 한도는 요청 전체
// 100MB 미만이고, base64로 3분의 1쯤 커진 본문이 Edge Function 메모리(256MB)에 올라가므로 여유를 둔다.
// 길이가 아니라 크기로 가르므로 1분이 넘는 릴스도 이 크기 안이면 인라인으로 간다.
const INLINE_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
// 모델이 잠시 과부하(5xx)이거나 응답이 늦으면 같은 키로 다시 보낸다. 업로드는 다시 보내지 않는다.
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 3_000];
const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 10_000;
// 뒤에 쓸 key가 있으면 일시적 오류에서 같은 key로 재시도하지 않고 바로 넘긴다. 무료 key의 혼잡(503)을
// 결제 key가 받게 하려는 것이고, 오류를 낸 key는 60초 동안 뒤로 미룬 뒤 다시 먼저 쓴다.
const OVERLOAD_COOLDOWN_MS = 60_000;
// 한 건의 처리가 Edge Function 실행 한도(유료 400초)를 넘지 않도록 재시도와 키 전환에 쓸 시간을 묶는다.
// 인스타 읽기 30초, 캡션 75초, OpenAI 폴백 20초, 미디어 240초를 더해도 400초 안에 든다.
const CAPTION_BUDGET_MS = 75_000;
const MEDIA_BUDGET_MS = 240_000;

// Deno의 ReadableStream 요청은 Content-Length를 전송하지 않는다.
// 크기가 알려진 작은 버퍼를 순차 전송해 원본의 resumable 프로토콜을 유지한다.
export async function uploadSourceMediaBytes(
  request: typeof fetch,
  session: { url: string; chunkSize: number },
  media: DownloadedInstagramMedia,
): Promise<unknown> {
  if (
    !Number.isSafeInteger(session.chunkSize) || session.chunkSize < 1 ||
    session.chunkSize > UPLOAD_CHUNK_BYTES
  ) {
    throw new Error("source_gemini_upload_chunk_invalid");
  }
  if (media.size < 1 || (await Deno.stat(media.path)).size !== media.size) {
    throw new Error("source_gemini_upload_file_size_invalid");
  }
  const local = await Deno.open(media.path, { read: true });
  try {
    let offset = 0;
    while (offset < media.size) {
      const chunk = new Uint8Array(
        Math.min(session.chunkSize, media.size - offset),
      );
      let read = 0;
      while (read < chunk.byteLength) {
        const count = await local.read(chunk.subarray(read));
        if (count === null) {
          throw new Error("source_gemini_upload_file_truncated");
        }
        read += count;
      }
      const final = offset + chunk.byteLength === media.size;
      const payload = await mediaHttp(
        request,
        session.url,
        {
          method: "POST",
          headers: {
            "X-Goog-Upload-Offset": String(offset),
            "X-Goog-Upload-Command": final ? "upload, finalize" : "upload",
            "Content-Type": media.mimeType,
            "Content-Length": String(chunk.byteLength),
          },
          body: chunk,
        },
        MEDIA_TIMEOUT_MS,
        async (response) => {
          if (!response.ok) {
            await response.body?.cancel();
            throw new GeminiHttpStatusError(
              response,
              null,
              undefined,
              `source_analysis_http_${response.status}`,
            );
          }
          if (final) return await response.json();
          await response.body?.cancel();
          return null;
        },
      );
      offset += chunk.byteLength;
      if (final) return payload;
    }
    throw new Error("source_gemini_upload_empty");
  } finally {
    local.close();
  }
}

export const SOURCE_HINTS_SCHEMA = {
  type: "object",
  properties: {
    places: {
      type: "array",
      items: {
        type: "object",
        properties: {
          nameInCaption: { type: "string" },
          nameSearchHint: { type: ["string", "null"] },
          accountHints: { type: "array", items: { type: "string" } },
          locationHints: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["ADDRESS", "REGION"] },
                value: { type: "string" },
                basis: {
                  type: "string",
                  enum: ["CAPTION", "INFERRED", "VIDEO", "IMAGE"],
                },
              },
              required: ["type", "value", "basis"],
              additionalProperties: false,
            },
          },
          categoryHint: { type: ["string", "null"] },
        },
        required: [
          "nameInCaption",
          "nameSearchHint",
          "accountHints",
          "locationHints",
          "categoryHint",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["places"],
  additionalProperties: false,
};

function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source_gemini_response_invalid");
  }
  return value as Json;
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

export function parseSourcePlaceHints(payload: unknown): SourcePlaceHint[] {
  const places = object(payload).places;
  if (!Array.isArray(places)) throw new Error("source_gemini_places_invalid");
  return places.map((value) => {
    const hint = object(value);
    if (
      !nonblank(hint.nameInCaption) ||
      !(hint.nameSearchHint == null || nonblank(hint.nameSearchHint)) ||
      !(hint.categoryHint == null || nonblank(hint.categoryHint)) ||
      !Array.isArray(hint.accountHints) || hint.accountHints.some((item) =>
        typeof item !== "string"
      ) ||
      !Array.isArray(hint.locationHints)
    ) throw new Error("source_gemini_hint_invalid");
    const locations = hint.locationHints.map((value) => {
      const location = object(value);
      // 원본 LocationHint와 동일하게 빈 위치 정보는 허용하지 않는다.
      if (
        !["ADDRESS", "REGION"].includes(String(location.type)) ||
        !["CAPTION", "INFERRED", "VIDEO", "IMAGE"].includes(
          String(location.basis),
        ) ||
        !nonblank(location.value)
      ) throw new Error("source_gemini_location_invalid");
      return location as unknown as SourcePlaceHint["locationHints"][number];
    });
    return {
      nameInCaption: hint.nameInCaption,
      nameSearchHint: hint.nameSearchHint as string | null ?? null,
      accountHints: hint.accountHints as string[],
      locationHints: locations,
      categoryHint: hint.categoryHint as string | null ?? null,
    };
  });
}

export function sourceCaptionInput(caption: string): string {
  const handles = [
    ...new Set(
      [...caption.matchAll(/(?<![A-Za-z0-9._])@([A-Za-z0-9._]{1,30})\b/g)]
        .map((match) => match[1]),
    ),
  ];
  if (!handles.length) return caption;
  return caption + "\n\nInstagram account profile URLs:\n" +
    handles.map((handle) => `https://www.instagram.com/${handle}/`).join("\n");
}

// Gemini의 JSON 응답을 읽는다. 성공이 아니면 상태 코드를 담아 던지고, 429 본문은 쿼터 분류에만 쓰도록 상한 안에서 읽는다.
async function geminiJson(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  return await mediaHttp(
    request,
    url,
    init,
    timeoutMs,
    async (response, signal) => {
      if (!response.ok) {
        const errorBody = response.status === 429
          ? await readBoundedErrorJson(response, signal)
          : null;
        if (!errorBody) await response.body?.cancel();
        throw new GeminiHttpStatusError(
          response,
          errorBody?.payload ?? null,
          errorBody?.status,
          `source_analysis_http_${response.status}`,
        );
      }
      return await response.json();
    },
  );
}

function isRequestTimeout(error: unknown): boolean {
  return error instanceof Error &&
    (error.message === "source_analysis_request_timeout" ||
      error.message === "source_gemini_file_processing_timeout");
}

function isTransientFailure(error: unknown): boolean {
  if (error instanceof GeminiHttpStatusError) {
    return TRANSIENT_STATUSES.has(error.status);
  }
  return error instanceof TypeError || isRequestTimeout(error);
}

/**
 * 분석 실패를 공급자 오류 종류로 바꿔, 폴백 판단과 로그가 v10과 같은 기준을 쓰게 한다.
 * 인스타그램 원본을 받지 못한 오류처럼 Gemini와 무관한 오류는 그대로 둔다.
 */
export function sourceGeminiFailure(
  operation: AiOperation,
  model: string,
  error: unknown,
): unknown {
  if (error instanceof AiProviderError || error instanceof AiConfigError) {
    return error;
  }
  if (error instanceof GeminiHttpStatusError) {
    return aiHttpError("gemini", operation, model, error.status);
  }
  if (isRequestTimeout(error)) {
    return new AiProviderError("gemini", operation, "TIMEOUT", {
      model,
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof TypeError) {
    return new AiProviderError("gemini", operation, "NETWORK", {
      model,
      retryable: true,
      cause: error,
    });
  }
  if (
    error instanceof SyntaxError ||
    (error instanceof Error && error.message.startsWith("source_gemini_"))
  ) {
    return new AiProviderError("gemini", operation, "INVALID_RESPONSE", {
      model,
      retryable: true,
      cause: error,
    });
  }
  return error;
}

function mediaRequestBody(caption: string, mediaParts: unknown[]) {
  return {
    systemInstruction: {
      parts: [{ text: SOURCE_MEDIA_INSTRUCTION }],
    },
    contents: [{
      role: "user",
      parts: [{ text: sourceCaptionInput(caption) }, ...mediaParts],
    }],
    tools: [{ urlContext: {} }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: SOURCE_HINTS_SCHEMA,
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
    },
  };
}

function captionOutput(payload: unknown): string {
  const response = object(payload);
  if (response.status !== "completed" || !Array.isArray(response.steps)) {
    throw new Error("source_gemini_caption_incomplete");
  }
  for (const value of response.steps) {
    const step = object(value);
    if (step.type !== "model_output") continue;
    if (!Array.isArray(step.content)) break;
    for (const value of step.content) {
      const content = object(value);
      if (content.type === "text" && typeof content.text === "string") {
        return content.text;
      }
    }
    break;
  }
  throw new Error("source_gemini_caption_output_missing");
}

function mediaOutput(payload: unknown): string {
  const candidates = object(payload).candidates;
  if (!Array.isArray(candidates) || !candidates.length) {
    throw new Error("source_gemini_media_output_missing");
  }
  const candidate = object(candidates[0]);
  if (candidate.finishReason !== "STOP") {
    throw new Error("source_gemini_media_incomplete");
  }
  const parts = object(candidate.content).parts;
  if (!Array.isArray(parts)) {
    throw new Error("source_gemini_media_output_missing");
  }
  const output = parts.map(object).filter((part) =>
    typeof part.text === "string" && part.thought !== true
  )
    .map((part) => part.text as string).join("");
  if (!output) throw new Error("source_gemini_media_output_missing");
  return output;
}

export interface SourceGeminiConfig {
  apiKey: string;
  model: string;
  fallbackApiKeys?: readonly string[];
}
export interface SourceGeminiDependencies {
  fetch?: typeof fetch;
  download?: typeof downloadInstagramMedia;
  remove?: typeof removeDownloadedMedia;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: AiLog;
  state?: GeminiApiKeyStateStore;
  inlineMediaMaxBytes?: number;
}

interface UploadedFile {
  name: string;
  uri: string;
  mimeType: string;
}

export function createSourceGeminiClient(
  config: SourceGeminiConfig,
  dependencies: SourceGeminiDependencies = {},
) {
  if (!config.apiKey.trim() || !config.model.trim()) {
    throw new AiConfigError("GEMINI_API_KEY and GEMINI_MODEL are required");
  }
  const request = dependencies.fetch ?? fetch;
  const download = dependencies.download ?? downloadInstagramMedia;
  const remove = dependencies.remove ?? removeDownloadedMedia;
  const sleep = dependencies.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;
  const inlineMediaMaxBytes = dependencies.inlineMediaMaxBytes ??
    INLINE_MEDIA_MAX_BYTES;
  const credentials = createGeminiCredentialPool(
    [config.apiKey, ...(config.fallbackApiKeys ?? [])],
    {
      log: dependencies.log,
      now,
      state: dependencies.state,
      overload: {
        cooldownMs: OVERLOAD_COOLDOWN_MS,
        isOverload: isTransientFailure,
      },
    },
  );

  function headersFor(apiKey: string): Record<string, string> {
    return { "x-goog-api-key": apiKey };
  }

  function transientRetryDelay(
    error: unknown,
    retry: number,
    maxRetries: number,
  ): number | null {
    if (retry >= maxRetries || !isTransientFailure(error)) return null;
    const delayMs = TRANSIENT_RETRY_DELAYS_MS[retry];
    if (!(error instanceof GeminiHttpStatusError)) return delayMs;
    const hintedMs = retryAfterMs(error.response, now()) ?? 0;
    return Math.min(Math.max(delayMs, hintedMs), MAX_RETRY_AFTER_MS);
  }

  // 마지막 key일 때만 같은 key로 재시도한다. 뒤에 key가 있으면 키 관리가 바로 다음 key로 넘긴다.
  function retriesFor(attempt: GeminiCredentialCall): number {
    return attempt.isLastCredential ? TRANSIENT_RETRY_DELAYS_MS.length : 0;
  }

  // 같은 키로 다시 보낼 오류이고 남은 시간 안에 한 번 더 기다릴 수 있을 때만 다시 보낸다.
  async function withTransientRetry<T>(
    operation: AiOperation,
    deadlineMs: number,
    requestTimeoutMs: number,
    maxRetries: number,
    call: () => Promise<T>,
  ): Promise<T> {
    for (let retry = 0;; retry++) {
      try {
        return await call();
      } catch (error) {
        const delayMs = transientRetryDelay(error, retry, maxRetries);
        if (
          delayMs === null || now() + delayMs + requestTimeoutMs > deadlineMs
        ) throw error;
        const failure = sourceGeminiFailure(operation, config.model, error);
        dependencies.log?.("ai_provider_retry_scheduled", {
          operation,
          provider: "gemini",
          model: config.model,
          ...(failure instanceof AiProviderError
            ? { failureKind: failure.kind }
            : {}),
          ...(error instanceof GeminiHttpStatusError
            ? { status: error.status }
            : {}),
          attemptCount: retry + 1,
          durationMs: delayMs,
        });
        await sleep(delayMs);
      }
    }
  }

  async function deleteFile(name: string, apiKey: string): Promise<void> {
    if (!/^files\/[A-Za-z0-9_-]+$/.test(name)) return;
    try {
      await mediaHttp(
        request,
        `${BASE}/v1beta/${name}`,
        { method: "DELETE", headers: headersFor(apiKey) },
        MEDIA_TIMEOUT_MS,
        async (response) => {
          await response.body?.cancel();
          if (!response.ok) throw new Error("source_gemini_file_delete_failed");
        },
      );
    } catch {
      console.warn(
        JSON.stringify({ event: "source_gemini_file_cleanup_failed" }),
      );
    }
  }

  async function upload(
    media: DownloadedInstagramMedia,
    apiKey: string,
  ): Promise<UploadedFile> {
    let name: string | null = null;
    try {
      const session = await mediaHttp(
        request,
        `${BASE}/upload/v1beta/files`,
        {
          method: "POST",
          headers: {
            ...headersFor(apiKey),
            "Content-Type": "application/json",
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(media.size),
            "X-Goog-Upload-Header-Content-Type": media.mimeType,
          },
          body: JSON.stringify({ file: { display_name: "yeogidam-media" } }),
        },
        MEDIA_TIMEOUT_MS,
        async (response) => {
          const location = response.headers.get("X-Goog-Upload-URL");
          const granularity = Number(
            response.headers.get("X-Goog-Upload-Chunk-Granularity") ?? "1",
          );
          await response.body?.cancel();
          if (!response.ok) {
            throw new GeminiHttpStatusError(
              response,
              null,
              undefined,
              "source_gemini_upload_start_failed",
            );
          }
          if (!location) throw new Error("source_gemini_upload_start_failed");
          const url = new URL(location);
          if (
            url.origin !== BASE || url.username || url.password
          ) throw new Error("source_gemini_upload_url_invalid");
          if (
            !Number.isSafeInteger(granularity) || granularity < 1 ||
            granularity > UPLOAD_CHUNK_BYTES
          ) {
            throw new Error("source_gemini_upload_granularity_invalid");
          }
          return {
            url: url.href,
            chunkSize: Math.floor(UPLOAD_CHUNK_BYTES / granularity) *
              granularity,
          };
        },
      );
      const payload = await uploadSourceMediaBytes(request, session, media);
      let file = object(object(payload).file);
      name = typeof file.name === "string" ? file.name : null;
      if (!name || !/^files\/[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error("source_gemini_file_name_invalid");
      }
      const deadline = now() + PROCESSING_TIMEOUT_MS;
      while (file.state === "PROCESSING") {
        if (now() >= deadline) {
          throw new Error("source_gemini_file_processing_timeout");
        }
        await sleep(1000);
        file = object(
          await geminiJson(
            request,
            `${BASE}/v1beta/${name}`,
            { headers: headersFor(apiKey) },
            MEDIA_TIMEOUT_MS,
          ),
        );
      }
      if (file.state !== "ACTIVE" || !nonblank(file.uri)) {
        throw new Error("source_gemini_file_not_active");
      }
      return { name, uri: file.uri, mimeType: media.mimeType };
    } catch (error) {
      if (name) await deleteFile(name, apiKey);
      throw error;
    }
  }

  return {
    name: "gemini" as const,
    async extractCaption(caption: string): Promise<SourcePlaceHint[]> {
      if (!caption.trim()) throw new Error("source_gemini_caption_empty");
      const operation = "SOURCE_CAPTION_ANALYSIS";
      const deadlineMs = now() + CAPTION_BUDGET_MS;
      try {
        return await credentials.run(
          operation,
          config.model,
          (apiKey, attempt) =>
            withTransientRetry(
              operation,
              deadlineMs,
              CAPTION_TIMEOUT_MS,
              retriesFor(attempt),
              async () => {
                const payload = await geminiJson(
                  request,
                  `${BASE}/v1/interactions`,
                  {
                    method: "POST",
                    headers: {
                      ...headersFor(apiKey),
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      model: config.model,
                      store: false,
                      system_instruction: SOURCE_CAPTION_INSTRUCTION,
                      input: sourceCaptionInput(caption),
                      tools: [{ type: "url_context" }],
                      response_format: {
                        type: "text",
                        mime_type: "application/json",
                        schema: SOURCE_HINTS_SCHEMA,
                      },
                    }),
                  },
                  CAPTION_TIMEOUT_MS,
                );
                return parseSourcePlaceHints(
                  JSON.parse(captionOutput(payload)),
                );
              },
            ),
        );
      } catch (error) {
        throw sourceGeminiFailure(operation, config.model, error);
      }
    },
    async extractMedia(
      caption: string,
      url: string,
    ): Promise<SourcePlaceHint[]> {
      if (!caption.trim()) throw new Error("source_gemini_caption_empty");
      const operation = "SOURCE_MEDIA_ANALYSIS";
      const deadlineMs = now() + MEDIA_BUDGET_MS;
      const downloaded = await download(url, request);
      try {
        // 원본이 작으면 요청 본문에 실어 보내 업로드와 ACTIVE 대기, 삭제를 건너뛴다. 이때는 파일이
        // key에 묶이지 않아 key를 바꿔도 다시 올리지 않는다. 크면 Files API로 올리고, 올린 파일은
        // 그 key의 구글 프로젝트에 묶이므로 key를 바꾸면 같은 원본을 새 key로 다시 올린다.
        const totalBytes = downloaded.reduce(
          (sum, media) => sum + media.size,
          0,
        );
        const inlineParts = totalBytes <= inlineMediaMaxBytes
          ? await Promise.all(downloaded.map(async (media) => ({
            inlineData: {
              mimeType: media.mimeType,
              data: encodeBase64(await Deno.readFile(media.path)),
            },
          })))
          : null;
        // 다른 key로 다시 보낼 때만 남은 시간을 보고, 첫 시도는 예전과 같이 진행한다.
        let keyAttempts = 0;
        return await credentials.run(
          operation,
          config.model,
          async (apiKey, attempt) => {
            if (keyAttempts++ > 0 && now() + MEDIA_TIMEOUT_MS > deadlineMs) {
              throw new AiProviderError("gemini", operation, "TIMEOUT", {
                model: config.model,
                retryable: true,
              });
            }
            const analyze = (mediaParts: unknown[]) =>
              withTransientRetry(
                operation,
                deadlineMs,
                MEDIA_TIMEOUT_MS,
                retriesFor(attempt),
                async () => {
                  const payload = await geminiJson(
                    request,
                    `${BASE}/v1beta/models/${
                      encodeURIComponent(config.model)
                    }:generateContent`,
                    {
                      method: "POST",
                      headers: {
                        ...headersFor(apiKey),
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify(
                        mediaRequestBody(caption, mediaParts),
                      ),
                    },
                    MEDIA_TIMEOUT_MS,
                  );
                  return parseSourcePlaceHints(
                    JSON.parse(mediaOutput(payload)),
                  );
                },
              );
            if (inlineParts) return await analyze(inlineParts);

            const uploaded: UploadedFile[] = [];
            try {
              for (const media of downloaded) {
                uploaded.push(await upload(media, apiKey));
              }
              return await analyze(uploaded.map((file) => ({
                fileData: { fileUri: file.uri, mimeType: file.mimeType },
              })));
            } finally {
              for (const file of uploaded) await deleteFile(file.name, apiKey);
            }
          },
        );
      } catch (error) {
        throw sourceGeminiFailure(operation, config.model, error);
      } finally {
        await remove(downloaded);
      }
    },
  };
}
