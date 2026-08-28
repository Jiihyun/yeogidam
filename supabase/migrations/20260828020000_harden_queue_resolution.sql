-- 분석 도중 일부 장소 관계가 만들어진 뒤 릴스 전체가 실패할 수 있다.
-- 완료된 릴스의 PENDING 관계만 사용자가 확정할 수 있게 부모 상태까지 검증한다.

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

  perform 1
  from public.reel_places as reel_place
  join public.reels as reel on reel.id = reel_place.reel_id
  where reel_place.id = any(p_reel_place_ids)
    and reel.user_id = v_user_id
    and reel.processing_status = 'COMPLETED'
  order by reel_place.id
  for update of reel_place;

  select count(*)::integer
  into v_available_count
  from public.reel_places as reel_place
  join public.reels as reel on reel.id = reel_place.reel_id
  where reel_place.id = any(p_reel_place_ids)
    and reel.user_id = v_user_id
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

-- 신고/제보는 실패 상세 화면의 기능이므로 본인의 FAILED 릴스만 접수한다.
drop policy if exists "reel_reports_insert_own" on public.reel_reports;

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
