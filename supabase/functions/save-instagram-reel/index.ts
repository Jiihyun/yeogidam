// POST /functions/v1/save-instagram-reel
// 1) JWT 인증 → 2) IG URL 검증 → 3) reels(PROCESSING) insert → 4) 202 즉시 반환
// → 5) waitUntil 백그라운드 파이프라인(IG 추출 → Gemini 다중 장소 추출 → Kakao 검증 → 썸네일 → DB)
//
// 로컬 검증용: 환경변수 PIPELINE_SYNC=1 이면 백그라운드 대신 동기로 처리하고
// 최종 상태를 응답에 담아 반환한다(테스트 편의). 프로덕션 기본은 비동기(202).

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { fetchInstagramMeta } from "./instagram.ts";
import { extractKoreanAddresses } from "./address.ts";
import { extractPlacesWithGemini, type PlaceGuess } from "./gemini.ts";
import {
  buildKakaoMapURL,
  type KakaoPlace,
  searchKakaoPlaces,
} from "./kakao.ts";
import {
  buildKakaoQueries,
  sanitizePlaceGuesses,
  verifiedKakaoPlaces,
} from "./matching.ts";
import { findGooglePlacePhoto } from "./google.ts";
import { rehostThumbnail, scrapePageImage } from "./thumbnail.ts";

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

// 로컬 검증 전용 스텁 (STUB_PROVIDERS=1 일 때만 사용). Gemini/Kakao 키 없이
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
  placeIds?: string[];
}

interface MatchedPlace {
  guess: PlaceGuess;
  place: KakaoPlace;
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

    // 2. 정규식 추출은 의사결정에 쓰지 않고 커버리지 관측용으로만 남겨둔다.
    const regexAddresses = extractKoreanAddresses(caption);
    console.info(JSON.stringify({
      event: "regex_addresses_shadow",
      reelId,
      addresses: regexAddresses,
    }));

    // 3. Gemini가 전체 캡션에서 모든 장소를 구조화하고, 원문에 실제 있는 문자열만 남긴다.
    const kakaoKey = Deno.env.get("KAKAO_REST_API_KEY");
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!stub && (!kakaoKey || !geminiKey)) {
      return await fail(admin, reelId, "PLACE_NOT_FOUND");
    }

    let matchedPlaces: MatchedPlace[] = [];
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
    } else if (caption) {
      const extracted = await extractPlacesWithGemini(caption, geminiKey!);
      const guesses = sanitizePlaceGuesses(extracted, caption);
      console.info(JSON.stringify({
        event: "gemini_place_guesses_sanitized",
        reelId,
        extractedCount: extracted.length,
        sanitizedCount: guesses.length,
      }));

      for (const guess of guesses) {
        const candidates: KakaoPlace[] = [];
        for (const query of buildKakaoQueries(guess)) {
          candidates.push(
            ...await searchKakaoPlaces(query, kakaoKey!),
          );
        }
        const verified = verifiedKakaoPlaces(guess, candidates);
        console.info(JSON.stringify({
          event: "kakao_place_candidates_verified",
          reelId,
          guess,
          candidateCount: candidates.length,
          verifiedCount: verified.length,
          verifiedPlaceIds: verified.map((place) => place.kakaoPlaceId),
        }));

        // 0개는 실패, 2개 이상은 모호함이다. 유일하게 검증된 장소만 저장한다.
        if (verified.length === 1) {
          matchedPlaces.push({ guess, place: verified[0] });
        }
      }
    }
    matchedPlaces = deduplicateMatchedPlaces(matchedPlaces);
    if (matchedPlaces.length === 0) {
      return await fail(admin, reelId, "PLACE_NOT_FOUND");
    }

    // 4. 검증된 모든 장소를 places/saved_places/reel_places에 순서대로 저장한다.
    const placeIds: string[] = [];
    for (const [position, match] of matchedPlaces.entries()) {
      const placeId = await persistMatchedPlace(
        admin,
        reelId,
        userId,
        position,
        match,
        meta.thumbnailUrl,
        stub,
      );
      placeIds.push(placeId);
    }

    // 5. 기존 앱 호환을 위해 reels.place_id는 첫 번째 장소를 가리킨다.
    const { error: reelUpdateError } = await admin
      .from("reels")
      .update({
        place_id: placeIds[0],
        processing_status: "COMPLETED",
        failure_reason: null,
      })
      .eq("id", reelId);
    if (reelUpdateError) throw reelUpdateError;

    return {
      status: "COMPLETED",
      placeId: placeIds[0],
      placeIds,
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: "reel_processing_failed",
      reelId,
      message: error instanceof Error ? error.message : String(error),
    }));
    return await fail(admin, reelId, "UNKNOWN");
  }
}

function deduplicateMatchedPlaces(matches: MatchedPlace[]): MatchedPlace[] {
  const unique = new Map<string, MatchedPlace>();
  for (const match of matches) {
    if (!unique.has(match.place.kakaoPlaceId)) {
      unique.set(match.place.kakaoPlaceId, match);
    }
  }
  return [...unique.values()];
}

async function persistMatchedPlace(
  admin: SupabaseClient,
  reelId: string,
  userId: string,
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

  const { error: savedPlaceError } = await admin
    .from("saved_places")
    .upsert(
      {
        user_id: userId,
        place_id: placeRow.id,
        thumbnail_url: thumbnail.url,
      },
      { onConflict: "user_id,place_id", ignoreDuplicates: true },
    );
  if (savedPlaceError) throw savedPlaceError;

  const { error: reelPlaceError } = await admin
    .from("reel_places")
    .upsert(
      { reel_id: reelId, place_id: placeRow.id, position },
      { onConflict: "reel_id,place_id" },
    );
  if (reelPlaceError) throw reelPlaceError;

  return placeRow.id as string;
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
  return !error && data === true;
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
  if (googleKey && await reserveGooglePlacesThumbnail(admin)) {
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
    }
  }

  if (instagramThumbnailUrl) {
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
  reelId: string,
  reason: FailureReason,
): Promise<ProcessResult> {
  await admin
    .from("reels")
    .update({ processing_status: "FAILED", failure_reason: reason })
    .eq("id", reelId);
  return { status: "FAILED", failureReason: reason };
}
