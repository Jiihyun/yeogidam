// 인스타 폴백으로 저장된 장소 썸네일(thumbnail_source='instagram')을
// 잘리지 않은 원본 비율 이미지로 갈아끼우는 일회성 백필 스크립트.
//
// 기존 파일은 og:image(사진 게시물이면 정사각 크롭)를 저장한 것이다. 파일명이
// "{게시물id}-{순번}-instagram.jpg" 규칙이라 출처 게시물을 역추적할 수 있고,
// 게시물의 embed 페이지에서 원본 비율 주소(display_url)를 받아 다시 저장한다.
//
// 캐시 무효화를 위해 같은 경로에 덮어쓰지 않고 새 경로("...-v2.jpg")로 올린 뒤
// places 와 saved_places 양쪽의 주소를 교체한다(주소가 바뀌어야 클라이언트가
// 1년짜리 캐시를 버리고 새로 받아간다). 원본을 못 찾으면 건너뛴다(현상 유지).
//
// 사용법:
//   npm install jimp@0.22.12 @supabase/supabase-js@2
//   SUPABASE_URL=https://<project-ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service_role 키> \
//   node supabase/scripts/backfill-place-thumbnails.mjs

import { createClient } from "@supabase/supabase-js";
import Jimp from "jimp";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

const supabase = createClient(url, serviceKey);
const BUCKET = "place-thumbnails";
const MAX_DIMENSION = 640;
const JPEG_QUALITY = 78;
const FETCH_DELAY_MS = 2000;
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// embed 페이지에서 원본 비율 주소(display_url)를 뽑는다. 실패하면 null.
async function fetchEmbedDisplayUrl(postUrl) {
  const base = postUrl.split(/[?#]/)[0].replace(/\/$/, "");
  const res = await fetch(`${base}/embed/`, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/display_url\\+"\s*:\s*\\+"(.+?)\\+"/);
  if (!m) return null;
  const decoded = m[1]
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\+\//g, "/");
  return decoded.startsWith("https://") ? decoded : null;
}

// 게시물 페이지의 og:image 를 읽는다(embed 실패 시 폴백). 실패하면 null.
async function fetchOgImage(postUrl) {
  const res = await fetch(postUrl, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  );
  return m ? m[1].replaceAll("&amp;", "&") : null;
}

const { data: places, error: listError } = await supabase
  .from("places")
  .select("id, name, thumbnail_url")
  .eq("thumbnail_source", "instagram")
  .not("thumbnail_url", "is", null);
if (listError) {
  console.error("목록 조회 실패:", listError.message);
  process.exit(1);
}
console.log(`인스타 폴백 장소 썸네일 ${places.length}건 처리 시작`);

const imageUrlCache = new Map();
let done = 0;
let skipped = 0;
let failed = 0;

for (const p of places) {
  try {
    const basename = p.thumbnail_url.split("/").pop().split("?")[0];
    if (basename.endsWith("-v2.jpg")) {
      skipped += 1;
      continue; // 이미 교체된 행
    }
    const reelId = basename.slice(0, 36);
    const { data: reel, error: reelError } = await supabase
      .from("reels")
      .select("instagram_url")
      .eq("id", reelId)
      .maybeSingle();
    if (reelError) throw new Error(reelError.message);
    if (!reel?.instagram_url) {
      skipped += 1;
      console.warn(`${p.name}(${p.id.slice(0, 8)}): 출처 게시물 없음 - 건너뜀`);
      continue;
    }

    let freshUrl;
    if (imageUrlCache.has(reel.instagram_url)) {
      freshUrl = imageUrlCache.get(reel.instagram_url);
    } else {
      freshUrl = (await fetchEmbedDisplayUrl(reel.instagram_url)) ??
        (await fetchOgImage(reel.instagram_url));
      imageUrlCache.set(reel.instagram_url, freshUrl);
      await sleep(FETCH_DELAY_MS);
    }
    if (!freshUrl) {
      skipped += 1;
      console.warn(`${p.name}(${p.id.slice(0, 8)}): 원본을 못 찾음 - 현상 유지`);
      continue;
    }

    const imgRes = await fetch(freshUrl, { headers: { "User-Agent": UA } });
    if (!imgRes.ok) {
      failed += 1;
      console.warn(`${p.name}(${p.id.slice(0, 8)}): 다운로드 실패 (${imgRes.status})`);
      continue;
    }
    const before = Buffer.from(await imgRes.arrayBuffer());

    let after = before;
    let width = null;
    let height = null;
    try {
      const img = await Jimp.read(before);
      if (Math.max(img.getWidth(), img.getHeight()) > MAX_DIMENSION) {
        img.scaleToFit(MAX_DIMENSION, MAX_DIMENSION);
      }
      width = img.getWidth();
      height = img.getHeight();
      after = await img.quality(JPEG_QUALITY).getBufferAsync(Jimp.MIME_JPEG);
    } catch {
      // 디코딩 실패 시 원본 그대로 올린다.
    }

    const newPath = basename.replace(/\.jpg$/, "-v2.jpg");
    const { error: upError } = await supabase.storage
      .from(BUCKET)
      .upload(newPath, after, {
        contentType: "image/jpeg",
        upsert: true,
        cacheControl: "31536000",
      });
    if (upError) throw new Error(`업로드 실패 - ${upError.message}`);

    const newUrl = `${url.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${newPath}`;
    const { error: placeDbError } = await supabase
      .from("places")
      .update({ thumbnail_url: newUrl })
      .eq("id", p.id);
    if (placeDbError) throw new Error(`places 갱신 실패 - ${placeDbError.message}`);

    const { error: savedDbError } = await supabase
      .from("saved_places")
      .update({ thumbnail_url: newUrl })
      .eq("place_id", p.id);
    if (savedDbError) {
      throw new Error(`saved_places 갱신 실패 - ${savedDbError.message}`);
    }

    done += 1;
    console.log(`${p.name}(${p.id.slice(0, 8)}): ${width}x${height} 교체 완료`);
  } catch (e) {
    failed += 1;
    console.error(`${p.name}(${p.id.slice(0, 8)}): 실패 - ${e.message}`);
  }
}

console.log(`\n교체 ${done}건, 건너뜀 ${skipped}건, 실패 ${failed}건`);
