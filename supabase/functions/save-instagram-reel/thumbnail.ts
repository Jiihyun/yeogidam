// 썸네일 처리: 외부 이미지 URL → Storage 재호스팅.
// MVP 에서는 Google Places / Instagram / Kakao 후보 이미지를 Supabase Storage 에 다시 올린다.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { Image as ThumbImage } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

// 리사이즈 규격: 앱의 최대 표시 크기(3배율 기준)를 넉넉히 덮는 긴 변 길이.
const MAX_DIMENSION = 640;
const JPEG_QUALITY = 78;

// 원본 이미지를 긴 변 기준 MAX_DIMENSION 이하로 줄여 JPEG 로 재인코딩한다.
// 디코딩 실패(GIF·손상 파일 등)나 축소 효과가 없으면 null 을 반환해 원본 업로드로 돌아간다.
async function shrinkImage(buf: Uint8Array): Promise<Uint8Array | null> {
  try {
    const decoded = await ThumbImage.decode(buf);
    const scale = MAX_DIMENSION / Math.max(decoded.width, decoded.height);
    if (scale < 1) {
      decoded.resize(
        Math.max(1, Math.round(decoded.width * scale)),
        Math.max(1, Math.round(decoded.height * scale)),
      );
    }
    const encoded = await decoded.encodeJPEG(JPEG_QUALITY);
    return encoded.byteLength < buf.byteLength ? encoded : null;
  } catch {
    return null;
  }
}

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// 사진 게시물(/p/)의 og:image 는 인스타가 정사각으로 잘라서 준다.
// embed 페이지(외부 사이트 삽입용, 로그인 불필요)의 display_url 에는 원본 비율
// 이미지 주소가 들어 있어 이를 우선 시도한다. 실패하면 null(호출부가 og:image 로 폴백).
export async function fetchEmbedDisplayUrl(
  postUrl: string,
): Promise<string | null> {
  try {
    const base = postUrl.split(/[?#]/)[0].replace(/\/$/, "");
    const res = await fetch(`${base}/embed/`, {
      headers: { "User-Agent": MOBILE_UA },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    // 이중 이스케이프된 JSON 안의 \"display_url\":\"...\" 을 찾는다.
    const m = html.match(/display_url\\+"\s*:\s*\\+"(.+?)\\+"/);
    if (!m) return null;
    let url = m[1]
      .replace(
        /\\+u([0-9a-fA-F]{4})/g,
        (_, hex: string) => String.fromCharCode(parseInt(hex, 16)),
      )
      .replace(/\\+\//g, "/");
    return url.startsWith("https://") ? url : null;
  } catch {
    return null;
  }
}

function publicStorageUrl(path: string): string {
  const configured = Deno.env.get("PUBLIC_SUPABASE_URL") ??
    Deno.env.get("SUPABASE_URL");
  const base = configured?.replace(/\/$/, "");
  if (!base) return path;
  return `${base}/storage/v1/object/public/place-thumbnails/${path}`;
}

// 장소 상세 페이지의 og:image를 베스트에포트로 읽는다. 실패하면 null.
export async function scrapePageImage(
  link: string | null,
): Promise<string | null> {
  if (!link) return null;
  try {
    const res = await fetch(link, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    );
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// 이미지 URL 을 다운로드해 place-thumbnails 버킷에 올리고 공개 URL 을 반환한다.
export async function rehostThumbnail(
  supabase: SupabaseClient,
  key: string,
  imageUrl: string,
): Promise<string | null> {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn(JSON.stringify({
        event: "thumbnail_rehost_failed",
        stage: "download",
        key,
        status: res.status,
      }));
      return null;
    }
    const originalType = res.headers.get("content-type") ?? "image/jpeg";
    const original = new Uint8Array(await res.arrayBuffer());

    // 긴 변 640px JPEG 로 줄여 저장 트래픽을 낮춘다. 실패하면 원본 그대로 올린다.
    const shrunk = await shrinkImage(original);
    const buf = shrunk ?? original;
    const contentType = shrunk ? "image/jpeg" : originalType;
    const ext = contentType.includes("png") ? "png" : "jpg";
    const path = `${key}.${ext}`;
    if (shrunk) {
      console.log(JSON.stringify({
        event: "thumbnail_resized",
        key,
        before: original.byteLength,
        after: shrunk.byteLength,
      }));
    }
    const { error } = await supabase.storage
      .from("place-thumbnails")
      .upload(path, buf, {
        contentType,
        upsert: true,
        // key 가 내용에 묶여 있어 파일이 바뀌면 경로도 바뀐다. 캐시는 1년으로 고정한다.
        // (미설정 시 기본값 1시간이라 클라이언트가 매시간 재다운로드하던 것이 과다 트래픽의 원인이었다)
        cacheControl: "31536000",
      });
    if (error) {
      console.warn(JSON.stringify({
        event: "thumbnail_rehost_failed",
        stage: "storage_upload",
        key,
        message: error.message,
      }));
      return null;
    }
    return publicStorageUrl(path);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "thumbnail_rehost_failed",
      stage: "unexpected",
      key,
      message: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}
