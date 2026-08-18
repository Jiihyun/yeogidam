begin;
select plan(2);

insert into auth.users (id, aud, role, email)
values (
  '77777777-7777-7777-7777-777777777777',
  'authenticated',
  'authenticated',
  'uncapped-place-test@example.com'
);

insert into public.reels (id, user_id, instagram_url)
values (
  '77777777-7777-7777-7777-777777777778',
  '77777777-7777-7777-7777-777777777777',
  'https://www.instagram.com/reel/uncapped-place-test/'
);

prepare insert_later_place_failure as
  insert into public.reel_place_match_failures (
    reel_id,
    guess_index,
    place_name,
    failure_stage,
    failure_reason,
    search_origin
  ) values (
    '77777777-7777-7777-7777-777777777778',
    11,
    '이카',
    'KAKAO_SEARCH',
    'NO_KAKAO_CANDIDATE',
    'INITIAL'
  );

select lives_ok(
  'insert_later_place_failure',
  '10번째 이후 장소의 실패 기록 저장 가능'
);

prepare insert_negative_place_failure as
  insert into public.reel_place_match_failures (
    reel_id,
    guess_index,
    place_name,
    failure_stage,
    failure_reason,
    search_origin
  ) values (
    '77777777-7777-7777-7777-777777777778',
    -1,
    '잘못된 장소',
    'KAKAO_SEARCH',
    'NO_KAKAO_CANDIDATE',
    'INITIAL'
  );

select throws_ok(
  'insert_negative_place_failure',
  '23514',
  null,
  '음수 guess_index는 계속 거부'
);

select * from finish();
rollback;
