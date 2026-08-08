-- 여기담 핵심 스키마: profiles / places / reels / saved_places

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nickname    text,
  description text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.places (
  id                  uuid primary key default gen_random_uuid(),
  naver_place_id      text unique,
  name                text not null,
  category            text,
  road_address        text,
  address             text,
  latitude            double precision,
  longitude           double precision,
  naver_link          text,
  naver_thumbnail_url text,
  telephone           text,
  created_at          timestamptz not null default now()
);

create table public.reels (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  place_id                uuid references public.places(id) on delete set null,
  instagram_url           text not null,
  instagram_title         text,
  instagram_description   text,
  instagram_thumbnail_url text,
  source                  text not null default 'instagram_share'
                            check (source in ('instagram_share', 'url_input')),
  processing_status       text not null default 'PENDING'
                            check (processing_status in ('PENDING','PROCESSING','COMPLETED','FAILED')),
  failure_reason          text
                            check (failure_reason in ('IG_FETCH_FAILED','PLACE_NOT_FOUND','UNKNOWN')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table public.saved_places (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  place_id      uuid not null references public.places(id) on delete cascade,
  thumbnail_url text,
  created_at    timestamptz not null default now(),
  unique (user_id, place_id)
);

-- 목록 조회용 인덱스
create index idx_reels_user_created        on public.reels (user_id, created_at desc);
create index idx_reels_user_place          on public.reels (user_id, place_id);
create index idx_saved_places_user_created on public.saved_places (user_id, created_at desc);
