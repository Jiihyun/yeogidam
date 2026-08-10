// Instagram 공개 페이지 HTML 을 가져와 og:* 메타데이터를 추출한다 (코드 처리).
// 인스타그램이 비로그인 요청을 차단/캡션 누락하는 경우가 많으므로 베스트에포트.

export interface InstagramMeta {
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  canonicalUrl: string | null;
}

interface InstagramOEmbed {
  author_name?: unknown;
  thumbnail_url?: unknown;
  title?: unknown;
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
  for (const tag of html.match(/<meta\b[^>]*>/gis) ?? []) {
    for (const candidate of candidates) {
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
    title: metaContent(html, [
      { attribute: "property", value: "og:title" },
      { attribute: "name", value: "twitter:title" },
    ]),
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

export function parseInstagramOEmbed(
  data: InstagramOEmbed,
  canonicalUrl: string,
): InstagramMeta | null {
  const author = typeof data.author_name === "string"
    ? data.author_name.trim()
    : "";
  const description = typeof data.title === "string" ? data.title.trim() : "";
  const thumbnailUrl = typeof data.thumbnail_url === "string"
    ? data.thumbnail_url.trim()
    : "";
  if (!description) return null;

  return {
    title: author ? `${author}의 Instagram 릴스` : null,
    description,
    thumbnailUrl: thumbnailUrl || null,
    canonicalUrl,
  };
}

export function parseInstagramEmbedCaption(html: string): string | null {
  const match = html.match(
    /<div\b[^>]*class=["']Caption["'][^>]*>([\s\S]*?)(?:<div\b[^>]*class=["']CaptionComments["']|<\/div>\s*<\/div>)/i,
  );
  if (!match) return null;

  const text = decodeHtml(
    match[1]
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return text || null;
}

function embedCaptionUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/embed/captioned/`;
  return parsed.toString();
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

  // The reel page head is the primary caption source.
  const res = await request(url, {
    headers: {
      ...headers,
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`instagram fetch failed: ${res.status}`);
  const html = await res.text();
  const meta = parseInstagramMeta(html);
  if (meta.description) return meta;

  const oEmbedUrl = new URL("https://www.instagram.com/api/v1/oembed/");
  oEmbedUrl.searchParams.set("url", url);
  const oEmbedRes = await request(oEmbedUrl, { headers, redirect: "follow" });
  if (oEmbedRes.ok) {
    const oEmbed = parseInstagramOEmbed(await oEmbedRes.json(), url);
    if (oEmbed) {
      return {
        title: meta.title ?? oEmbed.title,
        description: oEmbed.description,
        thumbnailUrl: meta.thumbnailUrl ?? oEmbed.thumbnailUrl,
        canonicalUrl: meta.canonicalUrl ?? oEmbed.canonicalUrl,
      };
    }
  }

  const embedRes = await request(embedCaptionUrl(url), {
    headers,
    redirect: "follow",
  });
  if (!embedRes.ok) {
    throw new Error(`instagram embed fetch failed: ${embedRes.status}`);
  }
  const description = parseInstagramEmbedCaption(await embedRes.text());
  if (!description) throw new Error("instagram metadata empty");

  return { ...meta, description };
}
