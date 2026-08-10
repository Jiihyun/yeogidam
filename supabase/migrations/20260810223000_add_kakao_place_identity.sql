-- MVP 테스트 데이터를 비운 뒤 장소 공급자를 Naver에서 Kakao로 완전히 전환한다.
-- places.id는 앱 내부 PK로 유지하고 Kakao 장소 ID를 외부 자연키로 사용한다.

delete from public.saved_places;
delete from public.reels;
delete from public.places;

alter table public.places
  rename column naver_place_id to kakao_place_id;

alter table public.places
  rename constraint places_naver_place_id_key to places_kakao_place_id_key;

alter table public.places
  rename column naver_link to kakao_place_url;

alter table public.places
  drop column naver_thumbnail_url;

alter table public.places
  drop constraint places_thumbnail_source_check,
  add constraint places_thumbnail_source_check
    check (thumbnail_source in ('google_places', 'instagram', 'kakao', 'manual'));

comment on column public.places.kakao_place_id is
  'Kakao Local API가 반환한 안정적인 장소 ID; 신규 장소 dedup 기준';
comment on column public.places.kakao_place_url is
  'Kakao 지도 장소 ID 기반 상세 링크';
