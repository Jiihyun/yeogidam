-- 대기함/히스토리 기능이 운영 앱보다 먼저 배포되어 기존 saved_places 계약이 깨진 상태를 복구한다.
-- 이미 저장 또는 삭제 확정된 관계는 그대로 존중하고, 미확정 관계만 기존 자동 저장 정책으로 이관한다.

lock table public.reel_places in access exclusive mode;

insert into public.saved_places (user_id, place_id, thumbnail_url)
select distinct
  reel.user_id,
  reel_place.place_id,
  place.thumbnail_url
from public.reel_places as reel_place
join public.reels as reel
  on reel.id = reel_place.reel_id
join public.places as place
  on place.id = reel_place.place_id
where reel_place.review_status = 'PENDING'
on conflict (user_id, place_id) do nothing;

drop function if exists public.resolve_queue_items(uuid[], text);
drop table if exists public.reel_reports;

drop index if exists public.idx_reel_places_pending;

alter table public.reel_places
  drop constraint if exists reel_places_reviewed_at_check,
  drop constraint if exists reel_places_review_status_check,
  drop constraint if exists reel_places_id_key,
  drop column if exists reviewed_at,
  drop column if exists review_status,
  drop column if exists id;
