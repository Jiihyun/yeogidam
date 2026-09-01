// POST /functions/v1/save-instagram-reel
// 1) JWT 인증 → 2) IG URL/shortcode 검증 → 3) 요청 히스토리 멱등 생성
// → 4) shortcode/version 공용 완료 캐시 재사용 또는 단일 worker 선점
// → 5) 필요할 때만 waitUntil 파이프라인(IG 추출 → AI → Kakao → 썸네일 → DB)
//
// 로컬 검증용: 환경변수 PIPELINE_SYNC=1 이면 백그라운드 대신 동기로 처리하고
// 최종 상태를 응답에 담아 반환한다(테스트 편의). 프로덕션 기본은 비동기(202).

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createRequestId, errorResponse } from "../_shared/error_code.ts";
import { AiConfigError, AiProvidersExhaustedError } from "./ai/errors.ts";
import { createPlaceAiClient } from "./ai/factory.ts";
import { sanitizeAiRuntimeLogDetails } from "./ai/log_sanitizer.ts";
import type { AiLog, PlaceAiClient } from "./ai/provider.ts";
import { sendGeminiRuntimeDiscordAlert } from "./ai/runtime_alerts.ts";
import type { PlaceGuess } from "./ai/types.ts";
import { fetchInstagramMeta } from "./instagram.ts";
import { extractKoreanAddresses } from "./address.ts";
import {
  buildKakaoMapURL,
  type KakaoPlace,
  searchKakaoAddressCoordinates,
  searchKakaoPlaces,
  searchKakaoPlacesNearAddress,
} from "./kakao.ts";
import { sanitizePlaceGuesses, withCaptionAddresses } from "./matching.ts";
import {
  type PlaceMatchFailure,
  placeMatchFailureRow,
} from "./match_failure.ts";
import { resolvePlacesFromKakao } from "./place_resolution.ts";
import { findGooglePlacePhoto } from "./google.ts";
import {
  fetchEmbedDisplayUrl,
  rehostThumbnail,
  scrapePageImage,
} from "./thumbnail.ts";
import { completedProcessingVersion, parseInstagramReelURL } from "./reel.ts";
import {
  begunReelHTTPResult,
  type BegunReelRequest,
  clientRequestId,
  isIdempotencyKeyPayloadMismatch,
  parseBegunReelRequest,
  type ReelRequestPayload,
} from "./request.ts";
import {
  AUTO_SAVE,
  type ReelSaveMode,
  responseForSaveMode,
} from "./workflow.ts";

// Supabase Edge Runtime 전역 (백그라운드 처리)
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function databaseErrorResponse(requestId: string, error?: unknown): Response {
  console.error(JSON.stringify({
    event: "api_error",
    requestId,
    errorCode: "DATA500_001",
    internalMessage: error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
      ? String(error.message)
      : undefined,
  }));
  return errorResponse("DATABASE_ERROR", requestId, { headers: cors });
}

type FailureReason =
  | "IG_FETCH_FAILED"
  | "IG_CAPTION_NOT_FOUND"
  | "PROVIDER_CONFIG_MISSING"
  | "GEMINI_PLACE_NOT_FOUND"
  | "KAKAO_PLACE_NOT_FOUND"
  | "PLACE_NOT_FOUND"
  | "UNKNOWN";

function aiFailureReason(error: AiProvidersExhaustedError): FailureReason {
  const finalAttempt = error.attempts.at(-1);
  if (
    finalAttempt?.kind === "AUTH" || finalAttempt?.kind === "BAD_REQUEST"
  ) return "PROVIDER_CONFIG_MISSING";
  if (
    finalAttempt?.kind === "CONTENT_BLOCKED" ||
    finalAttempt?.kind === "CANCELLED"
  ) {
    // 기존 DB/iOS 계약의 비재시도 장소 분석 실패 코드를 호환용으로 쓴다.
    return "GEMINI_PLACE_NOT_FOUND";
  }
  return "UNKNOWN";
}

const STALE_PROCESSING_MS = 15 * 60 * 1000;
const PIPELINE_VERSION = 9;

function createAiRuntimeLog(reelId: string): AiLog {
  return (event, details) => {
    console.info(JSON.stringify({
      event,
      reelId,
      ...sanitizeAiRuntimeLogDetails(details),
    }));
    const delivery = sendGeminiRuntimeDiscordAlert(event, details, {
      webhookUrl: Deno.env.get("DISCORD_GEMINI_ALERT_WEBHOOK_URL"),
      log: (alertEvent, alertDetails) => {
        console.info(JSON.stringify({
          event: alertEvent,
          reelId,
          ...alertDetails,
        }));
      },
    }).catch((error) => {
      console.error(JSON.stringify({
        event: "ai_runtime_discord_alert_unexpected_failure",
        reelId,
        sourceEvent: event,
        errorName: error instanceof Error ? error.name : "unknown",
      }));
    });
    try {
      EdgeRuntime.waitUntil(delivery);
    } catch (error) {
      console.error(JSON.stringify({
        event: "ai_runtime_discord_alert_scheduling_failed",
        reelId,
        sourceEvent: event,
        errorName: error instanceof Error ? error.name : "unknown",
      }));
    }
  };
}

// 로컬 검증 전용 스텁 (STUB_PROVIDERS=1 일 때만 사용). AI/Kakao 키 없이
// 파이프라인 전체(추출→매칭→저장→썸네일)를 결정적으로 검증하기 위한 것.
// 프로덕션에서는 이 플래그를 켜지 않는다.
const STUB_META = {
  description:
    "서울 성동구 연무장길 12 에 있는 여기담 스텁 카페 ☕️ 분위기 좋아요",
  authorUsername: "yeogidam_stub",
  thumbnailUrl: "https://picsum.photos/seed/yeogidam/600/600",
  canonicalUrl: null as string | null,
};
const STUB_PLACE = {
  kakaoPlaceId: "stub-1001",
  name: "여기담 스텁 카페",
  category: "카페",
  roadAddress: "서울 성동구 연무장길 12",
  address: "서울 성동구 성수동2가 273-14",
  latitude: 37.5445,
  longitude: 127.0557,
  placeUrl: null as string | null,
  telephone: null as string | null,
};
const STUB_THUMBNAIL = {
  googlePlaceId: "google-stub-1001",
  url: "https://picsum.photos/seed/yeogidam-google/600/600",
  attribution: "Google Places stub",
};

export function createSaveInstagramReelHandler(
  requestedSaveMode: ReelSaveMode,
): (req: Request) => Promise<Response> {
  return (req) => handleSaveInstagramReel(req, requestedSaveMode);
}

async function handleSaveInstagramReel(
  req: Request,
  requestedSaveMode: ReelSaveMode,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const requestId = createRequestId();
  try {
    if (req.method !== "POST") {
      return errorResponse("METHOD_NOT_ALLOWED", requestId, { headers: cors });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1) JWT 인증
    const token = (req.headers.get("Authorization") ?? "").replace(
      /^Bearer\s+/i,
      "",
    );
    if (!token) {
      return errorResponse("AUTH_REQUIRED", requestId, { headers: cors });
    }
    const authClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userErr } = await authClient.auth.getUser(
      token,
    );
    if (userErr || !userData.user) {
      return errorResponse("AUTH_SESSION_EXPIRED", requestId, {
        headers: cors,
      });
    }
    const userId = userData.user.id;

    // 2) 입력 검증
    let payload: ReelRequestPayload;
    try {
      payload = await req.json();
    } catch {
      return errorResponse("INVALID_REQUEST_BODY", requestId, {
        headers: cors,
        details: { field: "body" },
      });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return errorResponse("INVALID_REQUEST_BODY", requestId, {
        headers: cors,
        details: { field: "body" },
      });
    }
    const reelReference = parseInstagramReelURL(
      typeof payload.instagramUrl === "string"
        ? payload.instagramUrl.trim()
        : "",
    );
    const source = payload.source === "url_input"
      ? "url_input"
      : "instagram_share";
    if (!reelReference) {
      return errorResponse("INVALID_INSTAGRAM_URL", requestId, {
        headers: cors,
        details: { field: "instagramUrl" },
      });
    }
    const instagramUrl = reelReference.canonicalUrl;
    const idempotency = clientRequestId(req, payload);
    if (!idempotency.value) {
      return errorResponse("INVALID_REQUEST_BODY", requestId, {
        headers: cors,
        details: { field: "clientRequestId" },
      });
    }

    // 3) 요청 히스토리를 생성하고 shortcode+pipeline version 공용 추출을 선점한다.
    // 같은 clientRequestId 재전송은 동일 히스토리로 수렴하고, 서로 다른 사용자의
    // 동시 요청도 하나의 worker만 외부 API를 호출한다.
    const admin = createClient(SUPABASE_URL, SERVICE);
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS)
      .toISOString();
    const { data: begunData, error: begunError } = await admin.rpc(
      "begin_reel_request",
      {
        p_user_id: userId,
        p_client_request_id: idempotency.value,
        p_instagram_shortcode: reelReference.shortcode,
        p_instagram_url: instagramUrl,
        p_source: source,
        p_save_mode: requestedSaveMode,
        p_pipeline_version: PIPELINE_VERSION,
        p_stale_before: staleBefore,
      },
    );
    if (isIdempotencyKeyPayloadMismatch(begunError)) {
      return errorResponse("INVALID_REQUEST_BODY", requestId, {
        headers: cors,
        details: { field: "clientRequestId" },
      });
    }
    const begun = parseBegunReelRequest(begunData);
    if (begunError || !begun) {
      return databaseErrorResponse(
        requestId,
        begunError ?? new Error("invalid_begin_reel_request"),
      );
    }

    if (!begun.shouldProcess) {
      return begunReelResponse(begun, requestedSaveMode);
    }
    if (!begun.workerReelId) {
      return databaseErrorResponse(
        requestId,
        new Error("missing_worker_reel_for_claimed_extraction"),
      );
    }

    return scheduleOrProcess(
      admin,
      begun.reelId,
      begun.workerReelId,
      begun.extractionId,
      instagramUrl,
      begun.reused,
      requestedSaveMode,
      begun.saveMode,
      begun.processingToken,
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: "api_error",
      requestId,
      errorCode: "COMMON500_001",
      internalMessage: error instanceof Error ? error.message : String(error),
    }));
    return errorResponse("INTERNAL_ERROR", requestId, { headers: cors });
  }
}

if (import.meta.main) {
  Deno.serve(createSaveInstagramReelHandler(AUTO_SAVE));
}

async function scheduleOrProcess(
  admin: SupabaseClient,
  reelId: string,
  workerReelId: string,
  extractionId: string,
  instagramUrl: string,
  reused: boolean,
  requestedSaveMode: ReelSaveMode,
  initialSaveMode: ReelSaveMode,
  processingToken: string,
): Promise<Response> {
  const work = processReel(
    admin,
    workerReelId,
    extractionId,
    processingToken,
    instagramUrl,
  );
  if (Deno.env.get("PIPELINE_SYNC") === "1") {
    const result = await work;
    return json(
      responseForSaveMode(
        { reelId, ...result, reused },
        requestedSaveMode,
        initialSaveMode,
      ),
      200,
    );
  }
  EdgeRuntime.waitUntil(work);
  return json(
    responseForSaveMode(
      { reelId, status: "PROCESSING", reused },
      requestedSaveMode,
      initialSaveMode,
    ),
    202,
  );
}

interface ProcessResult {
  status: "COMPLETED" | "FAILED";
  failureReason?: FailureReason;
  placeId?: string;
  placeIds?: string[];
}

function begunReelResponse(
  reel: BegunReelRequest,
  requestedSaveMode: ReelSaveMode,
): Response {
  const result = begunReelHTTPResult(reel, requestedSaveMode);
  return json(result.body, result.status);
}

interface MatchedPlace {
  guess: PlaceGuess;
  place: KakaoPlace;
}

async function processReel(
  admin: SupabaseClient,
  workerReelId: string,
  extractionId: string,
  processingToken: string,
  instagramUrl: string,
): Promise<ProcessResult> {
  const stub = Deno.env.get("STUB_PROVIDERS") === "1";
  const reelId = workerReelId;
  const failWorker = (reason: FailureReason) =>
    fail(admin, extractionId, workerReelId, processingToken, reason);
  try {
    // 1. Instagram HTML → og:*
    let meta;
    try {
      meta = stub ? STUB_META : await fetchInstagramMeta(instagramUrl);
    } catch (error) {
      console.error(JSON.stringify({
        event: "instagram_fetch_failed",
        reelId,
        message: error instanceof Error ? error.message : String(error),
      }));
      return await failWorker("IG_FETCH_FAILED");
    }
    // 사진 게시물(/p/)의 og:image 는 정사각으로 잘려 있어 embed 의 원본 비율 주소를 우선 쓴다.
    let thumbnailSource = meta.thumbnailUrl;
    if (thumbnailSource && instagramUrl.includes("/p/")) {
      const original = await fetchEmbedDisplayUrl(instagramUrl);
      console.info(JSON.stringify({
        event: "thumbnail_embed_original",
        reelId,
        found: Boolean(original),
      }));
      if (original) thumbnailSource = original;
    }
    // 인스타 이미지 직링크는 서명이 1~2주 뒤 만료되어 깨진다.
    // 저장 시점에 스토리지로 복사해 우리 주소를 저장하고, 복사 실패 시에만 직링크를 남긴다.
    const reelThumbnailUrl = thumbnailSource
      ? (await rehostThumbnail(admin, `reels/${reelId}`, thumbnailSource)) ??
        thumbnailSource
      : null;
    const { data: metadataReel, error: metadataUpdateError } = await admin
      .from("reels")
      .update({
        instagram_description: meta.description,
        ...(meta.authorUsername
          ? { instagram_author_username: meta.authorUsername }
          : {}),
        instagram_thumbnail_url: reelThumbnailUrl,
      })
      .eq("id", reelId)
      .eq("processing_token", processingToken)
      .select("id")
      .maybeSingle();
    if (metadataUpdateError) throw metadataUpdateError;
    if (!metadataReel) throw new Error("stale_reel_processing_attempt");

    const caption = meta.description;
    if (!caption) {
      console.error(JSON.stringify({
        event: "instagram_caption_not_found",
        reelId,
        hasThumbnail: Boolean(meta.thumbnailUrl),
        hasCanonicalUrl: Boolean(meta.canonicalUrl),
      }));
      return await failWorker("IG_CAPTION_NOT_FOUND");
    }

    // 2. 정규식으로 찾은 도로명·지번 주소는 관측하고, 아래에서 AI가 주소를
    // 빠뜨린 장소에 한해 가까운 문맥이 명확할 때만 보강한다.
    const regexAddresses = extractKoreanAddresses(caption);
    console.info(JSON.stringify({
      event: "regex_addresses_shadow",
      reelId,
      addresses: regexAddresses,
    }));

    // 3. 선택된 AI 공급자가 전체 캡션에서 모든 장소를 구조화하고,
    // 원문에 실제 있는 문자열만 남긴다.
    const kakaoKey = Deno.env.get("KAKAO_REST_API_KEY");
    if (!stub && !kakaoKey) {
      return await failWorker("PROVIDER_CONFIG_MISSING");
    }

    let matchedPlaces: MatchedPlace[] = [];
    const matchFailures: PlaceMatchFailure[] = [];
    if (stub) {
      matchedPlaces = [{
        guess: {
          placeName: STUB_PLACE.name,
          address: regexAddresses[0] ?? null,
          addressType: regexAddresses.length > 0 ? "ROAD" : "NONE",
          region: "성동구",
        },
        place: STUB_PLACE,
      }];
    } else {
      let ai: PlaceAiClient;
      try {
        ai = createPlaceAiClient(Deno.env, {
          log: createAiRuntimeLog(reelId),
        });
      } catch (error) {
        if (error instanceof AiConfigError) {
          console.error(JSON.stringify({
            event: "ai_provider_config_invalid",
            reelId,
            message: error.message,
          }));
          return await failWorker("PROVIDER_CONFIG_MISSING");
        }
        throw error;
      }

      const extraction = await ai.extractPlaces(caption);
      const extracted = extraction.data;
      const sanitizedGuesses = sanitizePlaceGuesses(extracted, caption);
      const guesses = withCaptionAddresses(
        sanitizedGuesses,
        caption,
        regexAddresses,
      );
      console.info(JSON.stringify({
        event: "ai_place_guesses_sanitized",
        reelId,
        provider: extraction.provider,
        model: extraction.model,
        fallbackUsed: extraction.fallbackUsed,
        extractedCount: extracted.length,
        sanitizedCount: guesses.length,
        regexAddressAppliedCount: guesses.filter((guess, index) =>
          !sanitizedGuesses[index]?.address && Boolean(guess.address)
        ).length,
      }));
      if (extracted.length === 0 || guesses.length === 0) {
        return await failWorker("GEMINI_PLACE_NOT_FOUND");
      }

      const resolution = await resolvePlacesFromKakao(caption, guesses, {
        search: (query) => searchKakaoPlaces(query, kakaoKey!),
        geocodeAddress: (address) =>
          searchKakaoAddressCoordinates(address, kakaoKey!),
        searchNearby: (query, center) =>
          searchKakaoPlacesNearAddress(query, center, kakaoKey!),
        judge: async (reviewCaption, items) =>
          (await ai.judgeKakaoCandidates(reviewCaption, items)).data,
        log: (event, details) => {
          console.info(JSON.stringify({ event, reelId, ...details }));
        },
      });
      matchedPlaces = resolution.matches;
      matchFailures.push(...resolution.failures);
    }
    await persistPlaceMatchFailures(
      admin,
      reelId,
      processingToken,
      matchFailures,
    );
    if (matchedPlaces.length === 0) {
      return await failWorker("KAKAO_PLACE_NOT_FOUND");
    }

    // 4. 선택된 모든 장소를 places/saved_places/reel_places에 순서대로 저장한다.
    const placeIds: string[] = [];
    for (const [position, match] of matchedPlaces.entries()) {
      const placeId = await persistMatchedPlace(
        admin,
        reelId,
        processingToken,
        position,
        match,
        // 장소 썸네일의 인스타 폴백에도 정사각(og:image) 대신 원본 비율 주소를 쓴다.
        thumbnailSource,
        stub,
      );
      placeIds.push(placeId);
    }

    // 5. worker 결과를 immutable 공용 cache로 확정하고, 이 추출을 기다리는
    // 모든 요청 히스토리와 사용자별 대기함/자동 저장을 한 transaction에서 맞춘다.
    const { error: finalizeError } = await admin.rpc(
      "finalize_reel_extraction",
      {
        p_extraction_id: extractionId,
        p_worker_reel_id: workerReelId,
        p_processing_token: processingToken,
        // 일부 장소의 매칭이 실패한 성공 결과는 당시 히스토리에는 남기되,
        // 다음 명시 요청이 새 extraction을 만들어 누락 장소를 다시 시도한다.
        p_cacheable: matchFailures.length === 0,
      },
    );
    if (finalizeError) throw finalizeError;

    return {
      status: "COMPLETED",
      placeId: placeIds[0],
      placeIds,
    };
  } catch (error) {
    if (error instanceof AiProvidersExhaustedError) {
      console.error(JSON.stringify({
        event: "ai_pipeline_failed",
        reelId,
        attempts: error.attempts.map((attempt) => ({
          provider: attempt.provider,
          operation: attempt.operation,
          kind: attempt.kind,
          status: attempt.status,
          model: attempt.model,
        })),
      }));
      return await failWorker(aiFailureReason(error));
    }
    console.error(JSON.stringify({
      event: "reel_processing_failed",
      reelId,
      message: error instanceof Error ? error.message : String(error),
    }));
    return await failWorker("UNKNOWN");
  }
}

async function persistPlaceMatchFailures(
  admin: SupabaseClient,
  reelId: string,
  processingToken: string,
  failures: PlaceMatchFailure[],
): Promise<void> {
  if (failures.length === 0) return;

  const { error } = await admin.from("reel_place_match_failures").upsert(
    failures.map((failure) => ({
      ...placeMatchFailureRow(reelId, failure),
      processing_token: processingToken,
    })),
    { onConflict: "reel_id,guess_index" },
  );
  if (error) throw error;
}

async function persistMatchedPlace(
  admin: SupabaseClient,
  reelId: string,
  processingToken: string,
  position: number,
  { guess, place }: MatchedPlace,
  instagramThumbnailUrl: string | null,
  stub: boolean,
): Promise<string> {
  const { data: placeRow, error: placeError } = await admin
    .from("places")
    .upsert(
      {
        kakao_place_id: place.kakaoPlaceId,
        name: place.name,
        category: place.category,
        road_address: place.roadAddress,
        address: place.address,
        ...(guess.address ? { source_address: guess.address } : {}),
        latitude: place.latitude,
        longitude: place.longitude,
        kakao_place_url: buildKakaoMapURL(place.kakaoPlaceId),
        telephone: place.telephone,
      },
      { onConflict: "kakao_place_id" },
    )
    .select("id, thumbnail_url, google_place_id")
    .single();
  if (placeError || !placeRow) throw placeError ?? new Error("place_missing");

  const thumbnail = placeRow.thumbnail_url
    ? {
      url: placeRow.thumbnail_url as string,
      source: null,
      googlePlaceId: null,
      attribution: null,
    }
    : await resolveThumbnail(
      admin,
      `${reelId}-${position}`,
      place,
      instagramThumbnailUrl,
      stub,
    );

  if (!placeRow.thumbnail_url && thumbnail.url) {
    const { error } = await admin
      .from("places")
      .update({
        google_place_id: thumbnail.googlePlaceId,
        thumbnail_url: thumbnail.url,
        thumbnail_source: thumbnail.source,
        photo_attribution: thumbnail.attribution,
      })
      .eq("id", placeRow.id);
    if (error) throw error;
  }

  await persistReelPlaceResult(
    admin,
    reelId,
    placeRow.id as string,
    position,
    thumbnail.url,
    processingToken,
  );

  return placeRow.id as string;
}

async function persistReelPlaceResult(
  admin: SupabaseClient,
  reelId: string,
  placeId: string,
  position: number,
  thumbnailUrl: string | null,
  processingToken: string | null = null,
): Promise<string> {
  const { data, error } = await admin.rpc("persist_reel_place_result", {
    p_reel_id: reelId,
    p_place_id: placeId,
    p_position: position,
    p_thumbnail_url: thumbnailUrl,
    p_processing_token: processingToken,
  });
  if (error || typeof data !== "string") {
    throw error ?? new Error("reel_place_result_missing");
  }
  return data;
}

interface ThumbnailResult {
  url: string | null;
  source: "google_places" | "instagram" | "kakao" | null;
  googlePlaceId: string | null;
  attribution: string | null;
}

async function reserveGooglePlacesThumbnail(
  admin: SupabaseClient,
): Promise<boolean> {
  const { data, error } = await admin.rpc("reserve_google_places_thumbnail");
  if (error) {
    console.warn(JSON.stringify({
      event: "google_places_thumbnail_skipped",
      reason: "reservation_error",
      message: error.message,
    }));
    return false;
  }
  if (data !== true) {
    console.info(JSON.stringify({
      event: "google_places_thumbnail_skipped",
      reason: "monthly_quota_exhausted",
    }));
    return false;
  }
  return true;
}

async function resolveThumbnail(
  admin: SupabaseClient,
  thumbnailKey: string,
  place: {
    name: string;
    roadAddress: string | null;
    address: string | null;
    placeUrl: string | null;
  },
  instagramThumbnailUrl: string | null,
  stub: boolean,
): Promise<ThumbnailResult> {
  if (stub) {
    const url = await rehostThumbnail(
      admin,
      `${thumbnailKey}-google`,
      STUB_THUMBNAIL.url,
    );
    if (url) {
      return {
        url,
        source: "google_places",
        googlePlaceId: STUB_THUMBNAIL.googlePlaceId,
        attribution: STUB_THUMBNAIL.attribution,
      };
    }
  }

  const googleKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!googleKey) {
    console.info(JSON.stringify({
      event: "google_places_thumbnail_skipped",
      reason: "missing_api_key",
      thumbnailKey,
      placeName: place.name,
    }));
  } else if (await reserveGooglePlacesThumbnail(admin)) {
    const q = [place.name, place.roadAddress ?? place.address].filter(Boolean)
      .join(" ");
    const googlePhoto = await findGooglePlacePhoto(q, googleKey);
    if (googlePhoto) {
      const url = await rehostThumbnail(
        admin,
        `${thumbnailKey}-google`,
        googlePhoto.photoUri,
      );
      if (url) {
        return {
          url,
          source: "google_places",
          googlePlaceId: googlePhoto.placeId,
          attribution: googlePhoto.attribution,
        };
      }
      console.warn(JSON.stringify({
        event: "google_places_thumbnail_failed",
        reason: "rehost_failed",
        thumbnailKey,
        placeName: place.name,
        googlePlaceId: googlePhoto.placeId,
      }));
    } else {
      console.info(JSON.stringify({
        event: "google_places_thumbnail_failed",
        reason: "photo_not_found",
        thumbnailKey,
        placeName: place.name,
        query: q,
      }));
    }
  }

  if (instagramThumbnailUrl) {
    console.info(JSON.stringify({
      event: "thumbnail_fallback_selected",
      source: "instagram",
      thumbnailKey,
      placeName: place.name,
    }));
    const url = await rehostThumbnail(
      admin,
      `${thumbnailKey}-instagram`,
      instagramThumbnailUrl,
    );
    if (url) {
      return {
        url,
        source: "instagram",
        googlePlaceId: null,
        attribution: null,
      };
    }
  }

  const kakaoImage = await scrapePageImage(place.placeUrl);
  if (kakaoImage) {
    const url = await rehostThumbnail(
      admin,
      `${thumbnailKey}-kakao`,
      kakaoImage,
    );
    if (url) {
      return { url, source: "kakao", googlePlaceId: null, attribution: null };
    }
  }

  return { url: null, source: null, googlePlaceId: null, attribution: null };
}

async function fail(
  admin: SupabaseClient,
  extractionId: string,
  workerReelId: string,
  processingToken: string,
  reason: FailureReason,
): Promise<ProcessResult> {
  const { error } = await admin.rpc("fail_reel_extraction", {
    p_extraction_id: extractionId,
    p_worker_reel_id: workerReelId,
    p_processing_token: processingToken,
    p_failure_reason: reason,
  });
  if (error) {
    console.error(JSON.stringify({
      event: "reel_extraction_failure_persist_failed",
      extractionId,
      workerReelId,
      failureReason: reason,
      message: error.message,
    }));
  }
  return { status: "FAILED", failureReason: reason };
}
