// 원본 InstagramMediaSourceReader / InstagramMediaDownloader의 이식 명세.
import {
  downloadInstagramMedia,
  parseInstagramMediaSources,
  readInstagramMediaSources,
  removeDownloadedMedia,
  validateInstagramMediaSources,
} from "./instagram_media.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function throws(action: () => unknown): void {
  try {
    action();
  } catch {
    return;
  }
  throw new Error("원본이 완전하지 않으면 오류가 발생해야 합니다");
}

Deno.test("캐러셀 이미지와 영상 원본을 모두 입력 순서대로 읽고 부모 썸네일은 분석하지 않는다", () => {
  const html = `<script type="application/json">${
    JSON.stringify({
      data: {
        shortcode_media: {
          shortcode: "ABC",
          display_url: "https://cdn/thumbnail.jpg",
          edge_sidecar_to_children: {
            edges: [
              {
                node: { is_video: false, display_url: "https://cdn/first.jpg" },
              },
              { node: { is_video: true, video_url: "https://cdn/second.mp4" } },
              {
                node: { is_video: false, display_url: "https://cdn/third.jpg" },
              },
            ],
          },
        },
      },
    })
  }</script>`;
  equal(parseInstagramMediaSources(html, "ABC"), [
    { url: "https://cdn/first.jpg", type: "image" },
    { url: "https://cdn/second.mp4", type: "video" },
    { url: "https://cdn/third.jpg", type: "image" },
  ]);
});

Deno.test("embed에 원본이 없으면 공개 페이지와 공개 GraphQL 응답에서 원본을 읽는다", async () => {
  const calls: string[] = [];
  const sources = await readInstagramMediaSources(
    "https://www.instagram.com/reel/ABC/",
    async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith("/embed/")) return new Response("<html></html>");
      if (String(url).endsWith("/api/graphql")) {
        const form = init?.body as URLSearchParams;
        equal(form.get("doc_id"), "27130156389949648");
        equal(JSON.parse(form.get("variables")!).media_id, "66");
        equal(new Headers(init?.headers).get("X-FB-LSD"), "test-token");
        return Response.json({
          data: {
            xig_polaris_media: {
              code: "ABC",
              if_not_gated_logged_out: {
                code: "ABC",
                media_type: 2,
                video_versions: [{ url: "https://cdn/original.mp4" }],
              },
            },
          },
        });
      }
      return new Response('<script>["LSD",[],{"token":"test-token"}]</script>');
    },
  );
  equal(calls, [
    "https://www.instagram.com/reel/ABC/embed/",
    "https://www.instagram.com/reel/ABC/",
    "https://www.instagram.com/api/graphql",
  ]);
  equal(sources, [{ url: "https://cdn/original.mp4", type: "video" }]);
});

Deno.test("전체 원본을 임시 파일로 내려받고 MIME과 실제 파일 크기를 보존한다", async () => {
  const files = await downloadInstagramMedia(
    "https://www.instagram.com/p/ABC/",
    async (url) => {
      if (String(url).includes("instagram.com/p/")) {
        return new Response(
          '<script>{"shortcode":"ABC","display_url":"https://scontent.cdninstagram.com/original.jpg"}</script>',
        );
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/jpeg; charset=binary" },
      });
    },
  );
  try {
    equal(files.length, 1);
    equal([files[0].mimeType, files[0].size], ["image/jpeg", 3]);
    equal([...await Deno.readFile(files[0].path)], [1, 2, 3]);
  } finally {
    await removeDownloadedMedia(files);
  }
});

Deno.test("다운로드 중 오류가 발생하면 이미 받은 원본과 실패한 임시 파일을 모두 지운다", async () => {
  const before = new Set<string>();
  for await (const file of Deno.readDir("/tmp")) {
    if (file.name.startsWith("yeogidam-media-")) before.add(file.name);
  }
  let failed = false;
  try {
    await downloadInstagramMedia(
      "https://www.instagram.com/p/ABC/",
      async (url) => {
        if (String(url).includes("instagram.com/p/")) {
          return new Response(`<script>${
            JSON.stringify({
              shortcode: "ABC",
              carousel_media: [
                { display_url: "https://scontent.cdninstagram.com/first.jpg" },
                {
                  is_video: true,
                  video_url: "https://scontent.cdninstagram.com/second.mp4",
                },
              ],
            })
          }</script>`);
        }
        return String(url).endsWith("first.jpg")
          ? new Response(new Uint8Array([1, 2]), {
            headers: { "Content-Type": "image/jpeg" },
          })
          : new Response(new Uint8Array([1]), {
            headers: { "Content-Type": "text/html" },
          });
      },
    );
  } catch {
    failed = true;
  }
  equal(failed, true);
  const after = new Set<string>();
  for await (const file of Deno.readDir("/tmp")) {
    if (file.name.startsWith("yeogidam-media-")) after.add(file.name);
  }
  equal([...after].filter((name) => !before.has(name)), []);
});

Deno.test("100MB 초과 원본과 Instagram CDN 외부 주소는 다운로드하지 않는다", async () => {
  for (const scenario of ["size", "host", "redirect"]) {
    const calls: string[] = [];
    let failed = false;
    try {
      await downloadInstagramMedia(
        "https://www.instagram.com/p/ABC/",
        async (url) => {
          calls.push(String(url));
          if (String(url).includes("instagram.com/p/")) {
            return new Response(`<script>${
              JSON.stringify({
                shortcode: "ABC",
                display_url: scenario === "host"
                  ? "https://example.com/photo.jpg"
                  : "https://scontent.cdninstagram.com/original.jpg",
              })
            }</script>`);
          }
          if (scenario === "redirect") {
            return new Response(null, {
              status: 302,
              headers: { Location: "https://example.com/photo.jpg" },
            });
          }
          return new Response(null, {
            headers: {
              "Content-Type": "image/jpeg",
              "Content-Length": String(100 * 1024 * 1024 + 1),
            },
          });
        },
      );
    } catch {
      failed = true;
    }
    equal(failed, true);
    equal(calls.some((url) => url.includes("example.com")), false);
  }
});

Deno.test("서버 스크립트의 중첩 JSON 문자열에서도 대상 릴스 영상 원본을 읽는다", () => {
  const payload = JSON.stringify({
    metadata: { shortcode: "ABC" },
    gql_data: {
      shortcode_media: {
        shortcode: "ABC",
        is_video: true,
        display_url: "https://cdn/thumbnail.jpg",
        video_url: "https://cdn/original.mp4",
      },
    },
  });
  const html = `<script>requireLazy([],function(){s.handle(${
    JSON.stringify({ require: [payload] })
  });});</script>`;
  equal(parseInstagramMediaSources(html, "ABC"), [
    { url: "https://cdn/original.mp4", type: "video" },
  ]);
});

Deno.test("같은 페이지의 다른 게시물은 분석 대상에 포함하지 않는다", () => {
  equal(
    parseInstagramMediaSources(
      '<script>{"shortcode":"other","display_url":"https://cdn/other.jpg"}</script>',
      "ABC",
    ),
    [],
  );
});

Deno.test("캐러셀 영상 원본이 누락되면 일부 이미지만 분석하지 않고 실패한다", () => {
  throws(() =>
    parseInstagramMediaSources(
      `<script>${
        JSON.stringify({
          shortcode: "ABC",
          edge_sidecar_to_children: {
            edges: [
              { node: { display_url: "https://cdn/first.jpg" } },
              {
                node: {
                  is_video: true,
                  display_url: "https://cdn/thumbnail.jpg",
                },
              },
            ],
          },
        })
      }</script>`,
      "ABC",
    )
  );
});

Deno.test("image_versions2와 video_versions 형태의 원본도 읽는다", () => {
  equal(
    parseInstagramMediaSources(
      `<script>${
        JSON.stringify({
          code: "ABC",
          media_type: 8,
          carousel_media: [
            {
              media_type: 1,
              image_versions2: {
                candidates: [{ url: "https://cdn/first.jpg" }],
              },
            },
            {
              media_type: 2,
              video_versions: [{ url: "https://cdn/second.mp4" }],
            },
          ],
        })
      }</script>`,
      "ABC",
    ),
    [
      { url: "https://cdn/first.jpg", type: "image" },
      { url: "https://cdn/second.mp4", type: "video" },
    ],
  );
});

Deno.test("릴스는 영상 원본 한 개를 요구하며 이미지 썸네일로 대체하지 않는다", () => {
  throws(() =>
    validateInstagramMediaSources("https://www.instagram.com/reel/ABC/", [
      { url: "https://cdn/thumbnail.jpg", type: "image" },
    ])
  );
  validateInstagramMediaSources("https://www.instagram.com/reel/ABC/", [
    { url: "https://cdn/original.mp4", type: "video" },
  ]);
});

Deno.test("원본 목록이 비거나 20개를 초과하면 다운로드 전에 실패한다", () => {
  throws(() =>
    validateInstagramMediaSources("https://www.instagram.com/p/ABC/", [])
  );
  throws(() =>
    validateInstagramMediaSources(
      "https://www.instagram.com/p/ABC/",
      Array.from({ length: 21 }, (_, index) => ({
        url: `https://cdn/${index}.jpg`,
        type: "image" as const,
      })),
    )
  );
});
