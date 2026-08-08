// Instagram 공개 페이지 HTML 을 가져와 og:* 메타데이터를 추출한다 (코드 처리).
// 인스타그램이 비로그인 요청을 차단/캡션 누락하는 경우가 많으므로 베스트에포트.

export interface InstagramMeta {
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  canonicalUrl: string | null;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function metaContent(html: string, property: string): string | null {
  const re1 = new RegExp(
    `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`,
    "i",
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`,
    "i",
  );
  const m = html.match(re1) ?? html.match(re2);
  return m ? decodeHtml(m[1]) : null;
}

export async function fetchInstagramMeta(url: string): Promise<InstagramMeta> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "ko,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`instagram fetch failed: ${res.status}`);
  const html = await res.text();
  return {
    title: metaContent(html, "og:title"),
    description: metaContent(html, "og:description"),
    thumbnailUrl: metaContent(html, "og:image"),
    canonicalUrl: metaContent(html, "og:url"),
  };
}
