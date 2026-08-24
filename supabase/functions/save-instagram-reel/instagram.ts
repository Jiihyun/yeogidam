// Instagram 공개 페이지 HTML head에서 링크 미리보기 메타데이터를 추출한다.

export interface InstagramMeta {
  description: string | null;
  authorUsername: string | null;
  thumbnailUrl: string | null;
  canonicalUrl: string | null;
}

const INSTAGRAM_USERNAME = "[A-Za-z0-9._]{1,30}";
const INSTAGRAM_ENGLISH_DATE =
  "(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2},\\s+\\d{4}";
const INSTAGRAM_ENGAGEMENT_COUNT = "\\d[\\d.,]*[KMB]?";
const AUTHOR_PREFIX_PATTERNS = [
  new RegExp(
    `\\(@(${INSTAGRAM_USERNAME})\\)\\s*[•·]\\s*Instagram\\b`,
    "i",
  ),
  new RegExp(
    `^\\s*@?(${INSTAGRAM_USERNAME})\\s*-\\s*${INSTAGRAM_ENGLISH_DATE}\\s*:`,
    "i",
  ),
  new RegExp(
    `^\\s*${INSTAGRAM_ENGAGEMENT_COUNT}\\s+likes?,\\s*${INSTAGRAM_ENGAGEMENT_COUNT}\\s+comments?\\s*-\\s*@?(${INSTAGRAM_USERNAME})\\s+on\\s+${INSTAGRAM_ENGLISH_DATE}\\s*:`,
    "i",
  ),
];

// twitter:title의 `Name (@username) • Instagram ...`을 우선 인식하고,
// 과거 description wrapper도 fallback으로 지원한다. 캡션 본문의 첫 @mention은
// 장소나 협찬 계정일 수 있으므로 작성자로 추측하지 않는다.
export function parseInstagramAuthorUsername(
  metadataText: string | null,
): string | null {
  if (!metadataText) return null;
  for (const pattern of AUTHOR_PREFIX_PATTERNS) {
    const username = metadataText.match(pattern)?.[1];
    if (username) return username.toLowerCase();
  }
  return null;
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
  const twitterTitle = metaContent(html, [
    { attribute: "name", value: "twitter:title" },
  ]);
  const openGraphTitle = metaContent(html, [
    { attribute: "property", value: "og:title" },
  ]);
  const openGraphDescription = metaContent(html, [
    { attribute: "property", value: "og:description" },
  ]);
  const genericDescription = metaContent(html, [
    { attribute: "name", value: "description" },
  ]);
  const twitterDescription = metaContent(html, [
    { attribute: "name", value: "twitter:description" },
  ]);
  const description = openGraphDescription ?? genericDescription ??
    twitterDescription;
  return {
    description,
    authorUsername: parseInstagramAuthorUsername(twitterTitle) ??
      parseInstagramAuthorUsername(openGraphTitle) ??
      parseInstagramAuthorUsername(openGraphDescription) ??
      parseInstagramAuthorUsername(genericDescription) ??
      parseInstagramAuthorUsername(twitterDescription),
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
    "User-Agent": "Twitterbot/1.0",
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
  return parseInstagramMeta(html);
}
