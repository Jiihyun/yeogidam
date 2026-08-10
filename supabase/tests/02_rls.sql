begin;
select plan(13);

-- 두 명의 유저를 auth.users에 직접 생성 (테스트 픽스처)
insert into auth.users (id, aud, role, email)
values ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'a@test.dev'),
       ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'b@test.dev');

-- 프로필 시드 (Task 4 트리거가 있으면 이미 생성되므로 on conflict do nothing 으로 양립)
insert into public.profiles (id, nickname)
values ('11111111-1111-1111-1111-111111111111', 'U1'),
       ('22222222-2222-2222-2222-222222222222', 'U2')
on conflict (id) do nothing;

-- 공용 place 1개, 각 유저의 reels/saved_places 데이터 시드 (service context = 현재 postgres 역할)
insert into public.places (id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PlaceA');
insert into public.reels (id, user_id, instagram_url)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'https://ig/u1'),
       ('dddddddd-dddd-dddd-dddd-dddddddddddd', '22222222-2222-2222-2222-222222222222', 'https://ig/u2');
insert into public.reel_places (reel_id, place_id, position)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0),
       ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0);
insert into public.reels (user_id, instagram_url, instagram_shortcode)
values (
  '11111111-1111-1111-1111-111111111111',
  'https://www.instagram.com/reel/cache-test/',
  'cache-test'
);

prepare duplicate_user_reel as
  insert into public.reels (user_id, instagram_url, instagram_shortcode)
  values (
    '11111111-1111-1111-1111-111111111111',
    'https://instagram.com/reels/cache-test/?igsh=duplicate',
    'cache-test'
  );
select throws_ok(
  'duplicate_user_reel',
  '23505',
  null,
  '같은 사용자의 동일 Instagram shortcode 중복 저장 불가'
);

prepare shared_reel_other_user as
  insert into public.reels (user_id, instagram_url, instagram_shortcode)
  values (
    '22222222-2222-2222-2222-222222222222',
    'https://www.instagram.com/reel/cache-test/',
    'cache-test'
  );
select lives_ok(
  'shared_reel_other_user',
  '다른 사용자는 동일 Instagram shortcode 저장 가능'
);
delete from public.reels where instagram_shortcode = 'cache-test';
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

-- 유저1은 본인 릴스의 장소 관계만 봄
select is(
  (select count(*)::int from public.reel_places),
  1, '유저1은 본인 릴스의 reel_places만 조회');

-- places는 공개 → 조회 가능
select is(
  (select count(*)::int from public.places),
  1, '유저1은 공용 places 조회 가능');

-- 유저1은 자기 profiles 만 봄
select is(
  (select count(*)::int from public.profiles),
  1, '유저1은 자신의 profiles 1건만 조회');

-- 유저1은 reels에 직접 INSERT 불가 (정책 없음 → 거부)
prepare ins_reel as
  insert into public.reels (user_id, instagram_url)
  values ('11111111-1111-1111-1111-111111111111', 'https://ig/hack');
select throws_ok('ins_reel', '42501', null, '사용자는 reels 직접 INSERT 불가');

prepare ins_reel_place as
  insert into public.reel_places (reel_id, place_id, position)
  values (
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    1
  );
select throws_ok(
  'ins_reel_place',
  '42501',
  null,
  '사용자는 reel_places 직접 INSERT 불가'
);

-- 유저2 컨텍스트로 전환
select set_config('request.jwt.claims',
  json_build_object('sub','22222222-2222-2222-2222-222222222222','role','authenticated')::text, true);

-- 유저2는 유저1의 saved_places를 못 봄
select is(
  (select count(*)::int from public.saved_places),
  0, '유저2는 유저1의 saved_places 조회 불가');

select is(
  (select count(*)::int from public.reel_places),
  1, '유저2는 본인 릴스의 reel_places만 조회');

-- 유저2는 유저1의 reels를 삭제 불가 (본인 것만 삭제 → 0 rows affected)
with del as (
  delete from public.reels
  where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  returning 1
)
select is( (select count(*)::int from del), 0, '유저2는 유저1의 reels 삭제 불가');

-- 유저2는 유저1의 profiles 를 수정 불가 (본인 것만 → 0 rows affected)
with upd as (
  update public.profiles set description = 'hacked'
  where id = '11111111-1111-1111-1111-111111111111'
  returning 1
)
select is( (select count(*)::int from upd), 0, '유저2는 유저1의 profiles 수정 불가');

select * from finish();
rollback;
