begin;
select plan(3);

-- 새 유저 생성 시 profiles 자동 생성 (닉네임 메타데이터 포함)
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values ('33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated',
        'c@test.dev', '{"nickname":"온림러버"}'::jsonb);

select is(
  (select nickname from public.profiles where id = '33333333-3333-3333-3333-333333333333'),
  '온림러버', 'auth.users 생성 시 profiles 자동 생성 + 닉네임 매핑');

-- 메타데이터 없는(익명) 유저도 profiles 생성 (닉네임 NULL)
insert into auth.users (id, aud, role)
values ('44444444-4444-4444-4444-444444444444', 'authenticated', 'authenticated');

select is(
  (select count(*)::int from public.profiles where id = '44444444-4444-4444-4444-444444444444'),
  1, '익명 유저도 profiles 자동 생성');

-- updated_at 자동 갱신: 강제로 과거값으로 만든 뒤 update 하면 now()로 바뀜
update public.profiles set updated_at = 'epoch'
  where id = '33333333-3333-3333-3333-333333333333';
update public.profiles set description = 'hi'
  where id = '33333333-3333-3333-3333-333333333333';

select ok(
  (select updated_at from public.profiles where id = '33333333-3333-3333-3333-333333333333') > now() - interval '1 minute',
  'profiles UPDATE 시 updated_at 자동 갱신');

select * from finish();
rollback;
