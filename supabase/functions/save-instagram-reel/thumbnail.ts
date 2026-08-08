// 썸네일 처리: 네이버 대표 이미지(베스트에포트 스크래핑) → Storage 재호스팅.
// CDN URL 만료를 막기 위해 선택된 이미지를 Supabase Storage 에 다시 올린다.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

// 네이버 place 링크 페이지의 og:image 를 베스트에포트로 긁는다. 실패하면 null.
export async function scrapeNaverImage(link: string | null): Promise<string | null> {
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
    return supabase.storage.from("place-thumbnails").getPublicUrl(path).data.publicUrl;
  } catch {
    return null;
  }
}
