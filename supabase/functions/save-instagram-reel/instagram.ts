// Instagram 공개 페이지 HTML head에서 링크 미리보기 메타데이터를 추출한다.

export interface InstagramMeta {
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
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, code) => String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "is"),
  );
  return match?.[2] ?? null;
}

function metaContent(
  html: string,
  candidates: Array<{ attribute: "name" | "property"; value: string }>,
): string | null {
  const tags = html.match(/<meta\b[^>]*>/gis) ?? [];
  for (const candidate of candidates) {
    for (const tag of tags) {
      if (
        attribute(tag, candidate.attribute)?.toLowerCase() ===
          candidate.value.toLowerCase()
      ) {
        const content = attribute(tag, "content");
        if (content) return decodeHtml(content).trim();
      }
    }
  }
  return null;
}

export function parseInstagramMeta(html: string): InstagramMeta {
  return {
    description: metaContent(html, [
      { attribute: "property", value: "og:description" },
      { attribute: "name", value: "description" },
      { attribute: "name", value: "twitter:description" },
    ]),
    thumbnailUrl: metaContent(html, [
      { attribute: "property", value: "og:image" },
      { attribute: "name", value: "twitter:image" },
    ]),
    canonicalUrl: metaContent(html, [
      { attribute: "property", value: "og:url" },
    ]),
  };
}

export async function fetchInstagramMeta(
  url: string,
  request: typeof fetch = fetch,
): Promise<InstagramMeta> {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "ko,en;q=0.9",
  };

  const res = await request(url, {
    headers: {
      ...headers,
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`instagram fetch failed: ${res.status}`);
  const html = await res.text();
  const meta = parseInstagramMeta(html);
  if (!meta.description) throw new Error("instagram metadata empty");
  return meta;
}
