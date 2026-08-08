begin;
select plan(2);

-- 버킷 존재 + public 플래그
select is(
  (select public from storage.buckets where id = 'place-thumbnails'),
  true, 'place-thumbnails 버킷이 public 으로 존재');

-- 익명/인증 사용자도 읽기(SELECT) 정책이 걸려 있는지: storage.objects 에 대한 select 정책 존재
select isnt(
  (select count(*)::int
     from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'place_thumbnails_public_read'),
  0, 'place-thumbnails 공개 읽기 정책 존재');

select * from finish();
rollback;
