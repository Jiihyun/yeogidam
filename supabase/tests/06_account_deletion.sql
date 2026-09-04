begin;
select plan(10);

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

insert into public.reel_extractions (
  id,
  instagram_shortcode,
  instagram_url,
  pipeline_version,
  worker_reel_id,
  processing_status,
  cacheable
)
values (
  '66666666-cccc-cccc-cccc-cccccccccccc',
  'delete-account-cache',
  'https://www.instagram.com/reel/delete-account-cache/',
  9,
  '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'COMPLETED',
  true
);

update public.reels
set extraction_id = '66666666-cccc-cccc-cccc-cccccccccccc'
where id = '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

insert into public.reel_extraction_places (
  extraction_id,
  place_id,
  position
)
values (
  '66666666-cccc-cccc-cccc-cccccccccccc',
  '66666666-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  0
);

insert into public.reel_queue_batches (
  id,
  user_id,
  extraction_id,
  generation_created_at,
  generation_reel_id,
  instagram_shortcode
)
values (
  '66666666-dddd-dddd-dddd-dddddddddddd',
  '66666666-6666-6666-6666-666666666666',
  '66666666-cccc-cccc-cccc-cccccccccccc',
  (select created_at
   from public.reels
   where id = '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'delete-account-cache'
);

insert into public.reel_queue_items (
  id,
  batch_id,
  place_id,
  position
)
values (
  '66666666-eeee-eeee-eeee-eeeeeeeeeeee',
  '66666666-dddd-dddd-dddd-dddddddddddd',
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
select is(
  (select count(*)::int
   from public.reel_queue_batches
   where user_id = '66666666-6666-6666-6666-666666666666'),
  0,
  'auth user 삭제 시 사용자 queue batch cascade 삭제'
);
select is(
  (select count(*)::int
   from public.reel_queue_items
   where batch_id = '66666666-dddd-dddd-dddd-dddddddddddd'),
  0,
  'queue batch 삭제 시 queue item cascade 삭제'
);
select ok(
  (select worker_reel_id is null
   from public.reel_extractions
   where id = '66666666-cccc-cccc-cccc-cccccccccccc'),
  '공용 extraction은 계정 삭제 후 보존되고 worker FK만 해제'
);
select is(
  (select count(*)::int
   from public.reel_extraction_places
   where extraction_id = '66666666-cccc-cccc-cccc-cccccccccccc'),
  1,
  '공용 extraction 장소도 계정 삭제 후 보존'
);

select * from finish();
rollback;
