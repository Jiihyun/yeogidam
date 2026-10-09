// 2026-Yeogidam InstagramMediaSourceReader / InstagramMediaDownloader의 이식.
import { mediaHttp } from "./media_http.ts";

export interface InstagramMediaSource {
  url: string;
  type: "image" | "video";
}

export interface DownloadedInstagramMedia {
  path: string;
  mimeType: string;
  size: number;
}

type Json = Record<string, unknown>;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_ITEMS = 20;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS = {
  "User-Agent": "Mozilla/5.0",
  "Accept-Language": "ko,en;q=0.9",
};

function object(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : null;
}

function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findPost(value: unknown, shortcode: string, depth = 0): Json | null {
  if (value == null || depth > 80) return null;
  if (typeof value === "string") {
    return findPost(json(value), shortcode, depth + 1);
  }
  const node = object(value);
  if (
    node && (node.shortcode === shortcode || node.code === shortcode) &&
    [
      "display_url",
      "image_versions2",
      "video_versions",
      "edge_sidecar_to_children",
      "carousel_media",
    ].some((key) => key in node)
  ) {
    return node;
  }
  if (typeof value !== "object") return null;
  for (const child of Object.values(value)) {
    const post = findPost(child, shortcode, depth + 1);
    if (post) return post;
  }
  return null;
}

function scriptJson(script: string): unknown {
  if (script.trim().startsWith("{")) return json(script.trim());
  const handle = script.indexOf(".handle(");
  if (handle < 0) return null;
  const start = script.indexOf("{", handle);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < script.length; index++) {
    const character = script[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "{") depth++;
    if (character === "}" && --depth === 0) {
      return json(script.slice(start, index + 1));
    }
  }
  return null;
}

function mediaSource(value: unknown): InstagramMediaSource {
  const media = object(value);
  if (!media) throw new Error("instagram_media_missing");
  const video = media.is_video === true || media.media_type === 2 ||
    media.__typename === "GraphVideo";
  const direct = video ? media.video_url : media.display_url;
  let url = typeof direct === "string" && direct.trim() ? direct : null;
  if (!url) {
    const versions = video ? media.video_versions : media.image_versions2;
    const candidates = object(versions)?.candidates ?? versions;
    const candidate = Array.isArray(candidates)
      ? object(candidates[0])?.url
      : null;
    url = typeof candidate === "string" && candidate.trim() ? candidate : null;
  }
  if (!url) throw new Error("instagram_media_original_missing");
  return { url: new URL(url).href, type: video ? "video" : "image" };
}

function postSources(post: Json): InstagramMediaSource[] {
  const edges = object(post.edge_sidecar_to_children)?.edges;
  if (Array.isArray(edges)) {
    return edges.map((edge) => mediaSource(object(edge)?.node));
  }
  if (Array.isArray(post.carousel_media)) {
    return post.carousel_media.map(mediaSource);
  }
  if (post.__typename === "GraphSidecar" || post.media_type === 8) {
    throw new Error("instagram_carousel_originals_missing");
  }
  return [mediaSource(post)];
}

export function parseInstagramMediaSources(
  html: string,
  shortcode: string,
): InstagramMediaSource[] {
  for (const script of html.matchAll(/<script\b[^>]*>(.*?)<\/script>/gs)) {
    const post = findPost(scriptJson(script[1]), shortcode);
    if (post) return postSources(post);
  }
  return [];
}

export function validateInstagramMediaSources(
  url: string,
  sources: InstagramMediaSource[],
): void {
  if (!sources.length || sources.length > MAX_ITEMS) {
    throw new Error("instagram_media_count_invalid");
  }
  if (
    new URL(url).pathname.startsWith("/reel/") &&
    (sources.length !== 1 || sources[0].type !== "video")
  ) {
    throw new Error("instagram_reel_original_missing");
  }
}

async function page(request: typeof fetch, url: string): Promise<string> {
  return await mediaHttp(
    request,
    url,
    { headers: HEADERS },
    REQUEST_TIMEOUT_MS,
    async (response) => {
      if (!response.ok) {
        throw new Error(
          `instagram_page_http_${response.status}`,
        );
      }
      return await response.text();
    },
  );
}

function mediaId(shortcode: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let value = 0n;
  for (const character of shortcode) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("instagram_shortcode_invalid");
    value = value * 64n + BigInt(index);
  }
  return value.toString();
}

export async function readInstagramMediaSources(
  url: string,
  request: typeof fetch = fetch,
): Promise<InstagramMediaSource[]> {
  const path = new URL(url).pathname.replace(/\/$/, "");
  const shortcode = path.split("/").at(-1)!;
  const canonical = `https://www.instagram.com${path}`;
  // 원본과 같이 embed 조회 실패/불완전 응답이면 공개 페이지로 진행한다.
  try {
    const sources = parseInstagramMediaSources(
      await page(request, `${canonical}/embed/`),
      shortcode,
    );
    if (sources.length) return sources;
  } catch { /* 공개 페이지에서 재조회 */ }

  const html = await page(request, `${canonical}/`);
  try {
    const sources = parseInstagramMediaSources(html, shortcode);
    if (sources.length) return sources;
  } catch { /* 원본과 동일하게 공개 GraphQL 조회 시도 */ }
  const token = html.match(/\["LSD",\[\],\{"token":"([^"]+)"/)?.[1];
  if (!token) throw new Error("instagram_media_originals_unavailable");
  const form = new URLSearchParams({
    lsd: token,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "PolarisLoggedOutDesktopWWWPostRootContentQuery",
    server_timestamps: "true",
    variables: JSON.stringify({ media_id: mediaId(shortcode) }),
    doc_id: "27130156389949648",
  });
  const payload = await mediaHttp(
    request,
    "https://www.instagram.com/api/graphql",
    {
      method: "POST",
      headers: {
        ...HEADERS,
        "X-FB-LSD": token,
        "X-IG-App-ID": "936619743392459",
        Referer: `${canonical}/`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    },
    REQUEST_TIMEOUT_MS,
    async (response) => {
      if (!response.ok) {
        throw new Error(
          `instagram_query_http_${response.status}`,
        );
      }
      return json(await response.text());
    },
  );
  const post = findPost(payload, shortcode);
  if (!post) throw new Error("instagram_media_originals_unavailable");
  const sources = postSources(post);
  if (!sources.length) throw new Error("instagram_media_originals_unavailable");
  return sources;
}

function validateCdnUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || url.username || url.password ||
    (url.port && url.port !== "443") ||
    (!url.hostname.endsWith(".cdninstagram.com") &&
      !url.hostname.endsWith(".fbcdn.net"))
  ) {
    throw new Error("instagram_media_cdn_invalid");
  }
}

export async function removeDownloadedMedia(
  files: DownloadedInstagramMedia[],
): Promise<void> {
  for (const file of files) {
    try {
      await Deno.remove(file.path);
    } catch {
      console.warn(JSON.stringify({ event: "source_media_cleanup_failed" }));
    }
  }
}

export async function downloadInstagramMedia(
  url: string,
  request: typeof fetch = fetch,
): Promise<DownloadedInstagramMedia[]> {
  const downloaded: DownloadedInstagramMedia[] = [];
  try {
    const sources = await readInstagramMediaSources(url, request);
    validateInstagramMediaSources(url, sources);
    let total = 0;
    for (const source of sources) {
      validateCdnUrl(source.url);
      const limit = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total);
      const path = await Deno.makeTempFile({
        dir: "/tmp",
        prefix: "yeogidam-media-",
        suffix: ".bin",
      });
      try {
        const media = await mediaHttp(
          request,
          source.url,
          { redirect: "manual" },
          REQUEST_TIMEOUT_MS,
          async (response, signal) => {
            let currentUrl = source.url;
            for (
              let redirects = 0;
              [301, 302, 303, 307, 308].includes(response.status);
              redirects++
            ) {
              const location = response.headers.get("Location");
              await response.body?.cancel();
              if (!location || redirects >= 20) {
                throw new Error("instagram_media_redirect_invalid");
              }
              currentUrl = new URL(location, currentUrl).href;
              validateCdnUrl(currentUrl);
              response = await request(currentUrl, {
                redirect: "manual",
                signal,
              });
            }
            if (!response.ok) {
              throw new Error(`instagram_download_http_${response.status}`);
            }
            if (
              Number(response.headers.get("Content-Length")) > limit
            ) throw new Error("instagram_media_size_limit");
            const mimeType = response.headers.get("Content-Type")?.split(
              ";",
              1,
            )[0].trim();
            if (!mimeType?.startsWith(`${source.type}/`)) {
              throw new Error("instagram_media_type_invalid");
            }
            if (!response.body) throw new Error("instagram_media_empty");
            const file = await Deno.open(path, { write: true, truncate: true });
            let size = 0;
            const bounded = new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                size += chunk.byteLength;
                if (size > limit) throw new Error("instagram_media_size_limit");
                controller.enqueue(chunk);
              },
            });
            await response.body.pipeThrough(bounded).pipeTo(file.writable, {
              signal,
            });
            if (!size) throw new Error("instagram_media_empty");
            return { path, mimeType, size };
          },
        );
        downloaded.push(media);
        total += media.size;
      } catch (error) {
        await removeDownloadedMedia([{ path, mimeType: "", size: 0 }]);
        throw error;
      }
    }
    return downloaded;
  } catch (error) {
    await removeDownloadedMedia(downloaded);
    throw error;
  }
}
