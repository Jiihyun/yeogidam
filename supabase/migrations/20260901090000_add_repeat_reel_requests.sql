-- 같은 릴스를 명시적으로 다시 공유하면 요청 히스토리는 매번 남기되,
-- 장소 추출 결과는 shortcode + pipeline version 단위의 공용 캐시로 재사용한다.
-- 대기함은 요청 히스토리와 분리해 사용자별 open batch 한 건만 유지한다.

alter table public.saved_places
  add column last_saved_at timestamptz;

update public.saved_places
set last_saved_at = created_at
where last_saved_at is null;

alter table public.saved_places
  alter column last_saved_at set default now(),
  alter column last_saved_at set not null;

create index idx_saved_places_user_last_saved
  on public.saved_places (user_id, last_saved_at desc, id desc);

comment on column public.saved_places.last_saved_at is
  '사용자가 이 장소를 가장 최근에 저장한 시각. 재저장하면 행을 늘리지 않고 이 값을 갱신한다';

-- request_id가 있는 행은 명시적 요청 히스토리다. request_id가 없는 구버전
-- service insert는 전환 기간 동안 기존 사용자별 shortcode 중복 방지를 유지한다.
alter table public.reels
  add column request_id uuid;

drop index public.reels_user_instagram_shortcode_key;

create unique index reels_user_instagram_shortcode_key
  on public.reels (user_id, instagram_shortcode)
  where instagram_shortcode is not null
    and request_id is null;

create unique index reels_user_request_id_key
  on public.reels (user_id, request_id)
  where request_id is not null;

comment on column public.reels.request_id is
  '클라이언트가 한 명시적 공유 요청에 부여한 멱등 UUID. 사용자 안에서 유일하다';

alter table public.reel_places
  add column processing_token uuid;

comment on column public.reel_places.processing_token is
  '공용 extraction worker attempt token. stale attempt 행은 보존하되 finalize 결과에서는 제외한다';

create table public.reel_extractions (
  id uuid primary key default gen_random_uuid(),
  instagram_shortcode text not null,
  instagram_url text not null,
  pipeline_version integer not null check (pipeline_version > 0),
  worker_reel_id uuid references public.reels(id) on delete set null,
  processing_status text not null default 'PROCESSING'
    check (processing_status in ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  failure_reason text
    check (
      failure_reason in (
        'IG_FETCH_FAILED',
        'IG_CAPTION_NOT_FOUND',
        'PROVIDER_CONFIG_MISSING',
        'GEMINI_PLACE_NOT_FOUND',
        'KAKAO_PLACE_NOT_FOUND',
        'PLACE_NOT_FOUND',
        'UNKNOWN'
      )
    ),
  processing_token uuid not null default gen_random_uuid(),
  cacheable boolean not null default true,
  instagram_title text,
  instagram_description text,
  instagram_author_username text
    check (
      instagram_author_username is null
      or instagram_author_username ~ '^[a-z0-9._]{1,30}$'
    ),
  instagram_thumbnail_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (processing_status in ('PENDING', 'PROCESSING') and cacheable)
    or processing_status = 'COMPLETED'
    or (processing_status = 'FAILED' and not cacheable)
  )
);

-- 처리 중인 실행 또는 완전한 완료 캐시는 shortcode/version마다 하나뿐이다.
-- 부분 성공(COMPLETED/cacheable=false)과 실패는 불변 attempt로 남겨 두고,
-- 다음 요청이 새 extraction을 만들 수 있게 이 인덱스에서 제외한다.
create unique index reel_extractions_active_cache_key
  on public.reel_extractions (instagram_shortcode, pipeline_version)
  where processing_status in ('PENDING', 'PROCESSING')
     or (processing_status = 'COMPLETED' and cacheable);

create index idx_reel_extractions_shortcode_created
  on public.reel_extractions (instagram_shortcode, created_at desc);

create trigger set_reel_extractions_updated_at
  before update on public.reel_extractions
  for each row execute function public.set_updated_at();

comment on table public.reel_extractions is
  '사용자 요청과 분리된 Instagram 릴스 장소 추출 attempt 및 재사용 캐시';
comment on column public.reel_extractions.worker_reel_id is
  '기존 분석 파이프라인이 metadata/reel_places를 쓰는 최초 요청 reels 행';
comment on column public.reel_extractions.cacheable is
  'true인 완전 성공만 다음 요청에서 재사용한다. 부분 성공/실패 attempt는 false로 보존한다';

alter table public.reels
  add column extraction_id uuid
    references public.reel_extractions(id) on delete set null;

create index idx_reels_extraction
  on public.reels (extraction_id, created_at);

comment on column public.reels.extraction_id is
  '이 요청 히스토리가 참조하는 공용 릴스 추출 attempt';

create table public.reel_extraction_places (
  id uuid primary key default gen_random_uuid(),
  extraction_id uuid not null
    references public.reel_extractions(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  unique (extraction_id, place_id),
  unique (extraction_id, position)
);

create index idx_reel_extraction_places_place
  on public.reel_extraction_places (place_id, extraction_id);

comment on table public.reel_extraction_places is
  '완료된 공용 추출 attempt의 장소 목록과 원문 노출 순서';

create table public.reel_queue_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  extraction_id uuid not null
    references public.reel_extractions(id) on delete cascade,
  latest_reel_id uuid references public.reels(id) on delete set null,
  instagram_shortcode text not null,
  created_at timestamptz not null default now(),
  last_queued_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (resolved_at is null or resolved_at >= created_at)
);

create unique index reel_queue_batches_user_open_shortcode_key
  on public.reel_queue_batches (user_id, instagram_shortcode)
  where resolved_at is null;

create index idx_reel_queue_batches_user_last_queued
  on public.reel_queue_batches (user_id, last_queued_at desc, id desc)
  where resolved_at is null;

comment on table public.reel_queue_batches is
  '사용자별 대기함 카드. 같은 shortcode의 미처리 카드는 하나만 두고 재공유 시 상단으로 올린다';
comment on column public.reel_queue_batches.latest_reel_id is
  '이 대기함 카드를 가장 최근에 위로 올린 명시적 요청 히스토리';

create table public.reel_queue_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null
    references public.reel_queue_batches(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  position integer not null check (position >= 0),
  review_status text not null default 'PENDING'
    check (review_status in ('PENDING', 'SAVED', 'DISCARDED')),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (batch_id, place_id),
  unique (batch_id, position),
  check (
    (review_status = 'PENDING' and reviewed_at is null)
    or (review_status in ('SAVED', 'DISCARDED') and reviewed_at is not null)
  )
);

create index idx_reel_queue_items_batch_pending
  on public.reel_queue_items (batch_id, position)
  where review_status = 'PENDING';

comment on table public.reel_queue_items is
  '대기함 카드 안에서 사용자가 저장 또는 제외할 장소';

-- 이미 완료된 릴스 중 shortcode/version별 가장 이른 정상 결과를 공용
-- extraction으로 승격한다. 기존 reels/reel_places는 과거 히스토리 호환을 위해 둔다.
with ranked_completed as (
  select
    reel.*,
    row_number() over (
      partition by reel.instagram_shortcode, reel.processing_version
      order by reel.created_at, reel.id
    ) as source_rank
  from public.reels as reel
  where reel.instagram_shortcode is not null
    and reel.processing_status = 'COMPLETED'
)
insert into public.reel_extractions (
  instagram_shortcode,
  instagram_url,
  pipeline_version,
  worker_reel_id,
  processing_status,
  failure_reason,
  processing_token,
  cacheable,
  instagram_title,
  instagram_description,
  instagram_author_username,
  instagram_thumbnail_url,
  created_at,
  updated_at
)
select
  ranked.instagram_shortcode,
  ranked.instagram_url,
  ranked.processing_version,
  ranked.id,
  'COMPLETED',
  null,
  ranked.processing_token,
  ranked.processing_version <> 2147483647,
  ranked.instagram_title,
  ranked.instagram_description,
  ranked.instagram_author_username,
  ranked.instagram_thumbnail_url,
  ranked.created_at,
  ranked.updated_at
from ranked_completed as ranked
where ranked.source_rank = 1;

update public.reels as reel
set extraction_id = extraction.id
from public.reel_extractions as extraction
where reel.instagram_shortcode = extraction.instagram_shortcode
  and reel.processing_version = extraction.pipeline_version
  and reel.processing_status = 'COMPLETED';

insert into public.reel_extraction_places (
  extraction_id,
  place_id,
  position,
  created_at
)
select
  extraction.id,
  reel_place.place_id,
  reel_place.position,
  reel_place.created_at
from public.reel_extractions as extraction
join public.reel_places as reel_place
  on reel_place.reel_id = extraction.worker_reel_id;

insert into public.reel_extraction_places (
  extraction_id,
  place_id,
  position,
  created_at
)
select
  extraction.id,
  reel.place_id,
  0,
  reel.created_at
from public.reel_extractions as extraction
join public.reels as reel on reel.id = extraction.worker_reel_id
where reel.place_id is not null
  and not exists (
    select 1
    from public.reel_extraction_places as extraction_place
    where extraction_place.extraction_id = extraction.id
  );

-- 배포 전에 남아 있던 PENDING review queue도 새 사용자별 batch로 옮긴다.
insert into public.reel_queue_batches (
  user_id,
  extraction_id,
  latest_reel_id,
  instagram_shortcode,
  created_at,
  last_queued_at
)
select
  reel.user_id,
  reel.extraction_id,
  reel.id,
  reel.instagram_shortcode,
  reel.created_at,
  reel.created_at
from public.reels as reel
where reel.extraction_id is not null
  and reel.instagram_shortcode is not null
  and reel.processing_status = 'COMPLETED'
  and reel.save_mode = 'REVIEW_QUEUE'
  and exists (
    select 1
    from public.reel_places as reel_place
    where reel_place.reel_id = reel.id
      and reel_place.review_status = 'PENDING'
  )
on conflict (user_id, instagram_shortcode)
  where resolved_at is null
do update set
  latest_reel_id = excluded.latest_reel_id,
  last_queued_at = greatest(
    public.reel_queue_batches.last_queued_at,
    excluded.last_queued_at
  );

insert into public.reel_queue_items (
  batch_id,
  place_id,
  position,
  review_status,
  reviewed_at,
  created_at
)
select
  batch.id,
  reel_place.place_id,
  reel_place.position,
  'PENDING',
  null,
  reel_place.created_at
from public.reel_queue_batches as batch
join public.reel_places as reel_place
  on reel_place.reel_id = batch.latest_reel_id
where batch.resolved_at is null
  and reel_place.review_status = 'PENDING'
on conflict (batch_id, place_id) do nothing;

-- 공용 extraction 요청은 materialize_reel_request가 전체 장소를 한 번에
-- 저장한다. 기존 completion trigger는 extraction_id 없는 legacy 행에만 적용한다.
create or replace function public.finalize_auto_save_reel_on_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.extraction_id is null
     and new.save_mode = 'AUTO_SAVE'
     and new.processing_status = 'COMPLETED' then
    perform public.finalize_auto_save_reel(new.id);
  end if;
  return new;
end;
$$;

revoke all on function public.finalize_auto_save_reel_on_completion() from public;
revoke all on function public.finalize_auto_save_reel_on_completion() from anon;
revoke all on function public.finalize_auto_save_reel_on_completion() from authenticated;

-- 완료된 extraction을 요청 히스토리와 사용자별 저장/대기함 상태에 반영한다.
-- 같은 shortcode의 open batch가 있으면 카드를 재사용하되 모든 장소를 다시
-- PENDING으로 열고 요청 시각을 올린다.
create function public.materialize_reel_request(p_reel_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reel public.reels%rowtype;
  v_extraction public.reel_extractions%rowtype;
  v_batch_id uuid;
  v_previous_extraction_id uuid;
  v_previous_latest_reel_id uuid;
  v_effective_extraction_id uuid;
  v_effective_latest_reel_id uuid;
  v_next_position integer;
  v_now timestamptz := now();
begin
  select reel.*
  into v_reel
  from public.reels as reel
  where reel.id = p_reel_id
  for update;

  if not found or v_reel.extraction_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'reel_request_not_found';
  end if;

  select extraction.*
  into v_extraction
  from public.reel_extractions as extraction
  where extraction.id = v_reel.extraction_id
    and extraction.processing_status = 'COMPLETED';

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'reel_extraction_not_completed';
  end if;

  update public.reels
  set
    place_id = (
      select extraction_place.place_id
      from public.reel_extraction_places as extraction_place
      where extraction_place.extraction_id = v_extraction.id
      order by extraction_place.position
      limit 1
    ),
    instagram_title = v_extraction.instagram_title,
    instagram_description = v_extraction.instagram_description,
    instagram_author_username = v_extraction.instagram_author_username,
    instagram_thumbnail_url = v_extraction.instagram_thumbnail_url,
    processing_status = 'COMPLETED',
    failure_reason = null
  where id = p_reel_id;

  if v_reel.save_mode = 'AUTO_SAVE' then
    insert into public.saved_places as saved_place (
      user_id,
      place_id,
      thumbnail_url,
      last_saved_at
    )
    select
      v_reel.user_id,
      extraction_place.place_id,
      place.thumbnail_url,
      v_now
    from public.reel_extraction_places as extraction_place
    join public.places as place on place.id = extraction_place.place_id
    where extraction_place.extraction_id = v_extraction.id
    order by extraction_place.place_id
    on conflict (user_id, place_id) do update
      set
        thumbnail_url = coalesce(
          saved_place.thumbnail_url,
          excluded.thumbnail_url
        ),
        last_saved_at = greatest(
          saved_place.last_saved_at,
          excluded.last_saved_at
        );

    return null;
  end if;

  if not exists (
    select 1
    from public.reel_extraction_places as extraction_place
    where extraction_place.extraction_id = v_extraction.id
  ) then
    return null;
  end if;

  -- begin_reel_request에서 이미 이 요청으로 카드를 다시 연 경우에는 완료 시
  -- 사용자가 그사이 처리한 상태를 보존하고 새 장소만 합친다.
  select
    batch.extraction_id,
    batch.latest_reel_id
  into
    v_previous_extraction_id,
    v_previous_latest_reel_id
  from public.reel_queue_batches as batch
  where batch.user_id = v_reel.user_id
    and batch.instagram_shortcode = v_extraction.instagram_shortcode
    and batch.resolved_at is null
  for update;

  insert into public.reel_queue_batches (
    user_id,
    extraction_id,
    latest_reel_id,
    instagram_shortcode,
    created_at,
    last_queued_at
  )
  values (
    v_reel.user_id,
    v_extraction.id,
    v_reel.id,
    v_extraction.instagram_shortcode,
    v_now,
    v_reel.created_at
  )
  on conflict (user_id, instagram_shortcode)
    where resolved_at is null
  do update set
    extraction_id = case
      when reel_queue_batches.latest_reel_id is null
        or reel_queue_batches.latest_reel_id = v_reel.id
        or coalesce(
          (
            select latest_reel.created_at
            from public.reels as latest_reel
            where latest_reel.id = reel_queue_batches.latest_reel_id
          ),
          '-infinity'::timestamptz
        ) < v_reel.created_at
      then excluded.extraction_id
      else reel_queue_batches.extraction_id
    end,
    latest_reel_id = case
      when reel_queue_batches.latest_reel_id is null
        or reel_queue_batches.latest_reel_id = v_reel.id
        or coalesce(
          (
            select latest_reel.created_at
            from public.reels as latest_reel
            where latest_reel.id = reel_queue_batches.latest_reel_id
          ),
          '-infinity'::timestamptz
        ) < v_reel.created_at
      then excluded.latest_reel_id
      else reel_queue_batches.latest_reel_id
    end,
    last_queued_at = greatest(
      reel_queue_batches.last_queued_at,
      v_reel.created_at
    )
  returning
    id,
    extraction_id,
    latest_reel_id
  into
    v_batch_id,
    v_effective_extraction_id,
    v_effective_latest_reel_id;

  -- 더 최신 요청이 이미 같은 카드를 차지했다면 늦게 끝난 과거 요청은
  -- 장소 상태나 item 세대를 되돌리지 않는다.
  if v_effective_latest_reel_id is distinct from v_reel.id then
    return v_batch_id;
  end if;

  -- 명시적으로 같은 릴스를 다시 공유하면 기존 처리 여부와 관계없이 카드의
  -- 모든 장소를 새 item 세대로 다시 보여준다. 이전 item ID의 늦은 SAVE가
  -- 새 카드에 적용되지 않으며 보관함 시각은 실제 새 SAVE 때만 갱신된다.
  if v_previous_latest_reel_id is distinct from v_reel.id
     or v_previous_extraction_id is distinct from v_effective_extraction_id then
    delete from public.reel_queue_items as queue_item
    where queue_item.batch_id = v_batch_id;

    insert into public.reel_queue_items (
      batch_id,
      place_id,
      position,
      review_status,
      reviewed_at
    )
    select
      v_batch_id,
      extraction_place.place_id,
      row_number() over (
        order by extraction_place.position, extraction_place.id
      )::integer - 1,
      'PENDING',
      null
    from public.reel_extraction_places as extraction_place
    where extraction_place.extraction_id = v_effective_extraction_id
    order by extraction_place.position, extraction_place.id;

    return v_batch_id;
  end if;

  select coalesce(max(queue_item.position) + 1, 0)
  into v_next_position
  from public.reel_queue_items as queue_item
  where queue_item.batch_id = v_batch_id;

  insert into public.reel_queue_items (
    batch_id,
    place_id,
    position,
    review_status,
    reviewed_at
  )
  select
    v_batch_id,
    missing_place.place_id,
    v_next_position + missing_place.append_offset,
    'PENDING',
    null
  from (
    select
      extraction_place.place_id,
      row_number() over (
        order by extraction_place.position, extraction_place.id
      )::integer - 1 as append_offset
    from public.reel_extraction_places as extraction_place
    where extraction_place.extraction_id = v_effective_extraction_id
      and not exists (
        select 1
        from public.reel_queue_items as existing_item
        where existing_item.batch_id = v_batch_id
          and existing_item.place_id = extraction_place.place_id
      )
  ) as missing_place
  order by missing_place.append_offset;

  return v_batch_id;
end;
$$;

revoke all on function public.materialize_reel_request(uuid) from public;
revoke all on function public.materialize_reel_request(uuid) from anon;
revoke all on function public.materialize_reel_request(uuid) from authenticated;

create function public.reel_request_payload(
  p_reel_id uuid,
  p_should_process boolean,
  p_reused boolean,
  p_duplicate boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'reel_id', reel.id,
    'extraction_id', extraction.id,
    'worker_reel_id', extraction.worker_reel_id,
    'place_id', reel.place_id,
    'place_ids', coalesce(
      (
        select jsonb_agg(extraction_place.place_id order by extraction_place.position)
        from public.reel_extraction_places as extraction_place
        where extraction_place.extraction_id = extraction.id
      ),
      '[]'::jsonb
    ),
    'processing_status', reel.processing_status,
    'failure_reason', reel.failure_reason,
    'processing_token', extraction.processing_token,
    'should_process', p_should_process,
    'reused', p_reused,
    'save_mode', reel.save_mode,
    'duplicate', p_duplicate
  )
  from public.reels as reel
  left join public.reel_extractions as extraction
    on extraction.id = reel.extraction_id
  where reel.id = p_reel_id;
$$;

revoke all on function public.reel_request_payload(uuid, boolean, boolean, boolean) from public;
revoke all on function public.reel_request_payload(uuid, boolean, boolean, boolean) from anon;
revoke all on function public.reel_request_payload(uuid, boolean, boolean, boolean) from authenticated;

-- 요청 히스토리 생성과 공용 extraction 선점을 한 transaction에서 처리한다.
-- 동일 client request UUID는 어떤 queue/save 시각도 두 번 갱신하지 않는다.
create function public.begin_reel_request(
  p_user_id uuid,
  p_client_request_id uuid,
  p_instagram_shortcode text,
  p_instagram_url text,
  p_source text,
  p_save_mode text,
  p_pipeline_version integer,
  p_stale_before timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reel_id uuid;
  v_existing_reel public.reels%rowtype;
  v_extraction public.reel_extractions%rowtype;
  v_inserted_extraction boolean := false;
  v_should_process boolean := false;
  v_reused boolean := false;
  v_save_mode text := upper(trim(coalesce(p_save_mode, '')));
  v_source text := lower(trim(coalesce(p_source, '')));
  v_shortcode text := trim(coalesce(p_instagram_shortcode, ''));
  v_old_worker_reel_id uuid;
  v_new_token uuid;
begin
  if p_user_id is null or p_client_request_id is null then
    raise exception using
      errcode = '22023',
      message = 'reel_request_identity_required';
  end if;

  if v_shortcode = '' or v_shortcode !~ '^[A-Za-z0-9_-]+$' then
    raise exception using
      errcode = '22023',
      message = 'invalid_instagram_shortcode';
  end if;

  if nullif(trim(coalesce(p_instagram_url, '')), '') is null
     or v_source not in ('instagram_share', 'url_input')
     or v_save_mode not in ('AUTO_SAVE', 'REVIEW_QUEUE')
     or p_pipeline_version <= 0
     or p_stale_before is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_reel_request';
  end if;

  insert into public.reels (
    user_id,
    instagram_url,
    instagram_shortcode,
    source,
    processing_status,
    processing_version,
    save_mode,
    request_id
  )
  values (
    p_user_id,
    p_instagram_url,
    v_shortcode,
    v_source,
    'PROCESSING',
    p_pipeline_version,
    v_save_mode,
    p_client_request_id
  )
  on conflict (user_id, request_id)
    where request_id is not null
  do nothing
  returning id into v_reel_id;

  if v_reel_id is null then
    select reel.*
    into v_existing_reel
    from public.reels as reel
    where reel.user_id = p_user_id
      and reel.request_id = p_client_request_id;

    v_reel_id := v_existing_reel.id;

    if v_existing_reel.instagram_shortcode is distinct from v_shortcode
       or v_existing_reel.instagram_url is distinct from p_instagram_url
       or v_existing_reel.source is distinct from v_source
       or v_existing_reel.save_mode is distinct from v_save_mode then
      raise exception using
        errcode = '22023',
        message = 'idempotency_key_payload_mismatch';
    end if;

    if v_existing_reel.extraction_id is null then
      raise exception using
        errcode = 'P0001',
        message = 'reel_request_extraction_missing';
    end if;

    select extraction.*
    into v_extraction
    from public.reel_extractions as extraction
    where extraction.id = v_existing_reel.extraction_id
    for update;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'reel_request_extraction_missing';
    end if;

    -- finalize와 같은 extraction -> reel 순서로 잠근다.
    select reel.*
    into v_existing_reel
    from public.reels as reel
    where reel.id = v_reel_id
    for update;

    if v_existing_reel.extraction_id is distinct from v_extraction.id
       or v_existing_reel.instagram_shortcode is distinct from v_shortcode
       or v_existing_reel.instagram_url is distinct from p_instagram_url
       or v_existing_reel.source is distinct from v_source
       or v_existing_reel.save_mode is distinct from v_save_mode then
      raise exception using
        errcode = '22023',
        message = 'idempotency_key_payload_mismatch';
    end if;

    if v_extraction.processing_status in ('PENDING', 'PROCESSING')
       and (
         v_extraction.updated_at <= p_stale_before
         or v_extraction.worker_reel_id is null
       ) then
      v_old_worker_reel_id := v_extraction.worker_reel_id;
      v_new_token := gen_random_uuid();

      if v_old_worker_reel_id is not null then
        update public.reels
        set processing_token = gen_random_uuid()
        where id = v_old_worker_reel_id;
      end if;

      update public.reel_extractions
      set
        instagram_url = p_instagram_url,
        worker_reel_id = v_reel_id,
        processing_status = 'PROCESSING',
        failure_reason = null,
        processing_token = v_new_token,
        cacheable = true,
        instagram_title = null,
        instagram_description = null,
        instagram_author_username = null,
        instagram_thumbnail_url = null
      where id = v_extraction.id
      returning * into v_extraction;

      update public.reels
      set
        processing_token = v_extraction.processing_token,
        processing_status = 'PROCESSING',
        failure_reason = null,
        place_id = null,
        instagram_title = null,
        instagram_description = null,
        instagram_author_username = null,
        instagram_thumbnail_url = null
      where id = v_reel_id;

      return public.reel_request_payload(
        v_reel_id,
        true,
        false,
        true
      );
    end if;

    return public.reel_request_payload(
      v_reel_id,
      false,
      v_extraction.processing_status = 'COMPLETED'
        and v_extraction.cacheable,
      true
    );
  end if;

  -- 실패/부분 성공 attempt는 active-cache index 밖에 있으므로 새 행을 만든다.
  -- 동시에 온 요청끼리는 partial unique index가 같은 PROCESSING 행에 붙인다.
  loop
    v_new_token := gen_random_uuid();
    v_extraction := null;

    insert into public.reel_extractions (
      instagram_shortcode,
      instagram_url,
      pipeline_version,
      worker_reel_id,
      processing_status,
      failure_reason,
      processing_token,
      cacheable
    )
    values (
      v_shortcode,
      p_instagram_url,
      p_pipeline_version,
      v_reel_id,
      'PROCESSING',
      null,
      v_new_token,
      true
    )
    on conflict (instagram_shortcode, pipeline_version)
      where processing_status in ('PENDING', 'PROCESSING')
         or (processing_status = 'COMPLETED' and cacheable)
    do nothing
    returning * into v_extraction;

    if found then
      v_inserted_extraction := true;
      exit;
    end if;

    select extraction.*
    into v_extraction
    from public.reel_extractions as extraction
    where extraction.instagram_shortcode = v_shortcode
      and extraction.pipeline_version = p_pipeline_version
      and (
        extraction.processing_status in ('PENDING', 'PROCESSING')
        or (
          extraction.processing_status = 'COMPLETED'
          and extraction.cacheable
        )
      )
    for update;

    if found then
      exit;
    end if;
  end loop;

  if v_inserted_extraction then
    v_should_process := true;

    update public.reels
    set
      extraction_id = v_extraction.id,
      processing_token = v_extraction.processing_token,
      processing_status = 'PROCESSING',
      failure_reason = null
    where id = v_reel_id;
  elsif v_extraction.processing_status = 'COMPLETED' then
    v_reused := true;

    update public.reels
    set extraction_id = v_extraction.id
    where id = v_reel_id;
  elsif v_extraction.updated_at <= p_stale_before
        or v_extraction.worker_reel_id is null then
    v_old_worker_reel_id := v_extraction.worker_reel_id;
    v_new_token := gen_random_uuid();
    v_should_process := true;

    -- 과거 processing 요청/부분 결과는 히스토리 증거로 보존한다. token만
    -- 교체해 늦게 끝난 worker가 공유 extraction을 확정하지 못하게 한다.
    if v_old_worker_reel_id is not null
       and v_old_worker_reel_id <> v_reel_id then
      update public.reels
      set processing_token = gen_random_uuid()
      where id = v_old_worker_reel_id;
    end if;

    update public.reel_extractions
    set
      instagram_url = p_instagram_url,
      worker_reel_id = v_reel_id,
      processing_status = 'PROCESSING',
      failure_reason = null,
      processing_token = v_new_token,
      cacheable = true,
      instagram_title = null,
      instagram_description = null,
      instagram_author_username = null,
      instagram_thumbnail_url = null
    where id = v_extraction.id
    returning * into v_extraction;

    update public.reels
    set
      extraction_id = v_extraction.id,
      processing_token = v_extraction.processing_token,
      processing_status = 'PROCESSING',
      failure_reason = null
    where id = v_reel_id;
  else
    update public.reels
    set
      extraction_id = v_extraction.id,
      processing_status = v_extraction.processing_status,
      failure_reason = v_extraction.failure_reason
    where id = v_reel_id;
  end if;

  -- extraction row를 먼저 잠근 뒤 batch를 만져 finalize와 lock 순서를 맞춘다.
  -- 새 REVIEW_QUEUE 분석의 성공 여부와 무관하게 명시적 요청 시각에 기존
  -- open 카드를 올린다. AUTO_SAVE는 별도 대기함 상태를 건드리지 않는다.
  update public.reel_queue_batches as open_batch
  set
    latest_reel_id = case
      when open_batch.latest_reel_id is null
        or coalesce(
          (
            select latest_reel.created_at
            from public.reels as latest_reel
            where latest_reel.id = open_batch.latest_reel_id
          ),
          '-infinity'::timestamptz
        ) <= (
          select requested_reel.created_at
          from public.reels as requested_reel
          where requested_reel.id = v_reel_id
        )
      then v_reel_id
      else open_batch.latest_reel_id
    end,
    last_queued_at = greatest(
      open_batch.last_queued_at,
      (
        select reel.created_at
        from public.reels as reel
        where reel.id = v_reel_id
      )
    )
  where open_batch.user_id = p_user_id
    and open_batch.instagram_shortcode = v_shortcode
    and open_batch.resolved_at is null
    and v_save_mode = 'REVIEW_QUEUE';

  -- 완료 cache를 재사용하는 REVIEW_QUEUE 재공유는 기존 장소를 즉시 새
  -- item 세대로 다시 연다. 새 추출이 필요한 요청은 결과가 완료된 뒤
  -- materialize에서 새 결과 전체를 한 번만 연다.
  if v_save_mode = 'REVIEW_QUEUE' and v_reused then
    update public.reel_queue_items as queue_item
    set
      id = gen_random_uuid(),
      review_status = 'PENDING',
      reviewed_at = null,
      created_at = now()
    where exists (
      select 1
      from public.reel_queue_batches as open_batch
      where open_batch.id = queue_item.batch_id
        and open_batch.user_id = p_user_id
        and open_batch.instagram_shortcode = v_shortcode
        and open_batch.latest_reel_id = v_reel_id
        and open_batch.resolved_at is null
    );
  end if;

  if v_reused then
    perform public.materialize_reel_request(v_reel_id);
  end if;

  return public.reel_request_payload(
    v_reel_id,
    v_should_process,
    v_reused,
    false
  );
end;
$$;

revoke all on function public.begin_reel_request(
  uuid, uuid, text, text, text, text, integer, timestamptz
) from public;
revoke all on function public.begin_reel_request(
  uuid, uuid, text, text, text, text, integer, timestamptz
) from anon;
revoke all on function public.begin_reel_request(
  uuid, uuid, text, text, text, text, integer, timestamptz
) from authenticated;
grant execute on function public.begin_reel_request(
  uuid, uuid, text, text, text, text, integer, timestamptz
) to service_role;

comment on function public.begin_reel_request(
  uuid, uuid, text, text, text, text, integer, timestamptz
) is '명시적 요청 히스토리의 멱등 생성과 shortcode/version 공용 extraction 선점을 원자적으로 처리한다';

-- 기존 pipeline이 worker reel에 쓴 결과를 immutable extraction으로 확정한다.
create function public.finalize_reel_extraction(
  p_extraction_id uuid,
  p_worker_reel_id uuid,
  p_processing_token uuid,
  p_cacheable boolean
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_extraction public.reel_extractions%rowtype;
  v_worker public.reels%rowtype;
  v_request record;
  v_request_count integer := 0;
  v_place_count integer;
begin
  if p_extraction_id is null
     or p_worker_reel_id is null
     or p_processing_token is null
     or p_cacheable is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_reel_extraction_finalize';
  end if;

  select extraction.*
  into v_extraction
  from public.reel_extractions as extraction
  where extraction.id = p_extraction_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'reel_extraction_not_found';
  end if;

  if v_extraction.processing_status = 'COMPLETED'
     and v_extraction.worker_reel_id = p_worker_reel_id
     and v_extraction.processing_token = p_processing_token then
    select count(*)::integer
    into v_request_count
    from public.reels as reel
    where reel.extraction_id = p_extraction_id;
    return v_request_count;
  end if;

  if v_extraction.processing_status <> 'PROCESSING'
     or v_extraction.worker_reel_id is distinct from p_worker_reel_id
     or v_extraction.processing_token is distinct from p_processing_token then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  select reel.*
  into v_worker
  from public.reels as reel
  where reel.id = p_worker_reel_id
    and reel.extraction_id = p_extraction_id
    and reel.processing_status = 'PROCESSING'
    and reel.processing_token = p_processing_token
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  select count(*)::integer
  into v_place_count
  from public.reel_places as reel_place
  where reel_place.reel_id = p_worker_reel_id
    and reel_place.processing_token = p_processing_token;

  if v_place_count = 0 then
    raise exception using
      errcode = '22023',
      message = 'reel_extraction_places_required';
  end if;

  insert into public.reel_extraction_places (
    extraction_id,
    place_id,
    position,
    created_at
  )
  select
    p_extraction_id,
    reel_place.place_id,
    row_number() over (
      order by reel_place.position, reel_place.id
    )::integer - 1,
    reel_place.created_at
  from public.reel_places as reel_place
  where reel_place.reel_id = p_worker_reel_id
    and reel_place.processing_token = p_processing_token
  order by reel_place.position;

  update public.reel_extractions
  set
    instagram_url = v_worker.instagram_url,
    processing_status = 'COMPLETED',
    failure_reason = null,
    cacheable = p_cacheable,
    instagram_title = v_worker.instagram_title,
    instagram_description = v_worker.instagram_description,
    instagram_author_username = v_worker.instagram_author_username,
    instagram_thumbnail_url = v_worker.instagram_thumbnail_url
  where id = p_extraction_id;

  for v_request in
    select reel.id
    from public.reels as reel
    where reel.extraction_id = p_extraction_id
    order by reel.user_id, reel.created_at, reel.id
  loop
    perform public.materialize_reel_request(v_request.id);
    v_request_count := v_request_count + 1;
  end loop;

  return v_request_count;
end;
$$;

revoke all on function public.finalize_reel_extraction(uuid, uuid, uuid, boolean) from public;
revoke all on function public.finalize_reel_extraction(uuid, uuid, uuid, boolean) from anon;
revoke all on function public.finalize_reel_extraction(uuid, uuid, uuid, boolean) from authenticated;
grant execute on function public.finalize_reel_extraction(uuid, uuid, uuid, boolean) to service_role;

comment on function public.finalize_reel_extraction(uuid, uuid, uuid, boolean) is
  'worker reel 결과를 공용 extraction으로 고정하고 연결된 모든 요청/대기함/보관함을 동기화한다';

create function public.fail_reel_extraction(
  p_extraction_id uuid,
  p_worker_reel_id uuid,
  p_processing_token uuid,
  p_failure_reason text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_extraction public.reel_extractions%rowtype;
  v_worker public.reels%rowtype;
  v_updated_count integer;
begin
  if p_extraction_id is null
     or p_worker_reel_id is null
     or p_processing_token is null
     or p_failure_reason not in (
       'IG_FETCH_FAILED',
       'IG_CAPTION_NOT_FOUND',
       'PROVIDER_CONFIG_MISSING',
       'GEMINI_PLACE_NOT_FOUND',
       'KAKAO_PLACE_NOT_FOUND',
       'PLACE_NOT_FOUND',
       'UNKNOWN'
     ) then
    raise exception using
      errcode = '22023',
      message = 'invalid_reel_extraction_failure';
  end if;

  select extraction.*
  into v_extraction
  from public.reel_extractions as extraction
  where extraction.id = p_extraction_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'reel_extraction_not_found';
  end if;

  if v_extraction.processing_status = 'FAILED'
     and v_extraction.worker_reel_id = p_worker_reel_id
     and v_extraction.processing_token = p_processing_token
     and v_extraction.failure_reason = p_failure_reason then
    select count(*)::integer
    into v_updated_count
    from public.reels as reel
    where reel.extraction_id = p_extraction_id;
    return v_updated_count;
  end if;

  if v_extraction.processing_status <> 'PROCESSING'
     or v_extraction.worker_reel_id is distinct from p_worker_reel_id
     or v_extraction.processing_token is distinct from p_processing_token then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  select reel.*
  into v_worker
  from public.reels as reel
  where reel.id = p_worker_reel_id
    and reel.extraction_id = p_extraction_id
    and reel.processing_status = 'PROCESSING'
    and reel.processing_token = p_processing_token
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  update public.reel_extractions
  set
    processing_status = 'FAILED',
    failure_reason = p_failure_reason,
    cacheable = false,
    instagram_title = v_worker.instagram_title,
    instagram_description = v_worker.instagram_description,
    instagram_author_username = v_worker.instagram_author_username,
    instagram_thumbnail_url = v_worker.instagram_thumbnail_url
  where id = p_extraction_id;

  update public.reels
  set
    instagram_title = v_worker.instagram_title,
    instagram_description = v_worker.instagram_description,
    instagram_author_username = v_worker.instagram_author_username,
    instagram_thumbnail_url = v_worker.instagram_thumbnail_url,
    processing_status = 'FAILED',
    failure_reason = p_failure_reason
  where extraction_id = p_extraction_id
    and processing_status in ('PENDING', 'PROCESSING');

  get diagnostics v_updated_count = row_count;
  return v_updated_count;
end;
$$;

revoke all on function public.fail_reel_extraction(uuid, uuid, uuid, text) from public;
revoke all on function public.fail_reel_extraction(uuid, uuid, uuid, text) from anon;
revoke all on function public.fail_reel_extraction(uuid, uuid, uuid, text) from authenticated;
grant execute on function public.fail_reel_extraction(uuid, uuid, uuid, text) to service_role;

comment on function public.fail_reel_extraction(uuid, uuid, uuid, text) is
  '실패 attempt를 불변/비캐시 상태로 남기고 이를 기다리던 요청 히스토리를 함께 실패 처리한다';

-- 새 queue item id를 기본으로 처리하되, 배포 전 앱의 reel_places id도
-- 전환 기간 동안 같은 RPC에서 계속 처리한다.
create or replace function public.resolve_queue_items(
  p_reel_place_ids uuid[],
  p_action text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_action text := upper(trim(coalesce(p_action, '')));
  v_requested_count integer;
  v_new_id_count integer;
  v_available_count integer;
  v_updated_count integer;
  v_now timestamptz := now();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  if v_action not in ('SAVE', 'DISCARD') then
    raise exception using
      errcode = '22023',
      message = 'invalid_queue_action';
  end if;

  if coalesce(cardinality(p_reel_place_ids), 0) = 0 then
    raise exception using
      errcode = '22023',
      message = 'queue_selection_required';
  end if;

  select count(*)::integer
  into v_requested_count
  from (
    select distinct queue_item_id
    from unnest(p_reel_place_ids) as requested(queue_item_id)
    where queue_item_id is not null
  ) as distinct_requested;

  if v_requested_count <> cardinality(p_reel_place_ids) then
    raise exception using
      errcode = '22023',
      message = 'queue_selection_contains_duplicates_or_nulls';
  end if;

  select count(*)::integer
  into v_new_id_count
  from public.reel_queue_items as queue_item
  where queue_item.id = any(p_reel_place_ids);

  if v_new_id_count > 0 then
    if v_new_id_count <> v_requested_count then
      raise exception using
        errcode = 'P0001',
        message = 'queue_items_not_available';
    end if;

    perform 1
    from public.reel_queue_batches as batch
    where batch.id in (
      select queue_item.batch_id
      from public.reel_queue_items as queue_item
      where queue_item.id = any(p_reel_place_ids)
    )
      and batch.user_id = v_user_id
      and batch.resolved_at is null
    order by batch.id
    for update of batch;

    perform 1
    from public.reel_queue_items as queue_item
    join public.reel_queue_batches as batch on batch.id = queue_item.batch_id
    where queue_item.id = any(p_reel_place_ids)
      and batch.user_id = v_user_id
      and batch.resolved_at is null
    order by queue_item.id
    for update of queue_item;

    select count(*)::integer
    into v_available_count
    from public.reel_queue_items as queue_item
    join public.reel_queue_batches as batch on batch.id = queue_item.batch_id
    where queue_item.id = any(p_reel_place_ids)
      and batch.user_id = v_user_id
      and batch.resolved_at is null
      and queue_item.review_status = 'PENDING';

    if v_available_count <> v_requested_count then
      raise exception using
        errcode = 'P0001',
        message = 'queue_items_not_available';
    end if;

    if v_action = 'SAVE' then
      insert into public.saved_places as saved_place (
        user_id,
        place_id,
        thumbnail_url,
        last_saved_at
      )
      select distinct on (queue_item.place_id)
        v_user_id,
        queue_item.place_id,
        place.thumbnail_url,
        v_now
      from public.reel_queue_items as queue_item
      join public.reel_queue_batches as batch on batch.id = queue_item.batch_id
      join public.places as place on place.id = queue_item.place_id
      where queue_item.id = any(p_reel_place_ids)
        and batch.user_id = v_user_id
        and batch.resolved_at is null
        and queue_item.review_status = 'PENDING'
      order by queue_item.place_id, queue_item.id
      on conflict (user_id, place_id) do update
        set
          thumbnail_url = coalesce(
            saved_place.thumbnail_url,
            excluded.thumbnail_url
          ),
          last_saved_at = greatest(
            saved_place.last_saved_at,
            excluded.last_saved_at
          );
    end if;

    update public.reel_queue_items as queue_item
    set
      review_status = case when v_action = 'SAVE' then 'SAVED' else 'DISCARDED' end,
      reviewed_at = v_now
    where queue_item.id = any(p_reel_place_ids)
      and queue_item.review_status = 'PENDING'
      and exists (
        select 1
        from public.reel_queue_batches as batch
        where batch.id = queue_item.batch_id
          and batch.user_id = v_user_id
          and batch.resolved_at is null
      );

    get diagnostics v_updated_count = row_count;
    if v_updated_count <> v_requested_count then
      raise exception using
        errcode = 'P0001',
        message = 'queue_items_changed_during_request';
    end if;

    update public.reel_queue_batches as batch
    set resolved_at = v_now
    where batch.id in (
      select distinct queue_item.batch_id
      from public.reel_queue_items as queue_item
      where queue_item.id = any(p_reel_place_ids)
    )
      and batch.user_id = v_user_id
      and batch.resolved_at is null
      and not exists (
        select 1
        from public.reel_queue_items as remaining_item
        where remaining_item.batch_id = batch.id
          and remaining_item.review_status = 'PENDING'
      );

    return v_updated_count;
  end if;

  -- Legacy reel_places path.
  perform 1
  from public.reel_places as reel_place
  join public.reels as reel on reel.id = reel_place.reel_id
  where reel_place.id = any(p_reel_place_ids)
    and reel.user_id = v_user_id
    and reel.save_mode = 'REVIEW_QUEUE'
    and reel.processing_status = 'COMPLETED'
  order by reel_place.id
  for update of reel_place;

  select count(*)::integer
  into v_available_count
  from public.reel_places as reel_place
  join public.reels as reel on reel.id = reel_place.reel_id
  where reel_place.id = any(p_reel_place_ids)
    and reel.user_id = v_user_id
    and reel.save_mode = 'REVIEW_QUEUE'
    and reel.processing_status = 'COMPLETED'
    and reel_place.review_status = 'PENDING';

  if v_available_count <> v_requested_count then
    raise exception using
      errcode = 'P0001',
      message = 'queue_items_not_available';
  end if;

  if v_action = 'SAVE' then
    insert into public.saved_places as saved_place (
      user_id,
      place_id,
      thumbnail_url,
      last_saved_at
    )
    select distinct on (reel_place.place_id)
      v_user_id,
      reel_place.place_id,
      place.thumbnail_url,
      v_now
    from public.reel_places as reel_place
    join public.reels as reel on reel.id = reel_place.reel_id
    join public.places as place on place.id = reel_place.place_id
    where reel_place.id = any(p_reel_place_ids)
      and reel.user_id = v_user_id
      and reel.save_mode = 'REVIEW_QUEUE'
      and reel.processing_status = 'COMPLETED'
      and reel_place.review_status = 'PENDING'
    order by reel_place.place_id, reel_place.id
    on conflict (user_id, place_id) do update
      set
        thumbnail_url = coalesce(
          saved_place.thumbnail_url,
          excluded.thumbnail_url
        ),
        last_saved_at = greatest(
          saved_place.last_saved_at,
          excluded.last_saved_at
        );
  end if;

  update public.reel_places as reel_place
  set
    review_status = case when v_action = 'SAVE' then 'SAVED' else 'DISCARDED' end,
    reviewed_at = v_now
  where reel_place.id = any(p_reel_place_ids)
    and reel_place.review_status = 'PENDING'
    and exists (
      select 1
      from public.reels as reel
      where reel.id = reel_place.reel_id
        and reel.user_id = v_user_id
        and reel.save_mode = 'REVIEW_QUEUE'
        and reel.processing_status = 'COMPLETED'
    );

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> v_requested_count then
    raise exception using
      errcode = 'P0001',
      message = 'queue_items_changed_during_request';
  end if;

  return v_updated_count;
end;
$$;

revoke all on function public.resolve_queue_items(uuid[], text) from public;
revoke all on function public.resolve_queue_items(uuid[], text) from anon;
grant execute on function public.resolve_queue_items(uuid[], text) to authenticated;

comment on function public.resolve_queue_items(uuid[], text) is
  '본인의 새/legacy 대기 장소를 확정하고 SAVE 시 장소별 한 행만 upsert하여 last_saved_at을 갱신한다';

-- 공용 extraction worker의 AUTO_SAVE는 장소별 RPC에서 부분 저장하지 않는다.
-- 모든 장소가 확정된 finalize transaction 안에서만 한꺼번에 보관함에 반영한다.
create or replace function public.persist_reel_place_result(
  p_reel_id uuid,
  p_place_id uuid,
  p_position integer,
  p_thumbnail_url text default null,
  p_processing_token uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_save_mode text;
  v_processing_status text;
  v_processing_token uuid;
  v_request_id uuid;
  v_extraction_id uuid;
  v_defer_auto_save boolean;
  v_reel_place_id uuid;
  v_effective_position integer;
begin
  if p_position < 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_reel_place_position';
  end if;

  select
    reel.user_id,
    reel.save_mode,
    reel.processing_status,
    reel.processing_token,
    reel.request_id,
    reel.extraction_id
  into
    v_user_id,
    v_save_mode,
    v_processing_status,
    v_processing_token,
    v_request_id,
    v_extraction_id
  from public.reels as reel
  where reel.id = p_reel_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'reel_not_found';
  end if;

  if p_processing_token is not null
     and (
       v_processing_token is distinct from p_processing_token
       or v_processing_status <> 'PROCESSING'
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  v_defer_auto_save :=
    v_save_mode = 'AUTO_SAVE'
    and v_request_id is not null
    and v_extraction_id is not null;

  if exists (
    select 1
    from public.reel_places as reel_place
    where reel_place.reel_id = p_reel_id
      and reel_place.position = p_position
      and reel_place.place_id <> p_place_id
  ) then
    select coalesce(max(reel_place.position) + 1, p_position)
    into v_effective_position
    from public.reel_places as reel_place
    where reel_place.reel_id = p_reel_id;
  else
    v_effective_position := p_position;
  end if;

  insert into public.reel_places as existing_reel_place (
    reel_id,
    place_id,
    position,
    review_status,
    reviewed_at,
    processing_token
  )
  values (
    p_reel_id,
    p_place_id,
    v_effective_position,
    case
      when v_save_mode = 'AUTO_SAVE' and not v_defer_auto_save then 'SAVED'
      else 'PENDING'
    end,
    case
      when v_save_mode = 'AUTO_SAVE' and not v_defer_auto_save then now()
      else null
    end,
    p_processing_token
  )
  on conflict (reel_id, place_id) do update
    set
      position = existing_reel_place.position,
      processing_token = coalesce(
        excluded.processing_token,
        existing_reel_place.processing_token
      )
  returning id into v_reel_place_id;

  if v_save_mode = 'AUTO_SAVE' and not v_defer_auto_save then
    insert into public.saved_places as saved_place (
      user_id,
      place_id,
      thumbnail_url,
      last_saved_at
    )
    select
      v_user_id,
      place.id,
      coalesce(p_thumbnail_url, place.thumbnail_url),
      now()
    from public.places as place
    where place.id = p_place_id
    on conflict (user_id, place_id) do update
      set
        thumbnail_url = coalesce(
          saved_place.thumbnail_url,
          excluded.thumbnail_url
        ),
        last_saved_at = greatest(
          saved_place.last_saved_at,
          excluded.last_saved_at
        );
  end if;

  return v_reel_place_id;
end;
$$;

revoke all on function public.persist_reel_place_result(uuid, uuid, integer, text, uuid) from public;
revoke all on function public.persist_reel_place_result(uuid, uuid, integer, text, uuid) from anon;
revoke all on function public.persist_reel_place_result(uuid, uuid, integer, text, uuid) from authenticated;
grant execute on function public.persist_reel_place_result(uuid, uuid, integer, text, uuid) to service_role;

comment on function public.persist_reel_place_result(uuid, uuid, integer, text, uuid) is
  'legacy AUTO_SAVE는 즉시 저장하고, 공용 extraction worker는 finalize까지 전체 저장을 유예한다';

alter table public.reel_extractions enable row level security;
alter table public.reel_extraction_places enable row level security;
alter table public.reel_queue_batches enable row level security;
alter table public.reel_queue_items enable row level security;

grant select on public.reel_extractions to authenticated;
grant select on public.reel_extraction_places to authenticated;
grant select on public.reel_queue_batches to authenticated;
grant select on public.reel_queue_items to authenticated;

grant select, insert, update, delete on public.reel_extractions to service_role;
grant select, insert, update, delete on public.reel_extraction_places to service_role;
grant select, insert, update, delete on public.reel_queue_batches to service_role;
grant select, insert, update, delete on public.reel_queue_items to service_role;

create policy "reel_extractions_select_related_own"
  on public.reel_extractions
  for select to authenticated
  using (
    exists (
      select 1
      from public.reels as reel
      where reel.extraction_id = reel_extractions.id
        and reel.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.reel_queue_batches as batch
      where batch.extraction_id = reel_extractions.id
        and batch.user_id = auth.uid()
    )
  );

create policy "reel_extraction_places_select_related_own"
  on public.reel_extraction_places
  for select to authenticated
  using (
    exists (
      select 1
      from public.reels as reel
      where reel.extraction_id = reel_extraction_places.extraction_id
        and reel.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.reel_queue_batches as batch
      where batch.extraction_id = reel_extraction_places.extraction_id
        and batch.user_id = auth.uid()
    )
  );

create policy "reel_queue_batches_select_own"
  on public.reel_queue_batches
  for select to authenticated
  using (auth.uid() = user_id);

create policy "reel_queue_items_select_own"
  on public.reel_queue_items
  for select to authenticated
  using (
    exists (
      select 1
      from public.reel_queue_batches as batch
      where batch.id = reel_queue_items.batch_id
        and batch.user_id = auth.uid()
    )
  );

-- 장소 상세에서는 같은 shortcode의 요청 히스토리를 반복 노출하지 않고,
-- 사용자별 가장 최근 요청 한 건만 보여 준다.
create view public.user_related_reels
with (security_invoker = true)
as
with candidates as (
  select
    reel.id,
    reel.user_id,
    extraction_place.place_id,
    reel.instagram_url,
    reel.instagram_thumbnail_url,
    reel.instagram_shortcode,
    reel.created_at
  from public.reels as reel
  join public.reel_extraction_places as extraction_place
    on extraction_place.extraction_id = reel.extraction_id
  where reel.processing_status = 'COMPLETED'

  union all

  select
    reel.id,
    reel.user_id,
    reel_place.place_id,
    reel.instagram_url,
    reel.instagram_thumbnail_url,
    reel.instagram_shortcode,
    reel.created_at
  from public.reels as reel
  join public.reel_places as reel_place on reel_place.reel_id = reel.id
  where reel.extraction_id is null
    and reel.processing_status = 'COMPLETED'
)
select distinct on (
  candidate.user_id,
  candidate.place_id,
  coalesce(candidate.instagram_shortcode, candidate.id::text)
)
  candidate.id,
  candidate.user_id,
  candidate.place_id,
  candidate.instagram_url,
  candidate.instagram_thumbnail_url,
  candidate.instagram_shortcode,
  candidate.created_at
from candidates as candidate
order by
  candidate.user_id,
  candidate.place_id,
  coalesce(candidate.instagram_shortcode, candidate.id::text),
  candidate.created_at desc,
  candidate.id desc;

grant select on public.user_related_reels to authenticated;

comment on view public.user_related_reels is
  '보관 장소별 관련 릴스를 사용자/shortcode 기준 최신 요청 한 건으로 축약한 RLS view';
