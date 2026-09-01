// 사진 게시물(/p/)의 썸네일을 원본 비율로 갈아끼우는 일회성 백필 스크립트.
//
// og:image 로 저장된 사진 게시물 썸네일은 인스타가 정사각으로 잘라서 준 버전이다.
// embed 페이지(로그인 불필요)의 display_url 에는 원본 비율 주소가 있으므로,
// 이를 내려받아 리사이즈(긴 변 640px, JPEG q78)한 뒤 스토리지의 같은 경로에 덮어쓴다.
// DB 의 썸네일 주소는 이미 스토리지 공개 URL 이라 건드리지 않는다.
//
// 캐시 무효화를 위해 기존 경로에 덮어쓰지 않고 새 경로("reels/{id}-v2.jpg")로 올린 뒤
// DB 주소를 교체한다(주소가 바뀌어야 클라이언트가 캐시를 버리고 새로 받아간다).
// 이미 -v2 주소인 행과 embed 에서 원본을 못 찾은 행은 건너뛰므로 여러 번 실행해도 안전하다.
// 같은 게시물을 여러 사용자가 저장한 경우 embed 요청은 한 번만 보낸다.
//
// 사용법:
//   npm install jimp@0.22.12 @supabase/supabase-js@2
//   SUPABASE_URL=https://<project-ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service_role 키> \
//   node supabase/scripts/backfill-photo-thumbnails.mjs

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

// embed 페이지에서 이중 이스케이프된 display_url(원본 비율 주소)을 뽑는다. 실패하면 null.
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

const { data: reels, error: listError } = await supabase
  .from("reels")
  .select("id, instagram_url, instagram_thumbnail_url")
  .like("instagram_url", "%/p/%")
  .not("instagram_thumbnail_url", "is", null);
if (listError) {
  console.error("목록 조회 실패:", listError.message);
  process.exit(1);
}
console.log(`사진 게시물 ${reels.length}건 처리 시작`);

const displayUrlCache = new Map();
let done = 0;
let noOriginal = 0;
let skipped = 0;
let failed = 0;

for (const reel of reels) {
  try {
    if (reel.instagram_thumbnail_url.includes("-v2.jpg")) {
      skipped += 1;
      continue; // 이미 교체된 행
    }
    let freshUrl;
    if (displayUrlCache.has(reel.instagram_url)) {
      freshUrl = displayUrlCache.get(reel.instagram_url);
    } else {
      freshUrl = await fetchEmbedDisplayUrl(reel.instagram_url);
      displayUrlCache.set(reel.instagram_url, freshUrl);
      await sleep(FETCH_DELAY_MS);
    }
    if (!freshUrl) {
      noOriginal += 1;
      console.warn(`${reel.id}: embed 에서 원본을 못 찾음 - 현상 유지`);
      continue;
    }

    const imgRes = await fetch(freshUrl, { headers: { "User-Agent": UA } });
    if (!imgRes.ok) {
      failed += 1;
      console.warn(`${reel.id}: 이미지 다운로드 실패 (${imgRes.status})`);
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

    const path = `reels/${reel.id}-v2.jpg`;
    const { error: upError } = await supabase.storage
      .from(BUCKET)
      .upload(path, after, {
        contentType: "image/jpeg",
        upsert: true,
        cacheControl: "31536000",
      });
    if (upError) throw new Error(`업로드 실패 - ${upError.message}`);

    const publicUrl = `${url.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${path}`;
    const { error: dbError } = await supabase
      .from("reels")
      .update({ instagram_thumbnail_url: publicUrl })
      .eq("id", reel.id);
    if (dbError) throw new Error(`DB 갱신 실패 - ${dbError.message}`);

    done += 1;
    console.log(`${reel.id}: ${width}x${height} 원본 비율로 교체 완료`);
  } catch (e) {
    failed += 1;
    console.error(`${reel.id}: 실패 - ${e.message}`);
  }
}

console.log(`\n교체 ${done}건, 원본 못 찾음 ${noOriginal}건, 건너뜀 ${skipped}건, 실패 ${failed}건`);
