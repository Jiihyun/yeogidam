import {
  parseInstagramEmbedCaption,
  parseInstagramMeta,
  parseInstagramOEmbed,
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
});

Deno.test("parses attributes in either order and preserves apostrophes", () => {
  const html = `<head>
    <meta content="Today's cafe" property="og:title">
    <meta content='https://example.com/photo.jpg' name='twitter:image'>
  </head>`;

  const meta = parseInstagramMeta(html);

  assertEquals(meta.title, "Today's cafe");
  assertEquals(meta.thumbnailUrl, "https://example.com/photo.jpg");
});

Deno.test("parses a captioned Instagram embed", () => {
  const html = `<div class="Caption">
    <a class="CaptionUsername">opetion_h</a><br /><br />
    무화과 디저트와 ‘보연희’를 소개해요.<br />
    📍보연희<br />서울 서대문구 연희맛로 17-63 2층<br />
    <a href="/tags/cafe">#연희동카페</a>
    <div class="CaptionComments"></div>
  </div>`;

  assertEquals(
    parseInstagramEmbedCaption(html),
    "opetion_h\n무화과 디저트와 ‘보연희’를 소개해요.\n📍보연희\n서울 서대문구 연희맛로 17-63 2층\n#연희동카페",
  );
});

Deno.test("parses Instagram oEmbed JSON", () => {
  const meta = parseInstagramOEmbed(
    {
      author_name: "opetion_h",
      title: "📍보연희\n서울 서대문구 연희맛로 17-63 2층",
      thumbnail_url: "https://example.com/thumbnail.jpg",
    },
    "https://www.instagram.com/reel/Db0azgWTF1h",
  );

  assertEquals(meta?.title, "opetion_h의 Instagram 릴스");
  assertEquals(
    meta?.description,
    "📍보연희\n서울 서대문구 연희맛로 17-63 2층",
  );
  assertEquals(meta?.thumbnailUrl, "https://example.com/thumbnail.jpg");
});
