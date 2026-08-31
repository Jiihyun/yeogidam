// 기존 place-thumbnails 객체 전체를 리사이즈(긴 변 640px, JPEG q78)하고
// cache-control 을 1년으로 다시 설정하는 일회성 백필 스크립트.
//
// 같은 경로에 덮어쓰므로 DB 에 저장된 공개 URL 은 그대로 유효하다.
// 리사이즈에 실패한 파일(GIF 등)도 cache-control 갱신을 위해 원본 그대로 다시 올린다.
//
// 사용법:
//   npm install jimp@0.22.12 @supabase/supabase-js@2
//   SUPABASE_URL=https://<project-ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service_role 키> \
//   node supabase/scripts/backfill-thumbnails.mjs

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

const { data: objects, error: listError } = await supabase.storage
  .from(BUCKET)
  .list("", { limit: 1000 });
if (listError) {
  console.error("목록 조회 실패:", listError.message);
  process.exit(1);
}
console.log(`대상 파일 ${objects.length}개`);

let resized = 0;
let kept = 0;
let failed = 0;
let savedBytes = 0;

for (const obj of objects) {
  const path = obj.name;
  try {
    const { data: blob, error: dlError } = await supabase.storage
      .from(BUCKET)
      .download(path);
    if (dlError) throw new Error(dlError.message);

    const before = Buffer.from(await blob.arrayBuffer());
    let after = before;
    let contentType = obj.metadata?.mimetype ?? "image/jpeg";

    try {
      const img = await Jimp.read(before);
      if (Math.max(img.getWidth(), img.getHeight()) > MAX_DIMENSION) {
        img.scaleToFit(MAX_DIMENSION, MAX_DIMENSION);
      }
      const encoded = await img.quality(JPEG_QUALITY).getBufferAsync(Jimp.MIME_JPEG);
      if (encoded.length < before.length) {
        after = encoded;
        contentType = "image/jpeg";
      }
    } catch {
      // 디코딩 실패 시 원본을 유지하고 cache-control 만 갱신한다.
    }

    const { error: upError } = await supabase.storage
      .from(BUCKET)
      .upload(path, after, { contentType, upsert: true, cacheControl: "31536000" });
    if (upError) throw new Error(upError.message);

    savedBytes += before.length - after.length;
    if (after === before) {
      kept += 1;
    } else {
      resized += 1;
    }
    console.log(`${path}: ${before.length} -> ${after.length} bytes`);
  } catch (e) {
    failed += 1;
    console.error(`${path}: 실패 - ${e.message}`);
  }
}

console.log(
  `\n리사이즈 ${resized}건, 원본 유지(캐시만 갱신) ${kept}건, 실패 ${failed}건, ` +
    `절감 ${(savedBytes / 1024 / 1024).toFixed(1)}MB`,
);
