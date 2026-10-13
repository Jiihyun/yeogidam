// 작은 원본은 Files API 대신 요청 본문에 base64로 싣는다.
import { createGeminiApiKeyStateStore } from "./ai/gemini_credentials.ts";
import type { SourcePlaceHint } from "./source_analysis.ts";
import { createSourceGeminiClient } from "./source_gemini.ts";
import type { DownloadedInstagramMedia } from "./instagram_media.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const hint: SourcePlaceHint = {
  nameInCaption: "영상 속 카페",
  nameSearchHint: null,
  accountHints: [],
  locationHints: [{ type: "REGION", value: "성수", basis: "VIDEO" }],
  categoryHint: "카페",
};

function analysisResponse(): Response {
  return Response.json({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ text: JSON.stringify({ places: [hint] }) }] },
    }],
  });
}

async function originals(): Promise<DownloadedInstagramMedia[]> {
  const files: DownloadedInstagramMedia[] = [];
  for (
    const [bytes, mimeType] of [
      [[0, 2, 3], "image/jpeg"],
      [[1, 2, 3], "video/mp4"],
    ] as const
  ) {
    const path = await Deno.makeTempFile({
      dir: "/tmp",
      prefix: "yeogidam-inline-test-",
    });
    await Deno.writeFile(path, new Uint8Array(bytes));
    files.push({ path, size: bytes.length, mimeType });
  }
  return files;
}

async function cleanUp(files: DownloadedInstagramMedia[]): Promise<void> {
  for (const file of files) {
    try {
      await Deno.remove(file.path);
    } catch { /* 정리됨 */ }
  }
}

Deno.test("원본 합계가 기준 이하면 업로드 없이 요청 본문에 base64로 싣는다", async () => {
  const files = await originals();
  const paths: string[] = [];
  let removed = false;
  let body: Record<string, unknown> | undefined;
  const client = createSourceGeminiClient(
    { apiKey: "primary", model: "test-model" },
    {
      state: createGeminiApiKeyStateStore(),
      download: async () => files,
      remove: async (downloaded) => {
        for (const file of downloaded) await Deno.remove(file.path);
        removed = true;
      },
      fetch: async (url, init) => {
        paths.push(new URL(String(url)).pathname);
        body = JSON.parse(String(init?.body));
        return analysisResponse();
      },
    },
  );
  try {
    equal(
      await client.extractMedia("카페", "https://www.instagram.com/p/ABC/"),
      [hint],
    );
    equal(paths, ["/v1beta/models/test-model:generateContent"]);
    const parts = (body?.contents as { parts: unknown[] }[])[0].parts;
    equal(parts.slice(1), [
      { inlineData: { mimeType: "image/jpeg", data: "AAID" } },
      { inlineData: { mimeType: "video/mp4", data: "AQID" } },
    ]);
    equal(removed, true);
  } finally {
    await cleanUp(files);
  }
});

Deno.test("인라인은 key를 바꿔도 원본을 다시 올리지 않는다", async () => {
  const files = await originals();
  const calls: string[] = [];
  const client = createSourceGeminiClient(
    { apiKey: "primary", model: "test-model", fallbackApiKeys: ["fallback"] },
    {
      state: createGeminiApiKeyStateStore(),
      download: async () => files,
      remove: async (downloaded) => {
        for (const file of downloaded) await Deno.remove(file.path);
      },
      fetch: async (url, init) => {
        const key = new Headers(init?.headers).get("x-goog-api-key")!;
        calls.push(`${new URL(String(url)).pathname} ${key}`);
        return key === "primary"
          ? Response.json({}, { status: 429 })
          : analysisResponse();
      },
    },
  );
  try {
    equal(
      await client.extractMedia("카페", "https://www.instagram.com/reel/ABC/"),
      [hint],
    );
    equal(calls, [
      "/v1beta/models/test-model:generateContent primary",
      "/v1beta/models/test-model:generateContent fallback",
    ]);
  } finally {
    await cleanUp(files);
  }
});

Deno.test("원본 합계가 기준을 넘으면 Files API로 올린다", async () => {
  const files = await originals();
  let uploads = 0;
  const client = createSourceGeminiClient(
    { apiKey: "primary", model: "test-model" },
    {
      state: createGeminiApiKeyStateStore(),
      inlineMediaMaxBytes: 5,
      download: async () => files,
      remove: async (downloaded) => {
        for (const file of downloaded) await Deno.remove(file.path);
      },
      sleep: async () => {},
      fetch: async (url, init) => {
        const target = String(url);
        if (init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (target.endsWith("/upload/v1beta/files")) {
          return new Response(null, {
            headers: {
              "X-Goog-Upload-URL":
                "https://generativelanguage.googleapis.com/upload/session",
            },
          });
        }
        if (target.endsWith("/upload/session")) {
          uploads++;
          await new Response(init?.body).arrayBuffer();
          return Response.json({
            file: {
              name: `files/f${uploads}`,
              uri: `gs://f${uploads}`,
              state: "ACTIVE",
            },
          });
        }
        if (target.endsWith(":generateContent")) return analysisResponse();
        throw new Error(`Unexpected URL: ${target}`);
      },
    },
  );
  try {
    equal(
      await client.extractMedia("카페", "https://www.instagram.com/p/ABC/"),
      [hint],
    );
    equal(uploads, 2);
  } finally {
    await cleanUp(files);
  }
});
