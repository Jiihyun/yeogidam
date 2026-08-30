-- 구버전 자동 저장 API와 v2 대기함 API를 같은 스키마에서 안전하게 병행한다.
-- 구버전이 모르는 컬럼의 기본값은 AUTO_SAVE/SAVED로 두고,
-- v2만 REVIEW_QUEUE/PENDING을 명시한다.

alter table public.reels
  add column save_mode text not null default 'AUTO_SAVE',
  add column processing_token uuid not null default gen_random_uuid(),
  add constraint reels_save_mode_check
    check (save_mode in ('AUTO_SAVE', 'REVIEW_QUEUE'));

comment on column public.reels.save_mode is
  'AUTO_SAVE: 구버전 즉시 보관함 저장, REVIEW_QUEUE: v2 사용자 검토 후 저장';
comment on column public.reels.processing_token is
  '재시도 전 작업이 늦게 끝나 현재 분석 결과를 덮지 못하게 하는 실행 식별자';

alter table public.reel_places
  add column id uuid not null default gen_random_uuid(),
  add column review_status text,
  add column reviewed_at timestamptz;

alter table public.reel_places
  add constraint reel_places_id_key unique (id);

-- 롤백 뒤에는 과거의 per-reel 결정 상태가 없으므로 현재 보관함을 기준으로
-- 이전 관계를 확정 상태로 복원한다. 어떤 과거 관계도 새 대기함에 노출하지 않는다.
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

-- SAVED/now()는 review 컬럼을 모르는 기존 v1 insert의 안전 기본값이다.
-- v2는 PENDING과 reviewed_at = null을 항상 함께 명시한다.
alter table public.reel_places
  alter column review_status set default 'SAVED',
  alter column review_status set not null,
  alter column reviewed_at set default now(),
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
  '대기함 장소 행을 안정적으로 선택하기 위한 식별자';
comment on column public.reel_places.review_status is
  'PENDING: v2 대기함, SAVED: 보관함 반영, DISCARDED: 대기함 제외';
comment on column public.reel_places.reviewed_at is
  '자동 저장 또는 사용자의 저장/제외 결정이 확정된 시각';

-- 진단 행에도 실행 식별자를 남기고, 현재 PROCESSING 실행만 기록하게 한다.
-- null은 새 컬럼을 모르는 구버전 Edge Function의 배포 전환 구간을 위한 호환값이다.
alter table public.reel_place_match_failures
  add column processing_token uuid;

comment on column public.reel_place_match_failures.processing_token is
  '이 진단을 생성한 reels.processing_token; 새 파이프라인은 항상 명시한다';

create function public.guard_reel_place_match_failure_attempt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.processing_token is not null
     and not exists (
       select 1
       from public.reels as reel
       where reel.id = new.reel_id
         and reel.processing_status = 'PROCESSING'
         and reel.processing_token = new.processing_token
       for update
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;
  return new;
end;
$$;

create trigger guard_reel_place_match_failure_attempt
  before insert or update on public.reel_place_match_failures
  for each row execute function public.guard_reel_place_match_failure_attempt();

revoke all on function public.guard_reel_place_match_failure_attempt() from public;
revoke all on function public.guard_reel_place_match_failure_attempt() from anon;
revoke all on function public.guard_reel_place_match_failure_attempt() from authenticated;

-- 한 번 AUTO_SAVE가 필요해진 릴스는 구버전 계약을 보호하기 위해 다시
-- REVIEW_QUEUE로 내릴 수 없다.
create function public.prevent_reel_save_mode_downgrade()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.save_mode = 'AUTO_SAVE' and new.save_mode = 'REVIEW_QUEUE' then
    raise exception using
      errcode = '23514',
      message = 'reel_save_mode_downgrade_not_allowed';
  end if;
  return new;
end;
$$;

create trigger prevent_reel_save_mode_downgrade
  before update of save_mode on public.reels
  for each row execute function public.prevent_reel_save_mode_downgrade();

revoke all on function public.prevent_reel_save_mode_downgrade() from public;
revoke all on function public.prevent_reel_save_mode_downgrade() from anon;
revoke all on function public.prevent_reel_save_mode_downgrade() from authenticated;

-- AUTO_SAVE 릴스가 완료되면 saved_places와 관계 상태를 한 트랜잭션에서 맞춘다.
-- v2 처리 도중 구버전 요청이 들어와 mode가 승격된 경우도 이 함수가 수습한다.
create function public.finalize_auto_save_reel(p_reel_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- resolve_queue_items와 동일하게 reel_places를 먼저 잠근 뒤
  -- saved_places를 쓴다. 반대 순서면 v1 승격과 v2 SAVE가 동시에 올 때
  -- child/saved row lock이 서로 교차해 deadlock이 날 수 있다.
  perform 1
  from public.reel_places as reel_place
  where reel_place.reel_id = p_reel_id
  order by reel_place.id
  for update;

  insert into public.saved_places (user_id, place_id, thumbnail_url)
  select
    reel.user_id,
    reel_place.place_id,
    place.thumbnail_url
  from public.reels as reel
  join public.reel_places as reel_place
    on reel_place.reel_id = reel.id
  join public.places as place
    on place.id = reel_place.place_id
  where reel.id = p_reel_id
    and reel.save_mode = 'AUTO_SAVE'
    and reel.processing_status = 'COMPLETED'
  on conflict (user_id, place_id) do nothing;

  update public.reel_places as reel_place
  set
    review_status = 'SAVED',
    reviewed_at = case
      when reel_place.review_status = 'SAVED'
        and reel_place.reviewed_at is not null
      then reel_place.reviewed_at
      else now()
    end
  where reel_place.reel_id = p_reel_id
    and exists (
      select 1
      from public.reels as reel
      where reel.id = reel_place.reel_id
        and reel.save_mode = 'AUTO_SAVE'
        and reel.processing_status = 'COMPLETED'
    );
end;
$$;

revoke all on function public.finalize_auto_save_reel(uuid) from public;
revoke all on function public.finalize_auto_save_reel(uuid) from anon;
revoke all on function public.finalize_auto_save_reel(uuid) from authenticated;

create function public.finalize_auto_save_reel_on_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.save_mode = 'AUTO_SAVE'
     and new.processing_status = 'COMPLETED' then
    perform public.finalize_auto_save_reel(new.id);
  end if;
  return new;
end;
$$;

create trigger finalize_auto_save_reel_on_completion
  after update of processing_status, save_mode on public.reels
  for each row
  when (
    new.save_mode = 'AUTO_SAVE'
    and new.processing_status = 'COMPLETED'
  )
  execute function public.finalize_auto_save_reel_on_completion();

revoke all on function public.finalize_auto_save_reel_on_completion() from public;
revoke all on function public.finalize_auto_save_reel_on_completion() from anon;
revoke all on function public.finalize_auto_save_reel_on_completion() from authenticated;

-- 기존 릴스의 mode 확정과 재처리 선점을 한 행 잠금 안에서 함께 수행한다.
-- save_mode만 먼저 갱신하면 set_reels_updated_at 트리거가 stale 기준 시각을
-- 새로 써 버리므로, stale 판정은 어떤 update보다 먼저 잠긴 행에서 계산한다.
create function public.claim_reel_request(
  p_reel_id uuid,
  p_user_id uuid,
  p_requested_mode text,
  p_pipeline_version integer,
  p_stale_before timestamptz,
  p_instagram_url text,
  p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reel public.reels%rowtype;
  v_requested_mode text := upper(trim(coalesce(p_requested_mode, '')));
  v_actual_mode text;
  v_should_process boolean;
begin
  if v_requested_mode not in ('AUTO_SAVE', 'REVIEW_QUEUE') then
    raise exception using
      errcode = '22023',
      message = 'invalid_reel_save_mode';
  end if;

  if p_pipeline_version <= 0 or p_stale_before is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_reel_processing_claim';
  end if;

  select reel.*
  into v_reel
  from public.reels as reel
  where reel.id = p_reel_id
    and reel.user_id = p_user_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'reel_not_found';
  end if;

  v_actual_mode := case
    when v_reel.save_mode = 'AUTO_SAVE' or v_requested_mode = 'AUTO_SAVE'
      then 'AUTO_SAVE'
    else 'REVIEW_QUEUE'
  end;

  v_should_process :=
    v_reel.processing_version <> p_pipeline_version
    or v_reel.processing_status = 'FAILED'
    -- 처리 중 REVIEW_QUEUE를 AUTO_SAVE로 승격할 때는 기존 작업을 폐기하고
    -- 새 AUTO_SAVE 실행으로 다시 선점한다. 그래야 queue retry에서 보존한
    -- 과거 SAVED/DISCARDED 관계가 v1 결과에 섞이지 않고, mode-only update가
    -- updated_at을 갱신해 stale 감지를 늦추지도 않는다.
    or (
      v_reel.save_mode = 'REVIEW_QUEUE'
      and v_requested_mode = 'AUTO_SAVE'
      and v_reel.processing_status in ('PENDING', 'PROCESSING')
    )
    or (
      v_reel.processing_status in ('PENDING', 'PROCESSING')
      and v_reel.updated_at <= p_stale_before
    );

  if v_should_process then
    update public.reels
    set
      instagram_url = p_instagram_url,
      source = p_source,
      place_id = null,
      processing_version = p_pipeline_version,
      processing_status = 'PROCESSING',
      failure_reason = null,
      save_mode = v_actual_mode,
      processing_token = gen_random_uuid()
    where id = p_reel_id
    returning * into v_reel;

    -- 실행권 교체와 이전 결과 정리를 같은 transaction에서 끝낸다.
    -- claim 뒤 별도 cleanup RPC를 호출하면 그 사이 다른 요청이 token을
    -- 교체해 정상 요청이 stale cleanup 500을 받을 수 있다.
    delete from public.reel_places
    where reel_id = p_reel_id
      and (
        v_actual_mode = 'AUTO_SAVE'
        or review_status = 'PENDING'
      );

    delete from public.reel_place_match_failures
    where reel_id = p_reel_id;
  elsif v_actual_mode is distinct from v_reel.save_mode then
    update public.reels
    set save_mode = v_actual_mode
    where id = p_reel_id
    returning * into v_reel;
  elsif v_actual_mode = 'AUTO_SAVE'
        and v_reel.processing_status = 'COMPLETED' then
    perform public.finalize_auto_save_reel(p_reel_id);
  end if;

  return jsonb_build_object(
    'id', v_reel.id,
    'place_id', v_reel.place_id,
    'processing_status', v_reel.processing_status,
    'failure_reason', v_reel.failure_reason,
    'processing_version', v_reel.processing_version,
    'updated_at', v_reel.updated_at,
    'save_mode', v_reel.save_mode,
    'processing_token', v_reel.processing_token,
    'should_process', v_should_process
  );
end;
$$;

revoke all on function public.claim_reel_request(
  uuid, uuid, text, integer, timestamptz, text, text
) from public;
revoke all on function public.claim_reel_request(
  uuid, uuid, text, integer, timestamptz, text, text
) from anon;
revoke all on function public.claim_reel_request(
  uuid, uuid, text, integer, timestamptz, text, text
) from authenticated;
grant execute on function public.claim_reel_request(
  uuid, uuid, text, integer, timestamptz, text, text
) to service_role;

comment on function public.claim_reel_request(
  uuid, uuid, text, integer, timestamptz, text, text
) is '기존 릴스의 AUTO_SAVE 우선 mode와 재처리 실행권을 원자적으로 확정한다';

-- 분석 결과 관계와 v1 자동 저장을 원자적으로 기록한다. conflict에서는 position만
-- 갱신해 이미 SAVED/DISCARDED로 확정된 상태를 PENDING으로 재개방하지 않는다.
create function public.persist_reel_place_result(
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
    reel.processing_token
  into v_user_id, v_save_mode, v_processing_status, v_processing_token
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

  -- 재처리 때 보존한 SAVED/DISCARDED 행의 position과 충돌하면 새 결과를
  -- 뒤에 붙인다. 기존 확정 행 자체의 상태와 순서는 바꾸지 않는다.
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
    reviewed_at
  )
  values (
    p_reel_id,
    p_place_id,
    v_effective_position,
    case when v_save_mode = 'AUTO_SAVE' then 'SAVED' else 'PENDING' end,
    case when v_save_mode = 'AUTO_SAVE' then now() else null end
  )
  on conflict (reel_id, place_id) do update
    set position = existing_reel_place.position
  returning id into v_reel_place_id;

  if v_save_mode = 'AUTO_SAVE' then
    insert into public.saved_places (user_id, place_id, thumbnail_url)
    select
      v_user_id,
      place.id,
      coalesce(p_thumbnail_url, place.thumbnail_url)
    from public.places as place
    where place.id = p_place_id
    on conflict (user_id, place_id) do nothing;
  end if;

  return v_reel_place_id;
end;
$$;

revoke all on function public.persist_reel_place_result(uuid, uuid, integer, text, uuid) from public;
revoke all on function public.persist_reel_place_result(uuid, uuid, integer, text, uuid) from anon;
revoke all on function public.persist_reel_place_result(uuid, uuid, integer, text, uuid) from authenticated;
grant execute on function public.persist_reel_place_result(uuid, uuid, integer, text, uuid) to service_role;

comment on function public.persist_reel_place_result(uuid, uuid, integer, text, uuid) is
  '현재 reel.save_mode에 따라 분석 장소를 자동 저장 또는 v2 대기함에 기록한다';

-- 재시도와 완료 캐시 fallback이 부분 결과를 정리할 때도 현재 실행만 지울 수 있다.
-- 이미 사용자가 확정한 SAVED/DISCARDED 관계는 어떤 재시도에서도 보존한다.
create function public.reset_pending_reel_results(
  p_reel_id uuid,
  p_processing_token uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer;
  v_save_mode text;
begin
  select reel.save_mode
  into v_save_mode
  from public.reels as reel
  where reel.id = p_reel_id
    and reel.processing_status = 'PROCESSING'
    and reel.processing_token = p_processing_token
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  delete from public.reel_places
  where reel_id = p_reel_id
    and (
      v_save_mode = 'AUTO_SAVE'
      or review_status = 'PENDING'
    );
  get diagnostics v_deleted_count = row_count;

  delete from public.reel_place_match_failures
  where reel_id = p_reel_id;

  return v_deleted_count;
end;
$$;

revoke all on function public.reset_pending_reel_results(uuid, uuid) from public;
revoke all on function public.reset_pending_reel_results(uuid, uuid) from anon;
revoke all on function public.reset_pending_reel_results(uuid, uuid) from authenticated;
grant execute on function public.reset_pending_reel_results(uuid, uuid) to service_role;

comment on function public.reset_pending_reel_results(uuid, uuid) is
  '현재 재시도 실행에서 AUTO_SAVE 결과는 재생성하고 REVIEW_QUEUE의 사용자 확정 상태만 보존한다';

-- 여러 릴스에서 선택한 v2 대기 장소를 한 번에 저장하거나 제외한다.
create function public.resolve_queue_items(
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
      and reel.save_mode = 'REVIEW_QUEUE'
      and reel.processing_status = 'COMPLETED'
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
  '본인의 완료된 REVIEW_QUEUE 장소를 SAVE 또는 DISCARD로 일괄 확정한다';

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
grant select, insert, update, delete on public.reel_reports to service_role;

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
        and reel.processing_status = 'FAILED'
    )
  );

comment on table public.reel_reports is
  '분석 실패 히스토리에서 사용자가 보낸 신고/제보';
