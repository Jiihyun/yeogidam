-- 썸네일 재호스팅용 공개 버킷
insert into storage.buckets (id, name, public)
values ('place-thumbnails', 'place-thumbnails', true)
on conflict (id) do nothing;

-- 공개 읽기 정책 (쓰기 정책 없음 → service_role만 업로드)
create policy "place_thumbnails_public_read" on storage.objects
  for select
  using (bucket_id = 'place-thumbnails');
