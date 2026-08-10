-- 장소 상세에서 현재 사용자가 저장한 관련 릴스를 조회한다.
grant select on public.reel_places to authenticated;

create policy "reel_places_select_own" on public.reel_places
  for select to authenticated
  using (
    exists (
      select 1
      from public.reels
      where reels.id = reel_places.reel_id
        and reels.user_id = auth.uid()
    )
  );
