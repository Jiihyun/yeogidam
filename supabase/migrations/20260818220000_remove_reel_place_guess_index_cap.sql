-- Gemini 장소 추출 개수 상한을 제거했으므로 10번째 이후 장소의
-- 실패 진단도 저장할 수 있게 guess_index는 음수만 거부한다.

alter table public.reel_place_match_failures
  drop constraint if exists reel_place_match_failures_guess_index_check;

alter table public.reel_place_match_failures
  add constraint reel_place_match_failures_guess_index_nonnegative_check
  check (guess_index >= 0);
