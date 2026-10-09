import {
  createSourceGeminiClient,
  parseSourcePlaceHints,
  SOURCE_HINTS_SCHEMA,
  sourceCaptionInput,
} from "./source_gemini.ts";
import {
  SOURCE_CAPTION_INSTRUCTION,
  SOURCE_MEDIA_INSTRUCTION,
} from "./source_prompts.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
const hint = {
  nameInCaption: "영상 속 카페",
  nameSearchHint: "카페 정식명",
  accountHints: ["@cafe"],
  locationHints: [{
    type: "ADDRESS",
    value: "서울 성동구 왕십리로 10",
    basis: "VIDEO",
  }],
  categoryHint: "카페",
};
const config = { apiKey: "test-key", model: "test-model" };

Deno.test("캡션 분석은 원본 Interactions API 형식과 URL Context를 사용한다", async () => {
  const client = createSourceGeminiClient(config, {
    fetch: async (url, init) => {
      equal(
        String(url),
        "https://generativelanguage.googleapis.com/v1/interactions",
      );
      equal(new Headers(init?.headers).get("x-goog-api-key"), "test-key");
      equal(JSON.parse(String(init?.body)), {
        model: "test-model",
        store: false,
        system_instruction: SOURCE_CAPTION_INSTRUCTION,
        input:
          "추천 @cafe\n\nInstagram account profile URLs:\nhttps://www.instagram.com/cafe/",
        tools: [{ type: "url_context" }],
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: SOURCE_HINTS_SCHEMA,
        },
      });
      return response({
        status: "completed",
        steps: [
          { type: "tool_call", content: [] },
          {
            type: "model_output",
            content: [{
              type: "text",
              text: JSON.stringify({ places: [hint] }),
            }],
          },
        ],
      });
    },
  });
  equal(await client.extractCaption("추천 @cafe"), [hint]);
});

Deno.test("프로필 URL은 중복을 제거하며 계정 단서가 없으면 캡션을 그대로 전달한다", () => {
  equal(sourceCaptionInput("오늘 카페"), "오늘 카페");
  equal(
    sourceCaptionInput("@cafe @cafe @other"),
    "@cafe @cafe @other\n\nInstagram account profile URLs:\nhttps://www.instagram.com/cafe/\nhttps://www.instagram.com/other/",
  );
});

Deno.test("장소 단서 파서는 영상과 이미지와 프로필의 위치 근거를 캡션 검사 없이 보존한다", () => {
  for (const basis of ["CAPTION", "VIDEO", "IMAGE", "INFERRED"]) {
    const item = {
      ...hint,
      locationHints: [{ ...hint.locationHints[0], basis }],
    };
    equal(parseSourcePlaceHints({ places: [item] }), [item]);
  }
  equal(parseSourcePlaceHints({ places: [] }), []);
});

Deno.test("미완료 응답이나 깨진 단서는 빈 장소로 바꾸지 않고 분석 오류로 처리한다", async () => {
  for (
    const payload of [
      { status: "in_progress", steps: [] },
      {
        status: "completed",
        steps: [{
          type: "model_output",
          content: [{ type: "text", text: '{"places":[{}]}' }],
        }],
      },
    ]
  ) {
    const client = createSourceGeminiClient(config, {
      fetch: async () => response(payload),
    });
    let failed = false;
    try {
      await client.extractCaption("카페");
    } catch {
      failed = true;
    }
    equal(failed, true);
  }
});

for (
  const scenario of [
    "success",
    "analysis-error",
    "upload-error",
    "processing-error",
  ] as const
) {
  Deno.test(`원본 미디어의 순서와 Gemini 파일 정리를 보장한다: ${scenario}`, async () => {
    const paths: string[] = [];
    const deleted: string[] = [];
    let removed = false;
    let uploads = 0;
    let polls = 0;
    let body: Record<string, unknown> | undefined;
    const client = createSourceGeminiClient(config, {
      download: async () => {
        for (let index = 0; index < 2; index++) {
          const path = await Deno.makeTempFile({
            dir: "/tmp",
            prefix: "yeogidam-test-",
          });
          paths.push(path);
          await Deno.writeFile(path, new Uint8Array([index, 2, 3]));
        }
        return paths.map((path, index) => ({
          path,
          size: 3,
          mimeType: index ? "video/mp4" : "image/jpeg",
        }));
      },
      remove: async (files) => {
        equal(files.map((file) => file.path), paths);
        for (const file of files) await Deno.remove(file.path);
        removed = true;
      },
      sleep: async () => {},
      fetch: async (url, init) => {
        const target = String(url);
        if (init?.method === "DELETE") {
          deleted.push(target.split("/").at(-1)!);
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
          const bytes = new Uint8Array(
            await new Response(init?.body).arrayBuffer(),
          );
          equal([...bytes], [uploads - 1, 2, 3]);
          if (scenario === "upload-error" && uploads === 2) {
            return response({}, 500);
          }
          return response({
            file: {
              name: `files/file${uploads}`,
              uri: `gs://file${uploads}`,
              state: "PROCESSING",
            },
          });
        }
        if (target.includes("/v1beta/files/")) {
          polls++;
          const name = target.split("/").at(-1)!;
          return response({
            name: `files/${name}`,
            uri: `gs://${name}`,
            state: scenario === "processing-error" ? "FAILED" : "ACTIVE",
          });
        }
        if (target.endsWith(":generateContent")) {
          body = JSON.parse(String(init?.body));
          if (scenario === "analysis-error") return response({}, 500);
          return response({
            candidates: [{
              finishReason: "STOP",
              content: {
                parts: [
                  { thought: true, text: "ignored" },
                  { text: '{"places":[' },
                  { text: JSON.stringify(hint) + "]}" },
                ],
              },
            }],
          });
        }
        throw new Error(`Unexpected URL: ${target}`);
      },
    });
    try {
      let result: unknown;
      let failed = false;
      try {
        result = await client.extractMedia(
          "@cafe",
          "https://www.instagram.com/p/ABC/",
        );
      } catch {
        failed = true;
      }
      equal(failed, scenario !== "success");
      equal(removed, true);
      equal(
        deleted,
        scenario === "processing-error" || scenario === "upload-error"
          ? ["file1"]
          : ["file1", "file2"],
      );
      if (scenario === "success") {
        equal(result, [hint]);
        equal(polls, 2);
        equal(body, {
          systemInstruction: { parts: [{ text: SOURCE_MEDIA_INSTRUCTION }] },
          contents: [{
            role: "user",
            parts: [
              { text: sourceCaptionInput("@cafe") },
              { fileData: { fileUri: "gs://file1", mimeType: "image/jpeg" } },
              { fileData: { fileUri: "gs://file2", mimeType: "video/mp4" } },
            ],
          }],
          tools: [{ urlContext: {} }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: SOURCE_HINTS_SCHEMA,
            mediaResolution: "MEDIA_RESOLUTION_HIGH",
          },
        });
      }
    } finally {
      for (const path of paths) {
        try {
          await Deno.remove(path);
        } catch { /* 정리됨 */ }
      }
    }
  });
}

Deno.test("파일 처리 대기 시간이 초과되면 Gemini 파일과 로컬 원본을 정리한다", async () => {
  const path = await Deno.makeTempFile({
    dir: "/tmp",
    prefix: "yeogidam-test-",
  });
  await Deno.writeFile(path, new Uint8Array([1]));
  let elapsed = 0;
  let deleted = false;
  let removed = false;
  const client = createSourceGeminiClient(config, {
    download: async () => [{ path, size: 1, mimeType: "video/mp4" }],
    remove: async () => {
      await Deno.remove(path);
      removed = true;
    },
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
    fetch: async (url, init) => {
      if (init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/upload/v1beta/files")) {
        return new Response(null, {
          headers: {
            "X-Goog-Upload-URL":
              "https://generativelanguage.googleapis.com/upload/session",
          },
        });
      }
      if (init?.body instanceof ReadableStream) {
        await new Response(init.body).arrayBuffer();
      }
      const file = {
        name: "files/pending",
        state: "PROCESSING",
        uri: "gs://pending",
      };
      return response(
        String(url).endsWith("/upload/session") ? { file } : file,
      );
    },
  });
  try {
    let failed = false;
    try {
      await client.extractMedia("카페", "https://www.instagram.com/reel/ABC/");
    } catch {
      failed = true;
    }
    equal(failed, true);
    equal([deleted, removed], [true, true]);
    equal(elapsed, 120_000);
  } finally {
    try {
      await Deno.remove(path);
    } catch { /* 정리됨 */ }
  }
});
