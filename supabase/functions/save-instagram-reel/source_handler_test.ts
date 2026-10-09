// 외부 서비스는 HTTP 응답으로 대체하고 실제 핸들러부터 저장 RPC까지 검증한다.
import { createSaveInstagramReelHandler } from "./index.ts";
import { AUTO_SAVE, REVIEW_QUEUE } from "./workflow.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
const ids = {
  reel: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  worker: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  extraction: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  place: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  request: "ffffffff-ffff-4fff-8fff-ffffffffffff",
};

for (const mode of [AUTO_SAVE, REVIEW_QUEUE]) {
  for (
    const scenario of [
      "success",
      "media",
      "empty",
      "provider-error",
      "cache",
      "processing",
      "partial",
      "resume",
    ] as const
  ) {
    Deno.test(`API와 저장 계약을 유지한다: ${mode} / ${scenario}`, async () => {
      const env: Record<string, string> = {
        SUPABASE_URL: "https://test.supabase.co",
        SUPABASE_ANON_KEY: "test-anon",
        SUPABASE_SERVICE_ROLE_KEY: "test-service",
        STUB_PROVIDERS: "0",
        PIPELINE_SYNC: "1",
        GEMINI_API_KEY: "test-key",
        GEMINI_MODEL: "test-model",
        KAKAO_REST_API_KEY: "test-kakao",
      };
      const saved = new Map(
        Object.keys(env).map((key) => [key, Deno.env.get(key)]),
      );
      for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
      const originalFetch = globalThis.fetch;
      const requests: { path: string; body: Record<string, unknown> | null }[] =
        [];
      let checkpoint: Record<string, unknown> | null = scenario === "resume"
        ? {
          p_jobs: [{
            position: 0,
            matched_place: {
              guess: {
                placeName: "카페",
                address: null,
                addressType: "NONE",
                region: "성수",
              },
              place: {
                kakaoPlaceId: "100",
                name: "카카오 첫 장소",
                address: "서울 성동구 성수동1가 1",
                roadAddress: null,
                latitude: 37.5,
                longitude: 127,
                category: null,
                telephone: null,
                placeUrl: null,
              },
            },
            thumbnail_source_url: null,
          }],
          p_instagram_description: "카페 소개",
          p_instagram_author_username: null,
          p_instagram_thumbnail_url: null,
          p_has_match_failures: false,
          p_match_failures: [],
        }
        : null;
      let analysisCalls = 0;
      let mediaCalls = 0;
      let searchCalls = 0;
      const unexpected: string[] = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL
            ? String(input)
            : input.url,
        );
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : null;
        requests.push({ path: url.pathname, body });
        if (url.pathname === "/auth/v1/user") {
          return Response.json({ id: "11111111-1111-4111-8111-111111111111" });
        }
        if (url.pathname === "/rest/v1/rpc/begin_reel_request") {
          equal(body?.p_instagram_url, "https://www.instagram.com/reel/ABC/");
          equal(body?.p_client_request_id, ids.request);
          equal(body?.p_source, "url_input");
          equal(body?.p_save_mode, mode);
          equal(body?.p_pipeline_version, 11);
          return Response.json({
            reel_id: ids.reel,
            worker_reel_id: scenario === "cache" ? null : ids.worker,
            extraction_id: ids.extraction,
            processing_token: ids.token,
            processing_status: scenario === "cache"
              ? "COMPLETED"
              : "PROCESSING",
            failure_reason: null,
            should_process: !["cache", "processing"].includes(scenario),
            reused: ["cache", "processing"].includes(scenario),
            duplicate: false,
            save_mode: mode,
            place_id: scenario === "cache" ? ids.place : null,
            place_ids: scenario === "cache" ? [ids.place] : [],
          });
        }
        if (url.hostname === "www.instagram.com") {
          if (url.pathname.endsWith("/embed/") && scenario === "media") {
            return new Response(
              '<script>{"shortcode":"ABC","is_video":true,"display_url":"https://scontent.cdninstagram.com/thumb.jpg","video_url":"https://scontent.cdninstagram.com/original.mp4"}</script>',
            );
          }
          return new Response('<meta name="description" content="카페 소개">');
        }
        if (url.hostname === "scontent.cdninstagram.com") {
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { "Content-Type": "video/mp4" },
          });
        }
        if (url.pathname === "/upload/v1beta/files") {
          return new Response(null, {
            headers: {
              "X-Goog-Upload-URL":
                "https://generativelanguage.googleapis.com/upload/session",
            },
          });
        }
        if (url.pathname === "/upload/session") {
          equal([
            ...new Uint8Array(await new Response(init?.body).arrayBuffer()),
          ], [1, 2, 3]);
          return Response.json({
            file: { name: "files/video", state: "ACTIVE", uri: "gs://video" },
          });
        }
        if (
          url.pathname === "/v1beta/files/video" && init?.method === "DELETE"
        ) return new Response(null, { status: 204 });
        if (url.pathname.endsWith(":generateContent")) {
          mediaCalls++;
          const hint = {
            nameInCaption: "영상 속 카페",
            nameSearchHint: "정식 카페명",
            accountHints: [],
            locationHints: [{
              type: "ADDRESS",
              value: "서울 성동구 왕십리로 10",
              basis: "VIDEO",
            }],
            categoryHint: "카페",
          };
          return Response.json({
            candidates: [{
              finishReason: "STOP",
              content: {
                parts: [{ text: JSON.stringify({ places: [hint] }) }],
              },
            }],
          });
        }
        if (url.pathname === "/rest/v1/reels") {
          return Response.json({ id: ids.worker });
        }
        if (url.pathname === "/v1/interactions") {
          analysisCalls++;
          if (scenario === "provider-error") {
            return new Response(null, { status: 429 });
          }
          const hint = {
            nameInCaption: "카페",
            nameSearchHint: "정식 카페명",
            accountHints: [],
            locationHints: [{
              type: "REGION",
              value: "성수",
              basis: "INFERRED",
            }],
            categoryHint: "카페",
          };
          return Response.json({
            status: "completed",
            steps: [{
              type: "model_output",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    places: scenario === "media"
                      ? []
                      : scenario === "partial"
                      ? [hint, { ...hint, nameSearchHint: "없는 카페" }]
                      : [hint],
                  }),
                },
              ],
            }],
          });
        }
        if (url.hostname === "dapi.kakao.com") {
          searchCalls++;
          if (
            scenario === "empty" ||
            url.searchParams.get("query")?.startsWith("없는 카페")
          ) return Response.json({ documents: [] });
          equal(
            url.searchParams.get("query"),
            scenario === "media" ? "정식 카페명 성동구" : "정식 카페명 성수",
          );
          return Response.json({
            documents: [
              {
                id: "100",
                place_name: "카카오 첫 장소",
                address_name: "서울 성동구 성수동1가 1",
                x: "127",
                y: "37.5",
              },
              {
                id: "200",
                place_name: "카카오 두번째 장소",
                address_name: "서울 마포구 연남동 1",
                x: "127",
                y: "37.5",
              },
            ],
          });
        }
        if (url.pathname === "/rest/v1/places") {
          equal(body?.kakao_place_id, "100");
          equal(body?.name, "카카오 첫 장소");
          if (scenario === "media") {
            equal(body?.source_address, "서울 성동구 왕십리로 10");
          }
          return Response.json({
            id: ids.place,
            thumbnail_url: "https://test/thumb.jpg",
            google_place_id: null,
          });
        }
        if (url.pathname === "/rest/v1/rpc/persist_reel_place_result") {
          equal(body?.p_reel_id, ids.worker);
          equal(body?.p_processing_token, ids.token);
          equal(body?.p_place_id, ids.place);
          equal(body?.p_position, 0);
          return Response.json(ids.place);
        }
        if (url.pathname === "/rest/v1/reel_extraction_place_jobs") {
          return new Response(null, {
            headers: { "Content-Range": scenario === "resume" ? "*/1" : "*/0" },
          });
        }
        if (
          url.pathname === "/rest/v1/rpc/enqueue_reel_extraction_place_jobs"
        ) {
          equal(body?.p_processing_token, ids.token);
          equal(body?.p_has_match_failures, scenario === "partial");
          checkpoint = body;
          return Response.json(null);
        }
        if (
          url.pathname === "/rest/v1/rpc/hydrate_reel_extraction_place_results"
        ) {
          equal(body?.p_processing_token, ids.token);
          return Response.json(null);
        }
        if (url.pathname === "/rest/v1/rpc/claim_reel_extraction_place_batch") {
          equal(body?.p_limit, 5);
          equal(body?.p_lease_seconds, 300);
          const jobs = checkpoint?.p_jobs as Record<string, unknown>[];
          return Response.json({
            jobs: jobs.map((job) => ({
              ...job,
              instagram_description: checkpoint?.p_instagram_description,
              instagram_author_username: checkpoint
                ?.p_instagram_author_username,
              instagram_thumbnail_url: checkpoint?.p_instagram_thumbnail_url,
              has_match_failures: checkpoint?.p_has_match_failures,
              match_failures: checkpoint?.p_match_failures,
            })),
            has_unfinished: true,
          });
        }
        if (
          url.pathname === "/rest/v1/rpc/complete_reel_extraction_place_job"
        ) {
          equal(body?.p_extraction_id, ids.extraction);
          equal(body?.p_worker_reel_id, ids.worker);
          equal(body?.p_processing_token, ids.token);
          equal(body?.p_position, 0);
          equal(body?.p_place_id, ids.place);
          return Response.json(false);
        }
        if (url.pathname === "/rest/v1/reel_place_match_failures") {
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/rest/v1/rpc/fail_reel_extraction") {
          return Response.json(null);
        }
        unexpected.push(url.href);
        throw new Error(`Unexpected URL: ${url.href}`);
      };
      try {
        const response = await createSaveInstagramReelHandler(mode)(
          new Request("https://test/functions/v1/save-instagram-reel", {
            method: "POST",
            headers: {
              Authorization: "Bearer test-token",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              instagramUrl: "https://www.instagram.com/reel/ABC/",
              source: "url_input",
              clientRequestId: ids.request,
            }),
          }),
        );
        const failed = scenario === "empty" || scenario === "provider-error";
        const expected: Record<string, unknown> = {
          reelId: ids.reel,
          status: failed
            ? "FAILED"
            : scenario === "processing"
            ? "PROCESSING"
            : "COMPLETED",
          ...(failed
            ? {
              failureReason: scenario === "empty"
                ? "KAKAO_PLACE_NOT_FOUND"
                : "UNKNOWN",
            }
            : scenario === "processing"
            ? {}
            : { placeId: ids.place, placeIds: [ids.place] }),
          reused: ["cache", "processing"].includes(scenario),
        };
        if (mode === REVIEW_QUEUE) expected.saveMode = mode;
        equal(response.status, scenario === "processing" ? 202 : 200);
        equal(await response.json(), expected);
        equal(unexpected, []);
        equal(
          analysisCalls,
          ["cache", "processing", "resume"].includes(scenario) ? 0 : 1,
        );
        equal(mediaCalls, scenario === "media" ? 1 : 0);
        if (scenario === "resume") {
          equal(searchCalls, 0);
          equal(
            requests.some((request) =>
              request.path.startsWith("/reel/") ||
              request.path === "/rest/v1/rpc/enqueue_reel_extraction_place_jobs"
            ),
            false,
          );
        }
        if (["cache", "processing"].includes(scenario)) {
          equal(searchCalls, 0);
          equal(requests.map((request) => request.path), [
            "/auth/v1/user",
            "/rest/v1/rpc/begin_reel_request",
          ]);
        } else if (failed) {
          equal(
            requests.some((request) =>
              request.path === "/rest/v1/rpc/complete_reel_extraction_place_job"
            ),
            false,
          );
          equal(
            requests.find((request) =>
              request.path === "/rest/v1/rpc/fail_reel_extraction"
            )?.body?.p_failure_reason,
            scenario === "empty" ? "KAKAO_PLACE_NOT_FOUND" : "UNKNOWN",
          );
        }
      } finally {
        globalThis.fetch = originalFetch;
        for (const [key, value] of saved) {
          if (value === undefined) Deno.env.delete(key);
          else Deno.env.set(key, value);
        }
      }
    });
  }
}
