-- 장소 대표 썸네일 캐시.
-- 같은 장소를 여러 사용자가 저장해도 외부 사진 API 호출을 반복하지 않도록 places 단위로 저장한다.

alter table public.places
  add column google_place_id text,
  add column thumbnail_url text,
  add column thumbnail_source text
    check (thumbnail_source in ('google_places', 'instagram', 'naver', 'manual')),
  add column photo_attribution text;

create index idx_places_google_place_id on public.places (google_place_id);
