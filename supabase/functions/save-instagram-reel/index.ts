// POST /functions/v1/save-instagram-reel
// 1) JWT 인증 → 2) IG URL 검증 → 3) reels(PROCESSING) insert → 4) 202 즉시 반환
// → 5) waitUntil 백그라운드 파이프라인(IG 추출 → 주소/장소 → 네이버 매칭 → 썸네일 → DB)
//
// 로컬 검증용: 환경변수 PIPELINE_SYNC=1 이면 백그라운드 대신 동기로 처리하고
// 최종 상태를 응답에 담아 반환한다(테스트 편의). 프로덕션 기본은 비동기(202).

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { fetchInstagramMeta } from "./instagram.ts";
import { extractKoreanAddress } from "./address.ts";
import { extractPlaceWithGemini } from "./gemini.ts";
import { searchNaverPlace } from "./naver.ts";
import { findGooglePlacePhoto } from "./google.ts";
import { rehostThumbnail, scrapeNaverImage } from "./thumbnail.ts";

// Supabase Edge Runtime 전역 (백그라운드 처리)
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const IG_RE =
  /^https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+/i;

type FailureReason = "IG_FETCH_FAILED" | "PLACE_NOT_FOUND" | "UNKNOWN";

// 로컬 검증 전용 스텁 (STUB_PROVIDERS=1 일 때만 사용). Gemini/네이버 키 없이
// 파이프라인 전체(추출→매칭→저장→썸네일)를 결정적으로 검증하기 위한 것.
// 프로덕션에서는 이 플래그를 켜지 않는다.
const STUB_META = {
  title: "성수 카페 추천",
  description:
    "서울 성동구 연무장길 12 에 있는 여기담 스텁 카페 ☕️ 분위기 좋아요",
  thumbnailUrl: "https://picsum.photos/seed/yeogidam/600/600",
  canonicalUrl: null as string | null,
};
const STUB_PLACE = {
  naverPlaceId: "stub-1001",
  name: "여기담 스텁 카페",
  category: "카페",
  roadAddress: "서울 성동구 연무장길 12",
  address: "서울 성동구 성수동2가 273-14",
  latitude: 37.5445,
  longitude: 127.0557,
  link: null as string | null,
  telephone: null as string | null,
};
const STUB_THUMBNAIL = {
  googlePlaceId: "google-stub-1001",
  url: "https://picsum.photos/seed/yeogidam-google/600/600",
  attribution: "Google Places stub",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1) JWT 인증
  const token = (req.headers.get("Authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!token) return json({ error: "unauthorized" }, 401);
  const authClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser(
    token,
  );
  if (userErr || !userData.user) return json({ error: "unauthorized" }, 401);
  const userId = userData.user.id;

  // 2) 입력 검증
  let payload: { instagramUrl?: string; source?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const instagramUrl = (payload.instagramUrl ?? "").trim();
  const source = payload.source === "url_input"
    ? "url_input"
    : "instagram_share";
  if (!IG_RE.test(instagramUrl)) {
    return json({ error: "invalid_instagram_url" }, 400);
  }

  // 3) reels(PROCESSING) insert (service_role → RLS 우회)
  const admin = createClient(SUPABASE_URL, SERVICE);
  const { data: reel, error: insErr } = await admin
    .from("reels")
    .insert({
      user_id: userId,
      instagram_url: instagramUrl,
      source,
      processing_status: "PROCESSING",
    })
    .select("id")
    .single();
  if (insErr || !reel) return json({ error: "db_error" }, 500);

  // 4)/5) 동기(테스트) 또는 비동기(기본)
  const work = processReel(admin, reel.id, userId, instagramUrl);
  if (Deno.env.get("PIPELINE_SYNC") === "1") {
    const result = await work;
    return json({ reelId: reel.id, ...result }, 200);
  }
  EdgeRuntime.waitUntil(work);
  return json({ reelId: reel.id, status: "PROCESSING" }, 202);
});

interface ProcessResult {
  status: "COMPLETED" | "FAILED";
  failureReason?: FailureReason;
  placeId?: string;
}

async function processReel(
  admin: SupabaseClient,
  reelId: string,
  userId: string,
  instagramUrl: string,
): Promise<ProcessResult> {
  const stub = Deno.env.get("STUB_PROVIDERS") === "1";
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
      return await fail(admin, reelId, "IG_FETCH_FAILED");
    }
    await admin
      .from("reels")
      .update({
        instagram_title: meta.title,
        instagram_description: meta.description,
        instagram_thumbnail_url: meta.thumbnailUrl,
      })
      .eq("id", reelId);

    const caption = [meta.title, meta.description].filter(Boolean).join("\n");

    // 2. 상세주소 전체를 먼저 추출해 네이버 검색
    const naverId = Deno.env.get("NAVER_SEARCH_CLIENT_ID");
    const naverSecret = Deno.env.get("NAVER_SEARCH_CLIENT_SECRET");
    if (!stub && (!naverId || !naverSecret)) {
      return await fail(admin, reelId, "PLACE_NOT_FOUND");
    }

    const address = extractKoreanAddress(caption);
    let place = stub
      ? (address ? STUB_PLACE : null)
      : (address
        ? await searchNaverPlace(address, naverId!, naverSecret!)
        : null);

    // 3. 주소 검색 실패 시에만 Gemini로 장소명·지역을 추출해 재검색
    if (!place && !stub && caption) {
      const geminiKey = Deno.env.get("GEMINI_API_KEY");
      const guess = geminiKey
        ? await extractPlaceWithGemini(caption, geminiKey)
        : null;
      const placeName = guess?.placeName ?? null;
      const region = guess?.region ?? null;
      for (const q of buildQueries({ address, placeName, region })) {
        place = await searchNaverPlace(q, naverId!, naverSecret!);
        if (place) break;
      }
    }
    if (!place) return await fail(admin, reelId, "PLACE_NOT_FOUND");

    // 4. places upsert (naver_place_id 기준 중복 방지)
    const { data: placeRow, error: placeErr } = await admin
      .from("places")
      .upsert(
        {
          naver_place_id: place.naverPlaceId,
          name: place.name,
          category: place.category,
          road_address: place.roadAddress,
          address: place.address,
          ...(address ? { source_address: address } : {}),
          latitude: place.latitude,
          longitude: place.longitude,
          naver_link: place.link,
          telephone: place.telephone,
        },
        { onConflict: "naver_place_id" },
      )
      .select("id, thumbnail_url, google_place_id")
      .single();
    if (placeErr || !placeRow) return await fail(admin, reelId, "UNKNOWN");

    // 5. 썸네일: places 캐시 → Google Places → Instagram og:image → 네이버 스크래핑 → null(앱 로고)
    const thumbnail = placeRow.thumbnail_url
      ? {
        url: placeRow.thumbnail_url as string,
        source: null,
        googlePlaceId: null,
        attribution: null,
      }
      : await resolveThumbnail(admin, reelId, place, meta.thumbnailUrl, stub);

    if (!placeRow.thumbnail_url && thumbnail.url) {
      await admin
        .from("places")
        .update({
          google_place_id: thumbnail.googlePlaceId,
          thumbnail_url: thumbnail.url,
          thumbnail_source: thumbnail.source,
          photo_attribution: thumbnail.attribution,
        })
        .eq("id", placeRow.id);
    }

    // 6. saved_places upsert (user_id, place_id) — 이미 있으면 무시(장소 중복 방지)
    await admin
      .from("saved_places")
      .upsert(
        {
          user_id: userId,
          place_id: placeRow.id,
          thumbnail_url: thumbnail.url,
        },
        { onConflict: "user_id,place_id", ignoreDuplicates: true },
      );

    // 7. reels 완료
    await admin
      .from("reels")
      .update({
        place_id: placeRow.id,
        processing_status: "COMPLETED",
        failure_reason: null,
      })
      .eq("id", reelId);

    return { status: "COMPLETED", placeId: placeRow.id };
  } catch {
    return await fail(admin, reelId, "UNKNOWN");
  }
}

interface ThumbnailResult {
  url: string | null;
  source: "google_places" | "instagram" | "naver" | null;
  googlePlaceId: string | null;
  attribution: string | null;
}

async function reserveGooglePlacesThumbnail(
  admin: SupabaseClient,
): Promise<boolean> {
  const { data, error } = await admin.rpc("reserve_google_places_thumbnail");
  return !error && data === true;
}

async function resolveThumbnail(
  admin: SupabaseClient,
  reelId: string,
  place: {
    name: string;
    roadAddress: string | null;
    address: string | null;
    link: string | null;
  },
  instagramThumbnailUrl: string | null,
  stub: boolean,
): Promise<ThumbnailResult> {
  if (stub) {
    const url = await rehostThumbnail(
      admin,
      `${reelId}-google`,
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
  if (googleKey && await reserveGooglePlacesThumbnail(admin)) {
    const q = [place.name, place.roadAddress ?? place.address].filter(Boolean)
      .join(" ");
    const googlePhoto = await findGooglePlacePhoto(q, googleKey);
    if (googlePhoto) {
      const url = await rehostThumbnail(
        admin,
        `${reelId}-google`,
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
    }
  }

  if (instagramThumbnailUrl) {
    const url = await rehostThumbnail(
      admin,
      `${reelId}-instagram`,
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

  const naverImage = await scrapeNaverImage(place.link);
  if (naverImage) {
    const url = await rehostThumbnail(admin, `${reelId}-naver`, naverImage);
    if (url) {
      return { url, source: "naver", googlePlaceId: null, attribution: null };
    }
  }

  return { url: null, source: null, googlePlaceId: null, attribution: null };
}

function buildQueries(
  { address, placeName, region }: {
    address: string | null;
    placeName: string | null;
    region: string | null;
  },
): string[] {
  const q: string[] = [];
  if (region && placeName) q.push(`${region} ${placeName}`);
  if (placeName && address) q.push(`${placeName} ${address}`);
  if (placeName) q.push(placeName);
  return [...new Set(q.map((s) => s.trim()).filter(Boolean))];
}

async function fail(
  admin: SupabaseClient,
  reelId: string,
  reason: FailureReason,
): Promise<ProcessResult> {
  await admin
    .from("reels")
    .update({ processing_status: "FAILED", failure_reason: reason })
    .eq("id", reelId);
  return { status: "FAILED", failureReason: reason };
}
