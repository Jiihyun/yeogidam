import { uploadSourceMediaBytes } from "./source_gemini.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("실제 HTTP에서 파일 바이트와 Content-Length와 resumable offset을 보존한다", async () => {
  const received: unknown[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      received.push({
        bytes: [...new Uint8Array(await request.arrayBuffer())],
        length: request.headers.get("Content-Length"),
        offset: request.headers.get("X-Goog-Upload-Offset"),
        command: request.headers.get("X-Goog-Upload-Command"),
        mime: request.headers.get("Content-Type"),
      });
      if (request.headers.get("X-Goog-Upload-Command") === "upload, finalize") {
        return Response.json({ file: { name: "files/complete" } });
      }
      return new Response(null, { status: 200 });
    },
  );
  const path = await Deno.makeTempFile({
    dir: "/tmp",
    prefix: "yeogidam-upload-test-",
  });
  try {
    await Deno.writeFile(path, new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
    const result = await uploadSourceMediaBytes(fetch, {
      url: `http://127.0.0.1:${server.addr.port}/upload`,
      chunkSize: 3,
    }, { path, mimeType: "video/mp4", size: 7 });
    equal(result, { file: { name: "files/complete" } });
    equal(received, [
      {
        bytes: [1, 2, 3],
        length: "3",
        offset: "0",
        command: "upload",
        mime: "video/mp4",
      },
      {
        bytes: [4, 5, 6],
        length: "3",
        offset: "3",
        command: "upload",
        mime: "video/mp4",
      },
      {
        bytes: [7],
        length: "1",
        offset: "6",
        command: "upload, finalize",
        mime: "video/mp4",
      },
    ]);
  } finally {
    await Deno.remove(path);
    await server.shutdown();
  }
});

Deno.test("업로드 도중 HTTP 오류가 나면 다음 조각이나 finalize를 전송하지 않는다", async () => {
  const path = await Deno.makeTempFile({
    dir: "/tmp",
    prefix: "yeogidam-upload-test-",
  });
  try {
    await Deno.writeFile(path, new Uint8Array([1, 2, 3, 4]));
    let calls = 0;
    let failed = false;
    try {
      await uploadSourceMediaBytes(async () => {
        calls++;
        return new Response(null, { status: 500 });
      }, {
        url: "https://generativelanguage.googleapis.com/upload/session",
        chunkSize: 2,
      }, {
        path,
        mimeType: "video/mp4",
        size: 4,
      });
    } catch {
      failed = true;
    }
    equal([failed, calls], [true, 1]);
  } finally {
    await Deno.remove(path);
  }
});
