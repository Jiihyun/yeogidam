begin;
select plan(6);

insert into auth.users (id, aud, role, email)
values (
  '66666666-6666-6666-6666-666666666666',
  'authenticated',
  'authenticated',
  'delete-account-test@test.dev'
);

insert into public.places (id, name)
values ('66666666-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '공용 장소');

insert into public.reels (id, user_id, instagram_url)
values (
  '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  '66666666-6666-6666-6666-666666666666',
  'https://www.instagram.com/reel/delete-test/'
);

insert into public.reel_places (reel_id, place_id, position)
values (
  '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  '66666666-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  0
);

insert into public.saved_places (user_id, place_id)
values (
  '66666666-6666-6666-6666-666666666666',
  '66666666-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
);

insert into public.reel_reports (user_id, reel_id)
values (
  '66666666-6666-6666-6666-666666666666',
  '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
);

delete from auth.users
where id = '66666666-6666-6666-6666-666666666666';

select is(
  (select count(*)::int from public.profiles where id = '66666666-6666-6666-6666-666666666666'),
  0,
  'auth user 삭제 시 profile cascade 삭제'
);
select is(
  (select count(*)::int from public.reels where id = '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0,
  'auth user 삭제 시 reel cascade 삭제'
);
select is(
  (select count(*)::int from public.saved_places where user_id = '66666666-6666-6666-6666-666666666666'),
  0,
  'auth user 삭제 시 saved_places cascade 삭제'
);
select is(
  (select count(*)::int from public.reel_places where reel_id = '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0,
  'reel 삭제 시 reel_places cascade 삭제'
);
select is(
  (select count(*)::int from public.reel_reports where user_id = '66666666-6666-6666-6666-666666666666'),
  0,
  'auth user 삭제 시 reel_reports cascade 삭제'
);
select is(
  (select count(*)::int from public.places where id = '66666666-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  '공용 place는 계정 삭제 후에도 보존'
);

select * from finish();
rollback;
