-- 장소 중복 방지의 외부 자연키를 Kakao Local API 장소 ID로 전환한다.
-- 기존 Naver 컬럼은 과거 행 호환을 위해 유지하고 신규 행에서는 쓰지 않는다.

alter table public.places
  add column kakao_place_id text,
  add column kakao_place_url text,
  add constraint places_kakao_place_id_key unique (kakao_place_id);

alter table public.places
  drop constraint places_thumbnail_source_check,
  add constraint places_thumbnail_source_check
    check (thumbnail_source in ('google_places', 'instagram', 'kakao', 'naver', 'manual'));

comment on column public.places.kakao_place_id is
  'Kakao Local API가 반환한 안정적인 장소 ID; 신규 장소 dedup 기준';
comment on column public.places.kakao_place_url is
  'Kakao 지도 장소 ID 기반 상세 링크';
