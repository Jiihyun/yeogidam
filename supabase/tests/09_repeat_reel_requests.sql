begin;
select plan(80);

select has_table('public', 'reel_extractions', '공용 릴스 추출 테이블 존재');
select has_table('public', 'reel_extraction_places', '공용 추출 장소 테이블 존재');
select has_table('public', 'reel_queue_batches', '사용자별 queue batch 테이블 존재');
select has_table('public', 'reel_queue_items', 'queue item 테이블 존재');
select has_column('public', 'reel_queue_batches', 'created_at', 'queue 카드 생성 시각 존재');
select hasnt_column('public', 'reel_queue_batches', 'last_queued_at', '별도 queue 갱신 시각은 사용하지 않음');
select has_column('public', 'saved_places', 'last_saved_at', '최근 저장 시각 존재');
select has_column('public', 'reels', 'request_id', '요청 멱등 ID 존재');
select has_column('public', 'reels', 'extraction_id', '요청의 공용 extraction FK 존재');
select has_view('public', 'user_related_reels', '관련 릴스 중복 제거 view 존재');

insert into auth.users (id, aud, role, email)
values
  ('91000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'repeat-a@test.dev'),
  ('92000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'repeat-b@test.dev');

insert into public.places (id, name, thumbnail_url)
values
  ('e1000000-0000-0000-0000-000000000001', '반복 장소 1', 'https://example.com/e1.jpg'),
  ('e2000000-0000-0000-0000-000000000002', '반복 장소 2', 'https://example.com/e2.jpg'),
  ('e3000000-0000-0000-0000-000000000003', '자동 저장 원자성 장소', null),
  ('e4000000-0000-0000-0000-000000000004', '반복 장소 3', 'https://example.com/e4.jpg');

select set_config(
  'test.repeat_first',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'd1000000-0000-0000-0000-000000000001',
    'repeat-cache',
    'https://www.instagram.com/reel/repeat-cache/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);

select is(
  (current_setting('test.repeat_first')::jsonb ->> 'should_process')::boolean,
  true,
  '최초 요청은 공용 extraction 처리를 선점'
);
select is(
  current_setting('test.repeat_first')::jsonb ->> 'worker_reel_id',
  current_setting('test.repeat_first')::jsonb ->> 'reel_id',
  '최초 요청 reels 행이 기존 pipeline worker가 됨'
);
select is(
  (select count(*)::integer
   from public.reels
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'),
  1,
  '최초 명시 요청 히스토리 한 건 생성'
);

select set_config(
  'test.repeat_duplicate',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'd1000000-0000-0000-0000-000000000001',
    'repeat-cache',
    'https://www.instagram.com/reel/repeat-cache/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);

select is(
  (current_setting('test.repeat_duplicate')::jsonb ->> 'duplicate')::boolean,
  true,
  '같은 client request ID 재전송은 duplicate로 반환'
);
select is(
  current_setting('test.repeat_duplicate')::jsonb ->> 'reel_id',
  current_setting('test.repeat_first')::jsonb ->> 'reel_id',
  '네트워크 재전송은 기존 히스토리 ID를 반환'
);
select is(
  (select count(*)::integer
   from public.reels
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'),
  1,
  '네트워크 재전송은 히스토리를 늘리지 않음'
);

prepare mismatched_idempotency_payload as
  select public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'd1000000-0000-0000-0000-000000000001',
    'different-reel',
    'https://www.instagram.com/reel/different-reel/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  );
select throws_ok(
  'mismatched_idempotency_payload',
  '22023',
  'idempotency_key_payload_mismatch',
  '같은 request ID를 다른 요청 payload에 재사용하면 거부'
);

select set_config(
  'test.repeat_second',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'd2000000-0000-0000-0000-000000000002',
    'repeat-cache',
    'https://www.instagram.com/reel/repeat-cache/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);

select ok(
  not (current_setting('test.repeat_second')::jsonb ->> 'should_process')::boolean
    and current_setting('test.repeat_second')::jsonb ->> 'extraction_id'
      = current_setting('test.repeat_first')::jsonb ->> 'extraction_id',
  '처리 중인 같은 릴스의 새 명시 요청은 같은 worker 완료를 기다림'
);
select is(
  (select count(*)::integer
   from public.reels
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'),
  2,
  '처리 중이어도 서로 다른 명시 요청은 히스토리에 각각 남음'
);

select public.persist_reel_place_result(
  (current_setting('test.repeat_first')::jsonb ->> 'worker_reel_id')::uuid,
  'e1000000-0000-0000-0000-000000000001',
  0,
  null,
  (current_setting('test.repeat_first')::jsonb ->> 'processing_token')::uuid
);
select public.persist_reel_place_result(
  (current_setting('test.repeat_first')::jsonb ->> 'worker_reel_id')::uuid,
  'e2000000-0000-0000-0000-000000000002',
  1,
  null,
  (current_setting('test.repeat_first')::jsonb ->> 'processing_token')::uuid
);
select public.persist_reel_place_result(
  (current_setting('test.repeat_first')::jsonb ->> 'worker_reel_id')::uuid,
  'e4000000-0000-0000-0000-000000000004',
  2,
  null,
  (current_setting('test.repeat_first')::jsonb ->> 'processing_token')::uuid
);

select is(
  public.finalize_reel_extraction(
    (current_setting('test.repeat_first')::jsonb ->> 'extraction_id')::uuid,
    (current_setting('test.repeat_first')::jsonb ->> 'worker_reel_id')::uuid,
    (current_setting('test.repeat_first')::jsonb ->> 'processing_token')::uuid,
    true
  ),
  2,
  '한 worker 완료가 연결된 요청 히스토리 두 건을 함께 완료'
);
select is(
  (select count(*)::integer
   from public.reels
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'
     and processing_status = 'COMPLETED'),
  2,
  '연결된 요청은 모두 성공 히스토리로 확정'
);
select is(
  (select count(*)::integer
   from public.reel_extraction_places
   where extraction_id =
     (current_setting('test.repeat_first')::jsonb ->> 'extraction_id')::uuid),
  3,
  'worker의 전체 장소를 공용 extraction에 고정'
);
select is(
  (select count(*)::integer
   from public.reel_queue_batches
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'
     and resolved_at is null),
  1,
  '동시에 기다리던 같은 사용자 요청은 open queue 카드 하나만 생성'
);
select is(
  (select count(*)::integer
   from public.reel_queue_items as queue_item
   join public.reel_queue_batches as batch on batch.id = queue_item.batch_id
   where batch.user_id = '91000000-0000-0000-0000-000000000001'
     and batch.instagram_shortcode = 'repeat-cache'),
  3,
  'open queue 카드의 장소도 중복 없이 한 벌만 생성'
);

select set_config(
  'test.repeat_open_batch_before_reshare',
  (select id::text
   from public.reel_queue_batches
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'
     and resolved_at is null),
  true
);

select set_config(
  'test.repeat_item_before_reshare',
  (select id::text
   from public.reel_queue_items
   where batch_id =
       current_setting('test.repeat_open_batch_before_reshare')::uuid
     and place_id = 'e1000000-0000-0000-0000-000000000001'),
  true
);
select set_config(
  'test.repeat_batch_created_at_before_duplicate',
  (select created_at::text
   from public.reel_queue_batches
   where id = current_setting('test.repeat_open_batch_before_reshare')::uuid),
  true
);

update public.reel_queue_items as queue_item
set
  review_status = 'SAVED',
  reviewed_at = now()
where queue_item.batch_id =
    current_setting('test.repeat_open_batch_before_reshare')::uuid
  and queue_item.place_id = 'e1000000-0000-0000-0000-000000000001';

insert into public.saved_places (
  user_id,
  place_id,
  last_saved_at
)
values (
  '91000000-0000-0000-0000-000000000001',
  'e1000000-0000-0000-0000-000000000001',
  '2000-01-01 00:00:00+00'
);

select set_config(
  'test.repeat_completed_duplicate',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'd1000000-0000-0000-0000-000000000001',
    'repeat-cache',
    'https://www.instagram.com/reel/repeat-cache/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);

select ok(
  (select queue_item.id =
        current_setting('test.repeat_item_before_reshare')::uuid
      and queue_item.review_status = 'SAVED'
      and batch.created_at::text =
        current_setting('test.repeat_batch_created_at_before_duplicate')
   from public.reel_queue_batches as batch
   join public.reel_queue_items as queue_item on queue_item.batch_id = batch.id
   where batch.id =
       current_setting('test.repeat_open_batch_before_reshare')::uuid
     and queue_item.place_id = 'e1000000-0000-0000-0000-000000000001'),
  '같은 request ID 재전송은 카드·item ID·생성 시각·처리 상태를 바꾸지 않음'
);
select is(
  (select count(*)::integer
   from public.reels
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'),
  2,
  '완료 뒤 같은 request ID 재전송도 히스토리를 늘리지 않음'
);

-- pgTAP 파일은 한 transaction이라 now()가 고정된다. 새 명시 요청과 과거
-- 요청의 순서를 명확히 만들어 실제 API 호출 간 시간 차이를 재현한다.
update public.reels
set created_at = '2000-01-01 00:00:00+00'
where user_id = '91000000-0000-0000-0000-000000000001'
  and instagram_shortcode = 'repeat-cache';
update public.reel_queue_batches
set generation_created_at = '2000-01-01 00:00:00+00'
where user_id = '91000000-0000-0000-0000-000000000001'
  and instagram_shortcode = 'repeat-cache';

select set_config(
  'test.repeat_third',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'd3000000-0000-0000-0000-000000000003',
    'repeat-cache',
    'https://www.instagram.com/reel/repeat-cache/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);

select is(
  (current_setting('test.repeat_third')::jsonb ->> 'reused')::boolean,
  true,
  '완료된 같은 릴스는 외부 API 없이 공용 장소 캐시 재사용'
);
select is(
  (select count(*)::integer
   from public.reels
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'),
  3,
  '캐시 재사용도 새 명시 요청 히스토리로 남음'
);
select is(
  (select count(*)::integer
   from public.reel_queue_batches
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'),
  1,
  '미처리 queue가 있으면 캐시 재요청도 카드를 늘리지 않음'
);
select is(
  (select count(*)::integer
   from public.reel_queue_batches
   where id = current_setting('test.repeat_open_batch_before_reshare')::uuid),
  0,
  '재공유 성공 시 기존 open queue 카드 행을 물리 삭제'
);
select is(
  (select count(*)::integer
   from public.reel_queue_items as queue_item
   join public.reel_queue_batches as batch on batch.id = queue_item.batch_id
   where batch.user_id = '91000000-0000-0000-0000-000000000001'
     and batch.instagram_shortcode = 'repeat-cache'
     and queue_item.review_status = 'PENDING'
     and queue_item.reviewed_at is null),
  3,
  '재공유하면 이미 저장했던 장소까지 모두 queue에 다시 노출'
);
select isnt(
  (select id::text
   from public.reel_queue_batches
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'
     and resolved_at is null),
  current_setting('test.repeat_open_batch_before_reshare'),
  '재공유는 기존 카드와 다른 ID의 새 queue 카드를 생성'
);
select is(
  (select count(*)::integer
   from public.reel_queue_items
   where id = current_setting('test.repeat_item_before_reshare')::uuid),
  0,
  '기존 카드 삭제가 기존 item도 cascade 삭제'
);
select is(
  (select generation_reel_id::text
   from public.reel_queue_batches
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'
     and resolved_at is null),
  current_setting('test.repeat_third')::jsonb ->> 'reel_id',
  '새 queue 카드는 재공유 요청을 최신 세대로 기록'
);
select is(
  (select last_saved_at
   from public.saved_places
   where user_id = '91000000-0000-0000-0000-000000000001'
     and place_id = 'e1000000-0000-0000-0000-000000000001'),
  '2000-01-01 00:00:00+00'::timestamptz,
  '재공유만으로 이미 저장한 장소의 보관함 순서를 바꾸지 않음'
);

select set_config(
  'test.repeat_open_batch_after_reshare',
  (select id::text
   from public.reel_queue_batches
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'
     and resolved_at is null),
  true
);

select set_config(
  'test.repeat_item_before_stale_materialize',
  (select id::text
   from public.reel_queue_items
   where batch_id =
       current_setting('test.repeat_open_batch_after_reshare')::uuid
     and place_id = 'e2000000-0000-0000-0000-000000000002'),
  true
);
update public.reel_queue_items
set
  review_status = 'DISCARDED',
  reviewed_at = now()
where id = current_setting('test.repeat_item_before_stale_materialize')::uuid;
select public.materialize_reel_request(
  (current_setting('test.repeat_first')::jsonb ->> 'reel_id')::uuid
);
select ok(
  (select id::text = current_setting('test.repeat_item_before_stale_materialize')
      and review_status = 'DISCARDED'
   from public.reel_queue_items
   where batch_id =
       current_setting('test.repeat_open_batch_after_reshare')::uuid
     and place_id = 'e2000000-0000-0000-0000-000000000002'),
  '늦게 materialize된 과거 요청은 최신 카드의 처리 상태를 되돌리지 않음'
);
update public.reel_queue_items
set
  review_status = 'PENDING',
  reviewed_at = null
where id = current_setting('test.repeat_item_before_stale_materialize')::uuid;

select set_config(
  'test.repeat_other_user',
  public.begin_reel_request(
    '92000000-0000-0000-0000-000000000002',
    'd4000000-0000-0000-0000-000000000004',
    'repeat-cache',
    'https://www.instagram.com/reel/repeat-cache/',
    'url_input',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);

select ok(
  (current_setting('test.repeat_other_user')::jsonb ->> 'reused')::boolean
    and current_setting('test.repeat_other_user')::jsonb ->> 'extraction_id'
      = current_setting('test.repeat_first')::jsonb ->> 'extraction_id',
  '다른 사용자도 같은 shortcode/version의 완료 캐시 재사용'
);
select is(
  (select count(*)::integer
   from public.reel_extractions
   where instagram_shortcode = 'repeat-cache'
     and pipeline_version = 9),
  1,
  '사용자가 달라도 완전한 extraction은 한 벌만 유지'
);
select is(
  (select count(*)::integer
   from public.reel_queue_batches
   where user_id = '92000000-0000-0000-0000-000000000002'
     and instagram_shortcode = 'repeat-cache'
     and resolved_at is null),
  1,
  '대기함 상태는 캐시와 달리 사용자별로 생성'
);

select set_config(
  'test.repeat_batch',
  (select id::text
   from public.reel_queue_batches
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'
     and resolved_at is null),
  true
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
  'f1000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  (current_setting('test.repeat_first')::jsonb ->> 'extraction_id')::uuid,
  (select created_at
   from public.reels
   where id = (current_setting('test.repeat_third')::jsonb ->> 'reel_id')::uuid),
  (current_setting('test.repeat_third')::jsonb ->> 'reel_id')::uuid,
  'another-open-card'
);

insert into public.reel_queue_items (
  id,
  batch_id,
  place_id,
  position
)
values (
  'f2000000-0000-0000-0000-000000000002',
  'f1000000-0000-0000-0000-000000000001',
  'e1000000-0000-0000-0000-000000000001',
  0
);

update public.saved_places
set last_saved_at = '2000-01-01 00:00:00+00'
where user_id = '91000000-0000-0000-0000-000000000001'
  and place_id = 'e1000000-0000-0000-0000-000000000001';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '91000000-0000-0000-0000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

prepare stale_queue_item_save as
  select public.resolve_queue_items(
    array[current_setting('test.repeat_item_before_reshare')::uuid],
    'SAVE'
  );
select throws_ok(
  'stale_queue_item_save',
  'P0001',
  'queue_items_not_available',
  '재공유 전 item ID의 늦은 SAVE 요청은 새 카드를 변경하지 못함'
);

select is(
  public.resolve_queue_items(
    array[
      (select queue_item.id
       from public.reel_queue_items as queue_item
       where queue_item.batch_id = current_setting('test.repeat_batch')::uuid
         and queue_item.place_id = 'e1000000-0000-0000-0000-000000000001'),
      'f2000000-0000-0000-0000-000000000002'::uuid
    ],
    'SAVE'
  ),
  2,
  '여러 queue에서 같은 place를 선택해도 두 item은 함께 확정'
);
select is(
  (select count(*)::integer
   from public.saved_places
   where user_id = '91000000-0000-0000-0000-000000000001'
     and place_id = 'e1000000-0000-0000-0000-000000000001'),
  1,
  'bulk SAVE의 동일 place는 saved_places 한 행으로 dedupe'
);
select ok(
  (select last_saved_at > '2000-01-01 00:00:00+00'
   from public.saved_places
   where user_id = '91000000-0000-0000-0000-000000000001'
     and place_id = 'e1000000-0000-0000-0000-000000000001'),
  '이미 저장된 장소를 다시 SAVE하면 last_saved_at 갱신'
);
select ok(
  (select resolved_at is not null
   from public.reel_queue_batches
   where id = 'f1000000-0000-0000-0000-000000000001'),
  '모든 item을 처리한 보조 queue batch는 resolved 처리'
);

select is(
  public.resolve_queue_items(
    array[
      (select queue_item.id
       from public.reel_queue_items as queue_item
       where queue_item.batch_id = current_setting('test.repeat_batch')::uuid
         and queue_item.place_id = 'e2000000-0000-0000-0000-000000000002')
    ],
    'SAVE'
  ),
  1,
  '재공유 카드에서 처음 저장하는 두 번째 장소 확정'
);
select is(
  (select count(*)::integer
   from public.saved_places
   where user_id = '91000000-0000-0000-0000-000000000001'
     and place_id = 'e2000000-0000-0000-0000-000000000002'),
  1,
  '처음 저장한 두 번째 장소는 saved_places에 생성'
);
select ok(
  (select batch.resolved_at is null
      and (
        select count(*)
        from public.reel_queue_items as queue_item
        where queue_item.batch_id = batch.id
          and queue_item.review_status = 'PENDING'
          and queue_item.place_id = 'e4000000-0000-0000-0000-000000000004'
      ) = 1
   from public.reel_queue_batches as batch
   where batch.id = current_setting('test.repeat_batch')::uuid),
  'A와 B를 저장하면 재공유 카드에는 C만 남음'
);
select is(
  public.resolve_queue_items(
    array[
      (select queue_item.id
       from public.reel_queue_items as queue_item
       where queue_item.batch_id = current_setting('test.repeat_batch')::uuid
         and queue_item.place_id = 'e4000000-0000-0000-0000-000000000004')
    ],
    'DISCARD'
  ),
  1,
  '재공유 카드에 남은 세 번째 장소 제외'
);
select ok(
  (select resolved_at is not null
   from public.reel_queue_batches
   where id = current_setting('test.repeat_batch')::uuid),
  '재공유 카드의 모든 item 처리 뒤 resolved 처리'
);

reset role;

delete from public.reels
where id = (current_setting('test.repeat_third')::jsonb ->> 'reel_id')::uuid;

select public.materialize_reel_request(
  (current_setting('test.repeat_first')::jsonb ->> 'reel_id')::uuid
);
select is(
  (select count(*)::integer
   from public.reel_queue_batches
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'
     and resolved_at is null),
  0,
  '최신 히스토리를 삭제해도 늦은 과거 materialize가 resolved 카드를 되살리지 않음'
);

update public.reels
set created_at = '2000-01-01 00:00:00+00'
where user_id = '91000000-0000-0000-0000-000000000001'
  and instagram_shortcode = 'repeat-cache';
update public.reel_queue_batches
set generation_created_at = '2000-01-01 00:00:00+00'
where user_id = '91000000-0000-0000-0000-000000000001'
  and instagram_shortcode = 'repeat-cache';

select set_config(
  'test.repeat_fourth',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'd5000000-0000-0000-0000-000000000005',
    'repeat-cache',
    'https://www.instagram.com/reel/repeat-cache/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);

select is(
  (current_setting('test.repeat_fourth')::jsonb ->> 'reused')::boolean,
  true,
  'resolved 뒤 재요청도 완료 cache 재사용'
);
select is(
  (select count(*)::integer
   from public.reel_queue_batches
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'),
  2,
  '이전 queue가 resolved면 새 batch 생성'
);
select is(
  (select count(*)::integer
   from public.reel_queue_batches
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'
     and resolved_at is null),
  1,
  'resolved 뒤 재요청의 새 batch만 open 상태'
);
select is(
  (select count(*)::integer
   from public.reel_queue_items as queue_item
   join public.reel_queue_batches as batch on batch.id = queue_item.batch_id
   where batch.user_id = '91000000-0000-0000-0000-000000000001'
     and batch.instagram_shortcode = 'repeat-cache'
     and batch.resolved_at is null),
  3,
  '새 queue batch에 캐시 장소 전체를 다시 노출'
);

select set_config(
  'test.partial_first',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'da000000-0000-0000-0000-000000000010',
    'partial-cache',
    'https://www.instagram.com/reel/partial-cache/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);
select public.persist_reel_place_result(
  (current_setting('test.partial_first')::jsonb ->> 'worker_reel_id')::uuid,
  'e1000000-0000-0000-0000-000000000001',
  0,
  null,
  (current_setting('test.partial_first')::jsonb ->> 'processing_token')::uuid
);
select is(
  public.finalize_reel_extraction(
    (current_setting('test.partial_first')::jsonb ->> 'extraction_id')::uuid,
    (current_setting('test.partial_first')::jsonb ->> 'worker_reel_id')::uuid,
    (current_setting('test.partial_first')::jsonb ->> 'processing_token')::uuid,
    false
  ),
  1,
  '부분 성공 요청도 당시 히스토리/장소를 완료로 고정'
);

select set_config(
  'test.partial_open_batch_before_reextract',
  (select id::text
   from public.reel_queue_batches
   where user_id = '91000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'partial-cache'
     and resolved_at is null),
  true
);
select set_config(
  'test.partial_item_before_reextract',
  (select queue_item.id::text
   from public.reel_queue_items as queue_item
   where queue_item.batch_id =
       current_setting('test.partial_open_batch_before_reextract')::uuid),
  true
);

select set_config(
  'test.partial_second',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'db000000-0000-0000-0000-000000000011',
    'partial-cache',
    'https://www.instagram.com/reel/partial-cache/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);

select ok(
  exists (
    select 1
    from public.reel_queue_batches as batch
    join public.reel_queue_items as queue_item on queue_item.batch_id = batch.id
    where batch.id =
        current_setting('test.partial_open_batch_before_reextract')::uuid
      and batch.generation_reel_id =
        (current_setting('test.partial_first')::jsonb ->> 'reel_id')::uuid
      and batch.resolved_at is null
      and queue_item.id =
        current_setting('test.partial_item_before_reextract')::uuid
      and queue_item.review_status = 'PENDING'
  ),
  '새 추출이 진행 중인 동안 기존 open 카드와 item을 그대로 보존'
);
select is(
  (current_setting('test.partial_second')::jsonb ->> 'should_process')::boolean,
  true,
  '부분 성공 cache는 다음 명시 요청에서 외부 추출을 다시 수행'
);
select isnt(
  current_setting('test.partial_second')::jsonb ->> 'extraction_id',
  current_setting('test.partial_first')::jsonb ->> 'extraction_id',
  '부분 성공 attempt는 불변으로 두고 새 extraction 생성'
);
select is(
  (select count(*)::integer
   from public.reel_extraction_places
   where extraction_id =
     (current_setting('test.partial_first')::jsonb ->> 'extraction_id')::uuid),
  1,
  '새 재처리가 과거 부분 성공 장소 목록을 바꾸지 않음'
);
select is(
  (select processing_status
   from public.reels
   where id = (current_setting('test.partial_first')::jsonb ->> 'reel_id')::uuid),
  'COMPLETED',
  '새 재처리 중에도 과거 부분 성공 히스토리는 성공으로 유지'
);

select is(
  public.fail_reel_extraction(
    (current_setting('test.partial_second')::jsonb ->> 'extraction_id')::uuid,
    (current_setting('test.partial_second')::jsonb ->> 'worker_reel_id')::uuid,
    (current_setting('test.partial_second')::jsonb ->> 'processing_token')::uuid,
    'UNKNOWN'
  ),
  1,
  '새 재추출 실패를 해당 요청 히스토리에 반영'
);
select ok(
  exists (
    select 1
    from public.reel_queue_batches as batch
    join public.reel_queue_items as queue_item on queue_item.batch_id = batch.id
    where batch.id =
        current_setting('test.partial_open_batch_before_reextract')::uuid
      and batch.resolved_at is null
      and queue_item.id =
        current_setting('test.partial_item_before_reextract')::uuid
      and queue_item.review_status = 'PENDING'
  ),
  '새 재추출이 실패해도 기존 open 카드와 item을 보존'
);

update public.reels
set created_at = '2001-01-01 00:00:00+00'
where user_id = '91000000-0000-0000-0000-000000000001'
  and instagram_shortcode = 'partial-cache';
update public.reel_queue_batches
set generation_created_at = '2001-01-01 00:00:00+00'
where user_id = '91000000-0000-0000-0000-000000000001'
  and instagram_shortcode = 'partial-cache';

select set_config(
  'test.partial_third',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'db000000-0000-0000-0000-000000000021',
    'partial-cache',
    'https://www.instagram.com/reel/partial-cache/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);
select public.persist_reel_place_result(
  (current_setting('test.partial_third')::jsonb ->> 'worker_reel_id')::uuid,
  'e1000000-0000-0000-0000-000000000001',
  0,
  null,
  (current_setting('test.partial_third')::jsonb ->> 'processing_token')::uuid
);
select public.persist_reel_place_result(
  (current_setting('test.partial_third')::jsonb ->> 'worker_reel_id')::uuid,
  'e2000000-0000-0000-0000-000000000002',
  1,
  null,
  (current_setting('test.partial_third')::jsonb ->> 'processing_token')::uuid
);
select is(
  public.finalize_reel_extraction(
    (current_setting('test.partial_third')::jsonb ->> 'extraction_id')::uuid,
    (current_setting('test.partial_third')::jsonb ->> 'worker_reel_id')::uuid,
    (current_setting('test.partial_third')::jsonb ->> 'processing_token')::uuid,
    true
  ),
  1,
  '새 재추출은 성공한 순간에만 queue 교체를 확정'
);
select is(
  (select count(*)::integer
   from public.reel_queue_batches
   where id =
     current_setting('test.partial_open_batch_before_reextract')::uuid),
  0,
  '새 재추출 성공 시 기존 open 카드를 물리 삭제'
);
select ok(
  exists (
    select 1
    from public.reel_queue_batches as batch
    where batch.user_id = '91000000-0000-0000-0000-000000000001'
      and batch.instagram_shortcode = 'partial-cache'
      and batch.resolved_at is null
      and batch.id <>
        current_setting('test.partial_open_batch_before_reextract')::uuid
      and batch.generation_reel_id =
        (current_setting('test.partial_third')::jsonb ->> 'reel_id')::uuid
      and (
        select count(*)
        from public.reel_queue_items as queue_item
        where queue_item.batch_id = batch.id
          and queue_item.review_status = 'PENDING'
      ) = 2
  ),
  '새 재추출 결과 전체를 다른 ID의 새 queue 카드에 생성'
);

select set_config(
  'test.failure_first',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'dc000000-0000-0000-0000-000000000012',
    'failure-retry',
    'https://www.instagram.com/reel/failure-retry/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);
select is(
  public.fail_reel_extraction(
    (current_setting('test.failure_first')::jsonb ->> 'extraction_id')::uuid,
    (current_setting('test.failure_first')::jsonb ->> 'worker_reel_id')::uuid,
    (current_setting('test.failure_first')::jsonb ->> 'processing_token')::uuid,
    'IG_FETCH_FAILED'
  ),
  1,
  '실패 attempt와 연결 요청을 함께 실패 처리'
);
select is(
  (select processing_status
   from public.reels
   where id = (current_setting('test.failure_first')::jsonb ->> 'reel_id')::uuid),
  'FAILED',
  '실패 요청 히스토리는 FAILED로 고정'
);

select set_config(
  'test.failure_second',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'dd000000-0000-0000-0000-000000000013',
    'failure-retry',
    'https://www.instagram.com/reel/failure-retry/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);
select ok(
  (current_setting('test.failure_second')::jsonb ->> 'should_process')::boolean
    and current_setting('test.failure_second')::jsonb ->> 'extraction_id'
      <> current_setting('test.failure_first')::jsonb ->> 'extraction_id',
  '실패 뒤 새 요청은 과거 실패를 바꾸지 않고 새 attempt 선점'
);

select set_config(
  'test.auto_failed',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'de000000-0000-0000-0000-000000000014',
    'auto-atomic',
    'https://www.instagram.com/reel/auto-atomic/',
    'url_input',
    'AUTO_SAVE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);
select public.persist_reel_place_result(
  (current_setting('test.auto_failed')::jsonb ->> 'worker_reel_id')::uuid,
  'e3000000-0000-0000-0000-000000000003',
  0,
  null,
  (current_setting('test.auto_failed')::jsonb ->> 'processing_token')::uuid
);
select is(
  (select count(*)::integer
   from public.saved_places
   where user_id = '91000000-0000-0000-0000-000000000001'
     and place_id = 'e3000000-0000-0000-0000-000000000003'),
  0,
  '공용 AUTO_SAVE worker는 finalize 전 부분 장소를 저장하지 않음'
);
select public.fail_reel_extraction(
  (current_setting('test.auto_failed')::jsonb ->> 'extraction_id')::uuid,
  (current_setting('test.auto_failed')::jsonb ->> 'worker_reel_id')::uuid,
  (current_setting('test.auto_failed')::jsonb ->> 'processing_token')::uuid,
  'UNKNOWN'
);
select is(
  (select count(*)::integer
   from public.saved_places
   where user_id = '91000000-0000-0000-0000-000000000001'
     and place_id = 'e3000000-0000-0000-0000-000000000003'),
  0,
  'AUTO_SAVE worker가 실패하면 부분 저장이 보관함에 남지 않음'
);

select set_config(
  'test.auto_success',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'df000000-0000-0000-0000-000000000015',
    'auto-atomic',
    'https://www.instagram.com/reel/auto-atomic/',
    'url_input',
    'AUTO_SAVE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);
select public.persist_reel_place_result(
  (current_setting('test.auto_success')::jsonb ->> 'worker_reel_id')::uuid,
  'e3000000-0000-0000-0000-000000000003',
  0,
  null,
  (current_setting('test.auto_success')::jsonb ->> 'processing_token')::uuid
);
select is(
  public.finalize_reel_extraction(
    (current_setting('test.auto_success')::jsonb ->> 'extraction_id')::uuid,
    (current_setting('test.auto_success')::jsonb ->> 'worker_reel_id')::uuid,
    (current_setting('test.auto_success')::jsonb ->> 'processing_token')::uuid,
    true
  ),
  1,
  '성공한 AUTO_SAVE extraction을 한 transaction에서 확정'
);
select is(
  (select count(*)::integer
   from public.saved_places
   where user_id = '91000000-0000-0000-0000-000000000001'
     and place_id = 'e3000000-0000-0000-0000-000000000003'),
  1,
  '성공 finalize 뒤에만 AUTO_SAVE 장소가 보관함에 생성'
);

select set_config(
  'test.stale_duplicate_first',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'ee000000-0000-0000-0000-000000000017',
    'stale-duplicate',
    'https://www.instagram.com/reel/stale-duplicate/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);
select public.persist_reel_place_result(
  (current_setting('test.stale_duplicate_first')::jsonb ->> 'worker_reel_id')::uuid,
  'e1000000-0000-0000-0000-000000000001',
  0,
  null,
  (current_setting('test.stale_duplicate_first')::jsonb ->> 'processing_token')::uuid
);
update public.reels
set
  place_id = 'e1000000-0000-0000-0000-000000000001',
  instagram_title = 'stale title',
  instagram_description = 'stale description',
  instagram_author_username = 'stale.user',
  instagram_thumbnail_url = 'https://example.com/stale.jpg'
where id = (current_setting('test.stale_duplicate_first')::jsonb ->> 'worker_reel_id')::uuid;

select set_config(
  'test.stale_duplicate_retry',
  public.begin_reel_request(
    '91000000-0000-0000-0000-000000000001',
    'ee000000-0000-0000-0000-000000000017',
    'stale-duplicate',
    'https://www.instagram.com/reel/stale-duplicate/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() + interval '1 minute'
  )::text,
  true
);

select ok(
  (current_setting('test.stale_duplicate_retry')::jsonb ->> 'should_process')::boolean
    and (current_setting('test.stale_duplicate_retry')::jsonb ->> 'duplicate')::boolean
    and current_setting('test.stale_duplicate_retry')::jsonb ->> 'processing_token'
      <> current_setting('test.stale_duplicate_first')::jsonb ->> 'processing_token'
    and (
      select place_id is null
        and instagram_title is null
        and instagram_description is null
        and instagram_author_username is null
        and instagram_thumbnail_url is null
      from public.reels
      where id = (current_setting('test.stale_duplicate_retry')::jsonb ->> 'worker_reel_id')::uuid
    ),
  'stale duplicate 전송은 같은 히스토리를 새 token worker로 복구하고 stale metadata를 초기화'
);

select public.persist_reel_place_result(
  (current_setting('test.stale_duplicate_retry')::jsonb ->> 'worker_reel_id')::uuid,
  'e2000000-0000-0000-0000-000000000002',
  0,
  null,
  (current_setting('test.stale_duplicate_retry')::jsonb ->> 'processing_token')::uuid
);
select is(
  public.finalize_reel_extraction(
    (current_setting('test.stale_duplicate_retry')::jsonb ->> 'extraction_id')::uuid,
    (current_setting('test.stale_duplicate_retry')::jsonb ->> 'worker_reel_id')::uuid,
    (current_setting('test.stale_duplicate_retry')::jsonb ->> 'processing_token')::uuid,
    true
  ),
  1,
  '복구된 duplicate worker의 현재 attempt만 완료'
);
select results_eq(
  $$
    select extraction_place.place_id
    from public.reel_extraction_places as extraction_place
    where extraction_place.extraction_id =
      (current_setting('test.stale_duplicate_retry')::jsonb ->> 'extraction_id')::uuid
    order by extraction_place.position
  $$,
  $$ values ('e2000000-0000-0000-0000-000000000002'::uuid) $$,
  'stale token 장소는 보존하되 공용 extraction 결과에는 섞지 않음'
);
select is(
  (select count(*)::integer
   from public.reel_places
   where reel_id =
     (current_setting('test.stale_duplicate_retry')::jsonb ->> 'worker_reel_id')::uuid),
  2,
  'stale attempt 장소 행은 진단 증거로 삭제하지 않고 보존'
);

select set_config(
  'test.foreign_only',
  public.begin_reel_request(
    '92000000-0000-0000-0000-000000000002',
    'ed000000-0000-0000-0000-000000000016',
    'foreign-only',
    'https://www.instagram.com/reel/foreign-only/',
    'instagram_share',
    'REVIEW_QUEUE',
    9,
    now() - interval '15 minutes'
  )::text,
  true
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '91000000-0000-0000-0000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*)::integer
   from public.reel_extractions
   where id = (current_setting('test.foreign_only')::jsonb ->> 'extraction_id')::uuid),
  0,
  '사용자는 다른 사용자만 참조하는 공용 extraction을 조회할 수 없음'
);
select is(
  (select count(*)::integer
   from public.reel_queue_batches
   where user_id = '92000000-0000-0000-0000-000000000002'),
  0,
  '사용자는 다른 사용자의 queue batch를 조회할 수 없음'
);

prepare direct_new_queue_update as
  update public.reel_queue_items
  set review_status = 'DISCARDED', reviewed_at = now()
  where batch_id = (
    select id
    from public.reel_queue_batches
    where user_id = '91000000-0000-0000-0000-000000000001'
      and instagram_shortcode = 'repeat-cache'
      and resolved_at is null
  );
select throws_ok(
  'direct_new_queue_update',
  '42501',
  null,
  '사용자는 새 queue item 상태도 직접 수정할 수 없음'
);
select is(
  (select count(*)::integer
   from public.user_related_reels
   where place_id = 'e1000000-0000-0000-0000-000000000001'
     and instagram_shortcode = 'repeat-cache'),
  1,
  '관련 릴스 view는 같은 shortcode의 반복 요청을 최신 한 건으로 축약'
);

select * from finish();
rollback;
