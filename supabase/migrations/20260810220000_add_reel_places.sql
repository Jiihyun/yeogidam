-- 하나의 인스타그램 릴스에서 여러 장소가 추출될 수 있다.
-- reels.place_id는 기존 앱 호환을 위한 첫 번째 장소로 유지하고,
-- 전체 관계와 캡션 노출 순서는 reel_places에 저장한다.

create table public.reel_places (
  reel_id    uuid not null references public.reels(id) on delete cascade,
  place_id   uuid not null references public.places(id) on delete cascade,
  position   integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  primary key (reel_id, place_id),
  unique (reel_id, position)
);

create index idx_reel_places_place on public.reel_places (place_id);

alter table public.reel_places enable row level security;

-- Edge Function의 service_role만 쓰고, MVP 앱은 saved_places를 직접 조회한다.
grant select, insert, update, delete on public.reel_places to service_role;

comment on table public.reel_places is
  '릴스에서 검증된 모든 장소와 원문 노출 순서';
