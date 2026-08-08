begin;
select plan(6);

-- 두 명의 유저를 auth.users에 직접 생성 (테스트 픽스처)
insert into auth.users (id, aud, role, email)
values ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'a@test.dev'),
       ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'b@test.dev');

-- 공용 place 1개, 각 유저의 reels/saved_places 데이터 시드 (service context = 현재 postgres 역할)
insert into public.places (id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PlaceA');
insert into public.reels (id, user_id, instagram_url)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'https://ig/u1'),
       ('dddddddd-dddd-dddd-dddd-dddddddddddd', '22222222-2222-2222-2222-222222222222', 'https://ig/u2');
insert into public.saved_places (user_id, place_id)
values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- 유저1 컨텍스트로 전환
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub','11111111-1111-1111-1111-111111111111','role','authenticated')::text, true);

-- 유저1은 자기 reels만 봄
select is(
  (select count(*)::int from public.reels),
  1, '유저1은 자신의 reels 1건만 조회');

-- 유저1은 자기 saved_places만 봄
select is(
  (select count(*)::int from public.saved_places),
  1, '유저1은 자신의 saved_places 1건만 조회');

-- places는 공개 → 조회 가능
select is(
  (select count(*)::int from public.places),
  1, '유저1은 공용 places 조회 가능');

-- 유저1은 reels에 직접 INSERT 불가 (정책 없음 → 거부)
prepare ins_reel as
  insert into public.reels (user_id, instagram_url)
  values ('11111111-1111-1111-1111-111111111111', 'https://ig/hack');
select throws_ok('ins_reel', '42501', null, '사용자는 reels 직접 INSERT 불가');

-- 유저2 컨텍스트로 전환
select set_config('request.jwt.claims',
  json_build_object('sub','22222222-2222-2222-2222-222222222222','role','authenticated')::text, true);

-- 유저2는 유저1의 saved_places를 못 봄
select is(
  (select count(*)::int from public.saved_places),
  0, '유저2는 유저1의 saved_places 조회 불가');

-- 유저2는 유저1의 reels를 삭제 불가 (본인 것만 삭제 → 0 rows affected)
with del as (
  delete from public.reels
  where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  returning 1
)
select is( (select count(*)::int from del), 0, '유저2는 유저1의 reels 삭제 불가');

select * from finish();
rollback;
