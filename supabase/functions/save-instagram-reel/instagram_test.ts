import {
  fetchInstagramMeta,
  parseInstagramAuthorUsername,
  parseInstagramMeta,
} from "./instagram.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("parses Instagram name description metadata", () => {
  const html = `<head>
    <meta name="description" content="opetion_h - August 9, 2026: &quot;무화과 디저트와 ‘보연희’를 소개해요. 📍보연희 서울 서대문구 연희맛로 17-63 2층&quot;. ">
  </head>`;

  const meta = parseInstagramMeta(html);

  assertEquals(
    meta.description,
    'opetion_h - August 9, 2026: "무화과 디저트와 ‘보연희’를 소개해요. 📍보연희 서울 서대문구 연희맛로 17-63 2층".',
  );
  assertEquals(meta.authorUsername, "opetion_h");
});

Deno.test("prefers the username in twitter title metadata", () => {
  const meta = parseInstagramMeta(`<head>
    <meta name="twitter:title" content="쏙 sssOK (@ssssok_app) • Instagram 사진 및 동영상">
    <meta property="og:description" content="other_author - August 9, 2026: &quot;오늘의 카페&quot;">
  </head>`);

  assertEquals(meta.authorUsername, "ssssok_app");
});

Deno.test("falls back to og title when twitter title has no username", () => {
  const meta = parseInstagramMeta(`<head>
    <meta name="twitter:title" content="Instagram">
    <meta property="og:title" content="쏙 sssOK (@ssssok_app) • Instagram 사진 및 동영상">
  </head>`);

  assertEquals(meta.authorUsername, "ssssok_app");
});

Deno.test("checks each description source for an author wrapper", () => {
  const meta = parseInstagramMeta(`<head>
    <meta property="og:description" content="오늘의 카페">
    <meta name="description" content="Cafe.Owner - August 10, 2026: &quot;오늘의 카페&quot;">
  </head>`);

  assertEquals(meta.description, "오늘의 카페");
  assertEquals(meta.authorUsername, "cafe.owner");
});

Deno.test("parses author from Instagram engagement metadata", () => {
  const meta = parseInstagramMeta(`<head>
    <meta property="og:description" content="1,234 likes, 1 comment - Cafe.Owner on August 10, 2026: &quot;오늘의 카페&quot;">
  </head>`);

  assertEquals(meta.authorUsername, "cafe.owner");
});

Deno.test("does not treat caption mentions as the reel author", () => {
  assertEquals(
    parseInstagramAuthorUsername(
      "오늘은 @place_account에 다녀왔어요. August 9, 2026",
    ),
    null,
  );
  assertEquals(
    parseInstagramAuthorUsername("place_account - 오늘의 카페를 소개해요"),
    null,
  );
});

Deno.test("parses image attributes in either order", () => {
  const html = `<head>
    <meta content='https://example.com/photo.jpg' name='twitter:image'>
  </head>`;

  const meta = parseInstagramMeta(html);

  assertEquals(meta.thumbnailUrl, "https://example.com/photo.jpg");
});

Deno.test("prefers the uncropped Twitter image regardless of tag order", () => {
  const original = "https://example.com/reel.jpg?stp=dst-jpg_s640x640";
  const cropped =
    "https://example.com/reel.jpg?stp=c0.572.1170.364a_dst-jpg_s400x320";
  const tags = [
    `<meta property="og:image" content="${cropped}">`,
    `<meta content="${original}" name="twitter:image">`,
  ];

  for (const order of [tags, [...tags].reverse()]) {
    const meta = parseInstagramMeta(`<head>${order.join("\n")}</head>`);
    assertEquals(meta.thumbnailUrl, original);
  }
});

Deno.test("falls back to the Open Graph image when Twitter image is absent or empty", () => {
  for (
    const twitterTag of [
      "",
      '<meta name="twitter:image" content="">',
    ]
  ) {
    const meta = parseInstagramMeta(`<head>
      ${twitterTag}
      <meta property="og:image" content="https://example.com/fallback.jpg">
    </head>`);

    assertEquals(meta.thumbnailUrl, "https://example.com/fallback.jpg");
  }
});

Deno.test("prefers og description regardless of HTML tag order", () => {
  const html = `<head>
    <meta name="description" content="generic description">
    <meta name="twitter:description" content="twitter description">
    <meta property="og:description" content="open graph description">
  </head>`;

  const meta = parseInstagramMeta(html);

  assertEquals(meta.description, "open graph description");
});

Deno.test("falls back between head description tags only", () => {
  const generic = parseInstagramMeta(
    `<head><meta name="description" content="generic description"></head>`,
  );
  const twitter = parseInstagramMeta(
    `<head><meta name="twitter:description" content="twitter description"></head>`,
  );

  assertEquals(generic.description, "generic description");
  assertEquals(twitter.description, "twitter description");
});

Deno.test("requests mobile HTML and preserves the complete caption", async () => {
  const url = "https://www.instagram.com/reel/Db0azgWTF1h/";
  const calls: string[] = [];
  let userAgent = "";
  const request = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    userAgent = new Headers(init?.headers).get("User-Agent") ?? "";
    return Promise.resolve(
      new Response(
        `<head><meta name="description" content="보연희 서울 서대문구 연희맛로 17-63 2층"></head>`,
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    );
  }) as typeof fetch;

  const meta = await fetchInstagramMeta(url, request);

  assertEquals(meta.description, "보연희 서울 서대문구 연희맛로 17-63 2층");
  assertEquals(meta.authorUsername, null);
  assertEquals(calls.length, 1);
  assertEquals(calls[0], url);
  assertEquals(userAgent.startsWith("Mozilla/5.0"), true);
  assertEquals(userAgent.includes("Mobile/"), true);
  assertEquals(userAgent.includes("Safari/"), true);
});

Deno.test("returns empty metadata without a head caption or fallback request", async () => {
  const url = "https://www.instagram.com/reel/Db0azgWTF1h/";
  const calls: string[] = [];
  const request = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response("<head><title>Instagram</title></head>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
  }) as typeof fetch;

  const meta = await fetchInstagramMeta(url, request);

  assertEquals(meta.description, null);
  assertEquals(meta.authorUsername, null);
  assertEquals(calls.length, 1);
  assertEquals(calls[0], url);
});

Deno.test("fails when Instagram returns a non-success response", async () => {
  const url = "https://www.instagram.com/reel/Db0azgWTF1h/";
  const request = (() => {
    return Promise.resolve(new Response("Forbidden", { status: 403 }));
  }) as typeof fetch;

  let message = "";
  try {
    await fetchInstagramMeta(url, request);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assertEquals(message, "instagram fetch failed: 403");
});
