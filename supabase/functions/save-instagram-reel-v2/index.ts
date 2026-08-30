// POST /functions/v1/save-instagram-reel-v2
// Supabase의 /functions/v1은 gateway 버전이며, 함수 이름의 -v2가 앱 API 버전이다.
import { createSaveInstagramReelHandler } from "../save-instagram-reel/index.ts";
import { REVIEW_QUEUE } from "../save-instagram-reel/workflow.ts";

Deno.serve(createSaveInstagramReelHandler(REVIEW_QUEUE));
