-- Instagram shortcode를 외부 콘텐츠 식별자로 사용해 동일 사용자의 중복
-- 파싱을 막고, 완료된 다른 사용자의 장소 매칭 결과도 재사용할 수 있게 한다.

alter table public.reels
  add column instagram_shortcode text,
  add column processing_version integer not null default 1
    check (processing_version > 0);

update public.reels
set instagram_shortcode = (
  regexp_match(
    instagram_url,
    '/(reel|reels|p|tv)/([A-Za-z0-9_-]+)',
    'i'
  )
)[2]
where instagram_shortcode is null;

-- 이미 중복 저장된 릴스는 완료된 행을 우선 남긴다. saved_places는
-- (user_id, place_id)로 독립 영속화되어 있어 중복 reels 삭제의 영향을 받지 않는다.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, instagram_shortcode
      order by
        case processing_status
          when 'COMPLETED' then 0
          when 'PROCESSING' then 1
          when 'PENDING' then 2
          else 3
        end,
        created_at,
        id
    ) as duplicate_rank
  from public.reels
  where instagram_shortcode is not null
)
delete from public.reels
where id in (
  select id from ranked where duplicate_rank > 1
);

create unique index reels_user_instagram_shortcode_key
  on public.reels (user_id, instagram_shortcode)
  where instagram_shortcode is not null;

create index idx_reels_instagram_shortcode_completed
  on public.reels (instagram_shortcode, created_at)
  where processing_status = 'COMPLETED' and instagram_shortcode is not null;

comment on column public.reels.instagram_shortcode is
  'Instagram URL의 reel/reels/p/tv 경로에서 추출한 콘텐츠 식별자';

comment on column public.reels.processing_version is
  '장소 추출/매칭 알고리즘 버전. 현재 버전보다 낮으면 동일 행을 재처리한다.';
