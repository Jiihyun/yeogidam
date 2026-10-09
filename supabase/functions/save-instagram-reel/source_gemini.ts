// 2026-Yeogidam GeminiPlaceNameExtractor / GeminiFileClient의 이식.
import { AiConfigError } from "./ai/errors.ts";
import {
  type DownloadedInstagramMedia,
  downloadInstagramMedia,
  removeDownloadedMedia,
} from "./instagram_media.ts";
import { mediaHttp, sourceJson } from "./media_http.ts";
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
            throw new Error(`source_analysis_http_${response.status}`);
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
}
export interface SourceGeminiDependencies {
  fetch?: typeof fetch;
  download?: typeof downloadInstagramMedia;
  remove?: typeof removeDownloadedMedia;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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
  const headers = { "x-goog-api-key": config.apiKey };

  async function deleteFile(name: string): Promise<void> {
    if (!/^files\/[A-Za-z0-9_-]+$/.test(name)) return;
    try {
      await mediaHttp(
        request,
        `${BASE}/v1beta/${name}`,
        { method: "DELETE", headers },
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
  ): Promise<UploadedFile> {
    let name: string | null = null;
    try {
      const session = await mediaHttp(
        request,
        `${BASE}/upload/v1beta/files`,
        {
          method: "POST",
          headers: {
            ...headers,
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
          if (!response.ok || !location) {
            throw new Error("source_gemini_upload_start_failed");
          }
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
          await sourceJson(
            request,
            `${BASE}/v1beta/${name}`,
            { headers },
            MEDIA_TIMEOUT_MS,
          ),
        );
      }
      if (file.state !== "ACTIVE" || !nonblank(file.uri)) {
        throw new Error("source_gemini_file_not_active");
      }
      return { name, uri: file.uri, mimeType: media.mimeType };
    } catch (error) {
      if (name) await deleteFile(name);
      throw error;
    }
  }

  return {
    async extractCaption(caption: string): Promise<SourcePlaceHint[]> {
      if (!caption.trim()) throw new Error("source_gemini_caption_empty");
      const payload = await sourceJson(request, `${BASE}/v1/interactions`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
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
      }, CAPTION_TIMEOUT_MS);
      return parseSourcePlaceHints(JSON.parse(captionOutput(payload)));
    },
    async extractMedia(
      caption: string,
      url: string,
    ): Promise<SourcePlaceHint[]> {
      if (!caption.trim()) throw new Error("source_gemini_caption_empty");
      const downloaded = await download(url, request);
      const uploaded: UploadedFile[] = [];
      try {
        for (const media of downloaded) uploaded.push(await upload(media));
        const payload = await sourceJson(
          request,
          `${BASE}/v1beta/models/${
            encodeURIComponent(config.model)
          }:generateContent`,
          {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: SOURCE_MEDIA_INSTRUCTION }],
              },
              contents: [{
                role: "user",
                parts: [
                  { text: sourceCaptionInput(caption) },
                  ...uploaded.map((file) => ({
                    fileData: { fileUri: file.uri, mimeType: file.mimeType },
                  })),
                ],
              }],
              tools: [{ urlContext: {} }],
              generationConfig: {
                responseMimeType: "application/json",
                responseJsonSchema: SOURCE_HINTS_SCHEMA,
                mediaResolution: "MEDIA_RESOLUTION_HIGH",
              },
            }),
          },
          MEDIA_TIMEOUT_MS,
        );
        return parseSourcePlaceHints(JSON.parse(mediaOutput(payload)));
      } finally {
        try {
          for (const file of uploaded) await deleteFile(file.name);
        } finally {
          await remove(downloaded);
        }
      }
    },
  };
}
