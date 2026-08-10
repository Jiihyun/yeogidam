// 썸네일 처리: 외부 이미지 URL → Storage 재호스팅.
// MVP 에서는 Google Places / Instagram / Kakao 후보 이미지를 Supabase Storage 에 다시 올린다.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

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
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const ext = contentType.includes("png") ? "png" : "jpg";
    const buf = new Uint8Array(await res.arrayBuffer());
    const path = `${key}.${ext}`;
    const { error } = await supabase.storage
      .from("place-thumbnails")
      .upload(path, buf, { contentType, upsert: true });
    if (error) return null;
    return publicStorageUrl(path);
  } catch {
    return null;
  }
}
