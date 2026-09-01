// reels.instagram_thumbnail_url 이 인스타 직링크로 남아 있는 행을 복구하는 일회성 백필 스크립트.
//
// 인스타 직링크는 서명이 1~2주 뒤 만료되어 이미지가 깨진다. 게시물 주소(instagram_url)는
// 만료되지 않으므로, 게시물 페이지를 다시 읽어 새 og:image 링크를 얻은 뒤
// 리사이즈(긴 변 640px, JPEG q78)해서 place-thumbnails/reels/{id}.jpg 로 올리고
// DB 의 썸네일 주소를 우리 스토리지 공개 URL 로 교체한다.
//
// 이미 스토리지 주소인 행은 건너뛰므로 여러 번 실행해도 안전하다.
// 인스타 차단을 피하려고 게시물당 2초 간격을 둔다(전량 처리 시 수 분 소요).
//
// 사용법:
//   npm install jimp@0.22.12 @supabase/supabase-js@2
//   SUPABASE_URL=https://<project-ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service_role 키> \
//   node supabase/scripts/backfill-reel-thumbnails.mjs

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

// 게시물 페이지에서 og:image(새로 서명된 이미지 링크)를 읽는다. 실패하면 null.
async function fetchFreshImageUrl(postUrl) {
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

const { data: reels, error: listError } = await supabase
  .from("reels")
  .select("id, instagram_url, instagram_thumbnail_url")
  .not("instagram_thumbnail_url", "is", null);
if (listError) {
  console.error("목록 조회 실패:", listError.message);
  process.exit(1);
}

const targets = reels.filter(
  (r) => !r.instagram_thumbnail_url.includes("/storage/v1/object/public/"),
);
console.log(`전체 ${reels.length}건 중 인스타 직링크 ${targets.length}건 처리 시작`);

let done = 0;
let skipped = 0;
let failed = 0;

for (const reel of targets) {
  try {
    if (!reel.instagram_url) {
      skipped += 1;
      console.warn(`${reel.id}: 게시물 주소 없음 - 건너뜀`);
      continue;
    }

    const freshUrl = await fetchFreshImageUrl(reel.instagram_url);
    await sleep(FETCH_DELAY_MS);
    if (!freshUrl) {
      failed += 1;
      console.warn(`${reel.id}: og:image 없음(삭제·비공개 게시물 가능성) - 건너뜀`);
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
    try {
      const img = await Jimp.read(before);
      if (Math.max(img.getWidth(), img.getHeight()) > MAX_DIMENSION) {
        img.scaleToFit(MAX_DIMENSION, MAX_DIMENSION);
      }
      const encoded = await img.quality(JPEG_QUALITY).getBufferAsync(Jimp.MIME_JPEG);
      if (encoded.length < before.length) after = encoded;
    } catch {
      // 디코딩 실패 시 원본 그대로 올린다.
    }

    const path = `reels/${reel.id}.jpg`;
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
    console.log(`${reel.id}: ${before.length} -> ${after.length} bytes 교체 완료`);
  } catch (e) {
    failed += 1;
    console.error(`${reel.id}: 실패 - ${e.message}`);
  }
}

console.log(`\n교체 ${done}건, 건너뜀 ${skipped}건, 실패 ${failed}건`);
