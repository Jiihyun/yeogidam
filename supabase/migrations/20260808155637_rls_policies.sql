-- RLS 활성화
alter table public.profiles     enable row level security;
alter table public.places       enable row level security;
alter table public.reels        enable row level security;
alter table public.saved_places enable row level security;

-- 테이블 접근 권한: Supabase 로컬에서 anon/authenticated 는 기본 GRANT 가 없으므로 명시적으로 부여.
-- GRANT 는 RLS 와 AND 로 동작한다. 쓰기(INSERT/UPDATE)는 부여하지 않으므로 service_role 만 쓰기 가능.
grant select         on public.profiles     to authenticated;
grant update         on public.profiles     to authenticated;
grant select         on public.places       to authenticated;
grant select, delete on public.reels        to authenticated;
grant select, delete on public.saved_places to authenticated;

-- profiles: 본인만 조회/수정
create policy "profiles_select_own" on public.profiles
  for select to authenticated using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- places: 인증 사용자 전체 조회(공개). 쓰기 정책 없음 → service_role만.
create policy "places_select_all" on public.places
  for select to authenticated using (true);

-- reels: 본인 조회/삭제. 쓰기 정책 없음.
create policy "reels_select_own" on public.reels
  for select to authenticated using (auth.uid() = user_id);
create policy "reels_delete_own" on public.reels
  for delete to authenticated using (auth.uid() = user_id);

-- saved_places: 본인 조회/삭제. 쓰기 정책 없음.
create policy "saved_places_select_own" on public.saved_places
  for select to authenticated using (auth.uid() = user_id);
create policy "saved_places_delete_own" on public.saved_places
  for delete to authenticated using (auth.uid() = user_id);
