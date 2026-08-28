-- 릴스 분석 결과를 보관함에 즉시 저장하지 않고, 장소별로 검토할 수 있게 한다.
-- reels는 공유/분석 히스토리, reel_places는 분석 결과와 대기함 상태를 함께 보존한다.

alter table public.reel_places
  add column id uuid not null default gen_random_uuid(),
  add column review_status text,
  add column reviewed_at timestamptz;

alter table public.reel_places
  add constraint reel_places_id_key unique (id);

-- 배포 전에 생성된 연결은 예전 앱에서 이미 검토가 끝난 결과다.
-- 현재 보관함에 남아 있으면 SAVED, 사용자가 보관함에서 지웠다면 DISCARDED로 옮겨
-- 과거 데이터가 새 대기함에 다시 나타나지 않게 한다.
update public.reel_places as reel_place
set
  review_status = case
    when exists (
      select 1
      from public.reels as reel
      join public.saved_places as saved_place
        on saved_place.user_id = reel.user_id
       and saved_place.place_id = reel_place.place_id
      where reel.id = reel_place.reel_id
    ) then 'SAVED'
    else 'DISCARDED'
  end,
  reviewed_at = now();

alter table public.reel_places
  alter column review_status set default 'PENDING',
  alter column review_status set not null,
  add constraint reel_places_review_status_check
    check (review_status in ('PENDING', 'SAVED', 'DISCARDED')),
  add constraint reel_places_reviewed_at_check
    check (
      (review_status = 'PENDING' and reviewed_at is null)
      or (review_status in ('SAVED', 'DISCARDED') and reviewed_at is not null)
    );

create index idx_reel_places_pending
  on public.reel_places (reel_id, position)
  where review_status = 'PENDING';

comment on column public.reel_places.id is
  '대기함의 장소 행을 안정적으로 선택하기 위한 식별자';
comment on column public.reel_places.review_status is
  'PENDING: 대기함, SAVED: 보관함 반영, DISCARDED: 대기함에서 제외';
comment on column public.reel_places.reviewed_at is
  '사용자가 저장 또는 제외 결정을 완료한 시각';

-- 여러 릴스에서 선택한 장소들을 한 번에 원자적으로 저장하거나 제외한다.
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
  v_available_count integer;
  v_updated_count integer;
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
    select distinct reel_place_id
    from unnest(p_reel_place_ids) as requested(reel_place_id)
    where reel_place_id is not null
  ) as distinct_requested;

  if v_requested_count <> cardinality(p_reel_place_ids) then
    raise exception using
      errcode = '22023',
      message = 'queue_selection_contains_duplicates_or_nulls';
  end if;

  -- 같은 행에 동시에 저장/제외 요청이 들어와도 한 요청만 결정하도록 잠근다.
  perform 1
  from public.reel_places as reel_place
  join public.reels as reel on reel.id = reel_place.reel_id
  where reel_place.id = any(p_reel_place_ids)
    and reel.user_id = v_user_id
  for update of reel_place;

  select count(*)::integer
  into v_available_count
  from public.reel_places as reel_place
  join public.reels as reel on reel.id = reel_place.reel_id
  where reel_place.id = any(p_reel_place_ids)
    and reel.user_id = v_user_id
    and reel_place.review_status = 'PENDING';

  if v_available_count <> v_requested_count then
    raise exception using
      errcode = 'P0001',
      message = 'queue_items_not_available';
  end if;

  if v_action = 'SAVE' then
    insert into public.saved_places (user_id, place_id, thumbnail_url)
    select
      v_user_id,
      reel_place.place_id,
      place.thumbnail_url
    from public.reel_places as reel_place
    join public.reels as reel on reel.id = reel_place.reel_id
    join public.places as place on place.id = reel_place.place_id
    where reel_place.id = any(p_reel_place_ids)
      and reel.user_id = v_user_id
      and reel_place.review_status = 'PENDING'
    on conflict (user_id, place_id) do nothing;
  end if;

  update public.reel_places as reel_place
  set
    review_status = case when v_action = 'SAVE' then 'SAVED' else 'DISCARDED' end,
    reviewed_at = now()
  where reel_place.id = any(p_reel_place_ids)
    and reel_place.review_status = 'PENDING'
    and exists (
      select 1
      from public.reels as reel
      where reel.id = reel_place.reel_id
        and reel.user_id = v_user_id
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
  '본인 대기함 장소를 SAVE 또는 DISCARD로 일괄 확정한다';

-- 히스토리 실패 상세의 신고/제보 버튼이 실제로 기록되도록 최소 테이블을 둔다.
create table public.reel_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  reel_id uuid not null references public.reels(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, reel_id)
);

create index idx_reel_reports_user_created
  on public.reel_reports (user_id, created_at desc);

alter table public.reel_reports enable row level security;

grant select, insert on public.reel_reports to authenticated;

create policy "reel_reports_select_own" on public.reel_reports
  for select to authenticated
  using (auth.uid() = user_id);

create policy "reel_reports_insert_own" on public.reel_reports
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.reels as reel
      where reel.id = reel_reports.reel_id
        and reel.user_id = auth.uid()
    )
  );

comment on table public.reel_reports is
  '분석 실패 히스토리에서 사용자가 보낸 신고/제보';
