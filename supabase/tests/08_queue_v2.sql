begin;
select plan(52);

select has_column('public', 'reels', 'save_mode', 'reels.save_mode 존재');
select has_column('public', 'reels', 'processing_token', '재시도 실행 식별자 존재');
select has_column('public', 'reel_places', 'id', '대기함 행 id 존재');
select has_column('public', 'reel_places', 'review_status', '검토 상태 존재');
select has_table('public', 'reel_reports', '실패 신고 테이블 존재');

insert into auth.users (id, aud, role, email)
values
  ('81000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'queue-a@test.dev'),
  ('82000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'queue-b@test.dev');

insert into public.places (id, name, thumbnail_url)
values
  ('a1000000-0000-0000-0000-000000000001', 'v1 자동 저장 장소', 'https://example.com/a1.jpg'),
  ('a2000000-0000-0000-0000-000000000002', 'v2 대기 장소', null),
  ('a3000000-0000-0000-0000-000000000003', '제외 확정 장소', null),
  ('a4000000-0000-0000-0000-000000000004', '저장 확정 장소', null),
  ('a5000000-0000-0000-0000-000000000005', '처리 중 장소', null),
  ('a6000000-0000-0000-0000-000000000006', '선택 저장 장소', null),
  ('a7000000-0000-0000-0000-000000000007', '선택 제외 장소', null),
  ('a8000000-0000-0000-0000-000000000008', '다른 사용자 장소', null),
  ('a9000000-0000-0000-0000-000000000009', '자동 재처리 장소 1', null),
  ('aa000000-0000-0000-0000-000000000010', '자동 재처리 장소 2', null),
  ('ab000000-0000-0000-0000-000000000011', '검토 재처리 대기 장소', null),
  ('ac000000-0000-0000-0000-000000000012', '검토 재처리 저장 장소', null),
  ('ad000000-0000-0000-0000-000000000013', '검토 재처리 제외 장소', null);

insert into public.reels (
  id, user_id, instagram_url, processing_status, save_mode
)
values
  ('b1000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001', 'https://www.instagram.com/reel/auto/', 'COMPLETED', 'AUTO_SAVE'),
  ('b2000000-0000-0000-0000-000000000002', '81000000-0000-0000-0000-000000000001', 'https://www.instagram.com/reel/queue-promote/', 'COMPLETED', 'REVIEW_QUEUE'),
  ('b3000000-0000-0000-0000-000000000003', '81000000-0000-0000-0000-000000000001', 'https://www.instagram.com/reel/queue-resolve/', 'COMPLETED', 'REVIEW_QUEUE'),
  ('b4000000-0000-0000-0000-000000000004', '81000000-0000-0000-0000-000000000001', 'https://www.instagram.com/reel/queue-processing/', 'PROCESSING', 'REVIEW_QUEUE'),
  ('b5000000-0000-0000-0000-000000000005', '81000000-0000-0000-0000-000000000001', 'https://www.instagram.com/reel/queue-failed/', 'FAILED', 'REVIEW_QUEUE'),
  ('b6000000-0000-0000-0000-000000000006', '82000000-0000-0000-0000-000000000002', 'https://www.instagram.com/reel/queue-foreign/', 'COMPLETED', 'REVIEW_QUEUE'),
  ('b7000000-0000-0000-0000-000000000007', '81000000-0000-0000-0000-000000000001', 'https://www.instagram.com/reel/atomic-claim/', 'FAILED', 'REVIEW_QUEUE'),
  ('b8000000-0000-0000-0000-000000000008', '81000000-0000-0000-0000-000000000001', 'https://www.instagram.com/reel/auto-reset/', 'PROCESSING', 'AUTO_SAVE'),
  ('b9000000-0000-0000-0000-000000000009', '81000000-0000-0000-0000-000000000001', 'https://www.instagram.com/reel/queue-reset/', 'PROCESSING', 'REVIEW_QUEUE');

select public.persist_reel_place_result(
  'b1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  0,
  'https://example.com/a1.jpg'
);

select is(
  (select save_mode from public.reels where id = 'b1000000-0000-0000-0000-000000000001'),
  'AUTO_SAVE',
  'v1 기본 mode는 AUTO_SAVE'
);
select ok(
  (select review_status = 'SAVED' and reviewed_at is not null
   from public.reel_places
   where reel_id = 'b1000000-0000-0000-0000-000000000001'),
  'AUTO_SAVE 결과는 SAVED와 확정 시각을 함께 기록'
);
select is(
  (select count(*)::integer from public.saved_places
   where user_id = '81000000-0000-0000-0000-000000000001'
     and place_id = 'a1000000-0000-0000-0000-000000000001'),
  1,
  'v1 결과는 즉시 보관함에 저장'
);

select public.persist_reel_place_result(
  'b2000000-0000-0000-0000-000000000002',
  'a2000000-0000-0000-0000-000000000002',
  0,
  null
);
select ok(
  (select review_status = 'PENDING' and reviewed_at is null
   from public.reel_places
   where reel_id = 'b2000000-0000-0000-0000-000000000002'
     and place_id = 'a2000000-0000-0000-0000-000000000002'),
  'v2 결과는 PENDING/null로 기록'
);
select is(
  (select count(*)::integer from public.saved_places
   where place_id = 'a2000000-0000-0000-0000-000000000002'),
  0,
  'v2 PENDING 결과는 보관함에 넣지 않음'
);

insert into public.reel_places (
  reel_id, place_id, position, review_status, reviewed_at
)
values
  ('b2000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000003', 1, 'DISCARDED', now()),
  ('b2000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000004', 2, 'SAVED', now());

select public.persist_reel_place_result(
  'b2000000-0000-0000-0000-000000000002',
  'a3000000-0000-0000-0000-000000000003',
  5,
  null
);
select public.persist_reel_place_result(
  'b2000000-0000-0000-0000-000000000002',
  'a4000000-0000-0000-0000-000000000004',
  6,
  null
);

select is(
  (select review_status from public.reel_places
   where reel_id = 'b2000000-0000-0000-0000-000000000002'
     and place_id = 'a3000000-0000-0000-0000-000000000003'),
  'DISCARDED',
  '재처리는 DISCARDED 관계를 PENDING으로 열지 않음'
);
select is(
  (select position from public.reel_places
   where reel_id = 'b2000000-0000-0000-0000-000000000002'
     and place_id = 'a3000000-0000-0000-0000-000000000003'),
  1,
  '재처리는 확정 관계의 기존 순서를 보존'
);
select is(
  (select review_status from public.reel_places
   where reel_id = 'b2000000-0000-0000-0000-000000000002'
     and place_id = 'a4000000-0000-0000-0000-000000000004'),
  'SAVED',
  '재처리는 SAVED 관계를 PENDING으로 열지 않음'
);

prepare downgrade_auto_save as
  update public.reels
  set save_mode = 'REVIEW_QUEUE'
  where id = 'b1000000-0000-0000-0000-000000000001';
select throws_ok(
  'downgrade_auto_save',
  '23514',
  'reel_save_mode_downgrade_not_allowed',
  'AUTO_SAVE mode downgrade 금지'
);

select is(
  public.claim_reel_request(
    'b2000000-0000-0000-0000-000000000002',
    '81000000-0000-0000-0000-000000000001',
    'REVIEW_QUEUE',
    1,
    now() - interval '15 minutes',
    'https://www.instagram.com/reel/queue-promote/',
    'instagram_share'
  ) ->> 'save_mode',
  'REVIEW_QUEUE',
  'v2 재요청은 REVIEW_QUEUE를 유지'
);
select is(
  public.claim_reel_request(
    'b2000000-0000-0000-0000-000000000002',
    '81000000-0000-0000-0000-000000000001',
    'AUTO_SAVE',
    1,
    now() - interval '15 minutes',
    'https://www.instagram.com/reel/queue-promote/',
    'instagram_share'
  ) ->> 'save_mode',
  'AUTO_SAVE',
  'v1 요청은 REVIEW_QUEUE보다 우선'
);
select is(
  (select count(*)::integer from public.reel_places
   where reel_id = 'b2000000-0000-0000-0000-000000000002'
     and review_status = 'SAVED'),
  3,
  '완료된 reel을 AUTO_SAVE로 승격하면 모든 관계를 SAVED로 동기화'
);
select is(
  (select count(*)::integer from public.saved_places
   where user_id = '81000000-0000-0000-0000-000000000001'
     and place_id in (
       'a2000000-0000-0000-0000-000000000002',
       'a3000000-0000-0000-0000-000000000003',
       'a4000000-0000-0000-0000-000000000004'
     )),
  3,
  'AUTO_SAVE 승격이 보관함도 원자적으로 보강'
);
select is(
  public.claim_reel_request(
    'b2000000-0000-0000-0000-000000000002',
    '81000000-0000-0000-0000-000000000001',
    'REVIEW_QUEUE',
    1,
    now() - interval '15 minutes',
    'https://www.instagram.com/reel/queue-promote/',
    'instagram_share'
  ) ->> 'save_mode',
  'AUTO_SAVE',
  'v1 승격 뒤의 v2 요청은 AUTO_SAVE를 내리지 못함'
);

select set_config(
  'test.original_claim_token',
  (select processing_token::text
   from public.reels
   where id = 'b7000000-0000-0000-0000-000000000007'),
  true
);
select set_config(
  'test.first_claim',
  public.claim_reel_request(
    'b7000000-0000-0000-0000-000000000007',
    '81000000-0000-0000-0000-000000000001',
    'AUTO_SAVE',
    2,
    now() - interval '15 minutes',
    'https://www.instagram.com/reel/atomic-claim/',
    'url_input'
  )::text,
  true
);
select ok(
  (current_setting('test.first_claim')::jsonb ->> 'should_process')::boolean
    and current_setting('test.first_claim')::jsonb ->> 'processing_status' = 'PROCESSING'
    and current_setting('test.first_claim')::jsonb ->> 'save_mode' = 'AUTO_SAVE'
    and (current_setting('test.first_claim')::jsonb ->> 'processing_version')::integer = 2,
  'FAILED/old REVIEW_QUEUE를 AUTO_SAVE로 요청하면 원자적으로 처리를 선점'
);
select isnt(
  current_setting('test.first_claim')::jsonb ->> 'processing_token',
  current_setting('test.original_claim_token'),
  '재처리를 선점한 실행은 processing token을 교체'
);
select set_config(
  'test.second_claim',
  public.claim_reel_request(
    'b7000000-0000-0000-0000-000000000007',
    '81000000-0000-0000-0000-000000000001',
    'AUTO_SAVE',
    2,
    now() - interval '15 minutes',
    'https://www.instagram.com/reel/atomic-claim/',
    'url_input'
  )::text,
  true
);
select is(
  (current_setting('test.second_claim')::jsonb ->> 'should_process')::boolean,
  false,
  '즉시 뒤이은 동일 요청은 처리를 두 번 선점하지 못함'
);
select is(
  current_setting('test.second_claim')::jsonb ->> 'processing_token',
  current_setting('test.first_claim')::jsonb ->> 'processing_token',
  '선점하지 못한 두 번째 요청은 processing token을 유지'
);

select public.persist_reel_place_result(
  'b8000000-0000-0000-0000-000000000008',
  'a9000000-0000-0000-0000-000000000009',
  0,
  null,
  (select processing_token from public.reels
   where id = 'b8000000-0000-0000-0000-000000000008')
);
select public.persist_reel_place_result(
  'b8000000-0000-0000-0000-000000000008',
  'aa000000-0000-0000-0000-000000000010',
  1,
  null,
  (select processing_token from public.reels
   where id = 'b8000000-0000-0000-0000-000000000008')
);
select is(
  public.reset_pending_reel_results(
    'b8000000-0000-0000-0000-000000000008',
    (select processing_token from public.reels
     where id = 'b8000000-0000-0000-0000-000000000008')
  ),
  2,
  'AUTO_SAVE 재처리는 이전 SAVED 관계를 모두 삭제'
);
select is(
  (select count(*)::integer from public.reel_places
   where reel_id = 'b8000000-0000-0000-0000-000000000008'),
  0,
  'AUTO_SAVE reset 뒤에 이전 장소 관계가 남지 않음'
);

select public.persist_reel_place_result(
  'b9000000-0000-0000-0000-000000000009',
  'ab000000-0000-0000-0000-000000000011',
  0,
  null,
  (select processing_token from public.reels
   where id = 'b9000000-0000-0000-0000-000000000009')
);
insert into public.reel_places (
  reel_id, place_id, position, review_status, reviewed_at
)
values
  ('b9000000-0000-0000-0000-000000000009', 'ac000000-0000-0000-0000-000000000012', 1, 'SAVED', now()),
  ('b9000000-0000-0000-0000-000000000009', 'ad000000-0000-0000-0000-000000000013', 2, 'DISCARDED', now());
select is(
  public.reset_pending_reel_results(
    'b9000000-0000-0000-0000-000000000009',
    (select processing_token from public.reels
     where id = 'b9000000-0000-0000-0000-000000000009')
  ),
  1,
  'REVIEW_QUEUE 재처리는 PENDING 관계만 삭제'
);
select results_eq(
  $$
    select review_status
    from public.reel_places
    where reel_id = 'b9000000-0000-0000-0000-000000000009'
    order by review_status
  $$,
  $$ values ('DISCARDED'::text), ('SAVED'::text) $$,
  'REVIEW_QUEUE reset은 SAVED/DISCARDED 관계를 보존'
);

select public.persist_reel_place_result(
  'b4000000-0000-0000-0000-000000000004',
  'a5000000-0000-0000-0000-000000000005',
  0,
  null
);
select set_config(
  'test.stale_processing_token',
  (select processing_token::text
   from public.reels
   where id = 'b4000000-0000-0000-0000-000000000004'),
  true
);
update public.reels
set processing_token = gen_random_uuid()
where id = 'b4000000-0000-0000-0000-000000000004';

prepare stale_diagnostic_write as
  insert into public.reel_place_match_failures (
    reel_id,
    guess_index,
    place_name,
    failure_stage,
    failure_reason,
    search_origin,
    processing_token
  )
  values (
    'b4000000-0000-0000-0000-000000000004',
    0,
    '이전 실행 진단 장소',
    'KAKAO_SEARCH',
    'NO_KAKAO_CANDIDATE',
    'INITIAL',
    current_setting('test.stale_processing_token')::uuid
  );
select throws_ok(
  'stale_diagnostic_write',
  'P0001',
  'stale_reel_processing_attempt',
  '이전 processing token의 진단 행 추가를 거부'
);

prepare stale_result_write as
  select public.persist_reel_place_result(
    'b4000000-0000-0000-0000-000000000004',
    'a6000000-0000-0000-0000-000000000006',
    1,
    null,
    current_setting('test.stale_processing_token')::uuid
  );
select throws_ok(
  'stale_result_write',
  'P0001',
  'stale_reel_processing_attempt',
  '이전 worker는 새 실행 결과를 추가할 수 없음'
);
select is(
  (select count(*)::integer from public.reel_places
   where reel_id = 'b4000000-0000-0000-0000-000000000004'),
  1,
  '이전 worker의 결과 쓰기가 관계를 바꾸지 않음'
);

prepare stale_result_cleanup as
  select public.reset_pending_reel_results(
    'b4000000-0000-0000-0000-000000000004',
    current_setting('test.stale_processing_token')::uuid
  );
select throws_ok(
  'stale_result_cleanup',
  'P0001',
  'stale_reel_processing_attempt',
  '이전 worker는 새 실행의 PENDING을 지울 수 없음'
);
select is(
  public.reset_pending_reel_results(
    'b4000000-0000-0000-0000-000000000004',
    (select processing_token from public.reels
     where id = 'b4000000-0000-0000-0000-000000000004')
  ),
  1,
  '현재 실행만 이전 PENDING 결과를 정리'
);
select public.persist_reel_place_result(
  'b4000000-0000-0000-0000-000000000004',
  'a5000000-0000-0000-0000-000000000005',
  0,
  null,
  (select processing_token from public.reels
   where id = 'b4000000-0000-0000-0000-000000000004')
);
select is(
  (select review_status from public.reel_places
   where reel_id = 'b4000000-0000-0000-0000-000000000004'),
  'PENDING',
  '처리 중 v2 결과는 우선 PENDING'
);
select set_config(
  'test.processing_queue_token',
  (select processing_token::text
   from public.reels
   where id = 'b4000000-0000-0000-0000-000000000004'),
  true
);
select set_config(
  'test.processing_auto_claim',
  public.claim_reel_request(
    'b4000000-0000-0000-0000-000000000004',
    '81000000-0000-0000-0000-000000000001',
    'AUTO_SAVE',
    1,
    now() - interval '15 minutes',
    'https://www.instagram.com/reel/queue-processing/',
    'instagram_share'
  )::text,
  true
);
select ok(
  (current_setting('test.processing_auto_claim')::jsonb ->> 'should_process')::boolean
    and current_setting('test.processing_auto_claim')::jsonb ->> 'save_mode' = 'AUTO_SAVE'
    and current_setting('test.processing_auto_claim')::jsonb ->> 'processing_token'
      <> current_setting('test.processing_queue_token'),
  '처리 중 v1 승격은 기존 queue worker를 폐기하고 AUTO_SAVE를 새로 선점'
);
select is(
  (select count(*)::integer
   from public.reel_places
   where reel_id = 'b4000000-0000-0000-0000-000000000004'),
  0,
  'AUTO_SAVE 실행 선점 transaction이 이전 queue 부분 결과도 함께 제거'
);
select public.persist_reel_place_result(
  'b4000000-0000-0000-0000-000000000004',
  'a5000000-0000-0000-0000-000000000005',
  0,
  null,
  (current_setting('test.processing_auto_claim')::jsonb ->> 'processing_token')::uuid
);
update public.reels
set processing_status = 'COMPLETED'
where id = 'b4000000-0000-0000-0000-000000000004'
  and processing_token =
    (current_setting('test.processing_auto_claim')::jsonb ->> 'processing_token')::uuid;
select is(
  (select review_status from public.reel_places
   where reel_id = 'b4000000-0000-0000-0000-000000000004'),
  'SAVED',
  '승격 뒤 새 AUTO_SAVE worker의 결과는 SAVED'
);
select is(
  (select count(*)::integer from public.saved_places
   where place_id = 'a5000000-0000-0000-0000-000000000005'),
  1,
  '승격 뒤 새 AUTO_SAVE worker의 결과는 보관함에 저장'
);

select public.persist_reel_place_result(
  'b3000000-0000-0000-0000-000000000003',
  'a6000000-0000-0000-0000-000000000006',
  0,
  null
);
select public.persist_reel_place_result(
  'b3000000-0000-0000-0000-000000000003',
  'a7000000-0000-0000-0000-000000000007',
  1,
  null
);
select public.persist_reel_place_result(
  'b6000000-0000-0000-0000-000000000006',
  'a8000000-0000-0000-0000-000000000008',
  0,
  null
);
select public.persist_reel_place_result(
  'b5000000-0000-0000-0000-000000000005',
  'a8000000-0000-0000-0000-000000000008',
  0,
  null
);

select set_config(
  'test.foreign_queue_item_id',
  (select id::text
   from public.reel_places
   where reel_id = 'b6000000-0000-0000-0000-000000000006'),
  true
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '81000000-0000-0000-0000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

prepare direct_queue_update as
  update public.reel_places
  set review_status = 'SAVED', reviewed_at = now()
  where reel_id = 'b3000000-0000-0000-0000-000000000003';
select throws_ok(
  'direct_queue_update',
  '42501',
  null,
  '사용자는 상태를 직접 수정할 수 없음'
);

select is(
  public.resolve_queue_items(
    array[(select id from public.reel_places
           where reel_id = 'b3000000-0000-0000-0000-000000000003'
             and place_id = 'a6000000-0000-0000-0000-000000000006')],
    'SAVE'
  ),
  1,
  'v2 대기 장소 저장'
);
select is(
  (select review_status from public.reel_places
   where reel_id = 'b3000000-0000-0000-0000-000000000003'
     and place_id = 'a6000000-0000-0000-0000-000000000006'),
  'SAVED',
  '저장한 대기 관계는 SAVED'
);
select is(
  (select count(*)::integer from public.saved_places
   where place_id = 'a6000000-0000-0000-0000-000000000006'),
  1,
  'SAVE action은 보관함에 추가'
);
select is(
  public.resolve_queue_items(
    array[(select id from public.reel_places
           where reel_id = 'b3000000-0000-0000-0000-000000000003'
             and place_id = 'a7000000-0000-0000-0000-000000000007')],
    'DISCARD'
  ),
  1,
  'v2 대기 장소 제외'
);
select is(
  (select review_status from public.reel_places
   where reel_id = 'b3000000-0000-0000-0000-000000000003'
     and place_id = 'a7000000-0000-0000-0000-000000000007'),
  'DISCARDED',
  '제외한 관계는 DISCARDED'
);
select is(
  (select count(*)::integer from public.saved_places
   where place_id = 'a7000000-0000-0000-0000-000000000007'),
  0,
  'DISCARD action은 보관함을 만들지 않음'
);

prepare foreign_queue_resolution as
  select public.resolve_queue_items(
    array[current_setting('test.foreign_queue_item_id')::uuid],
    'SAVE'
  );
select throws_ok(
  'foreign_queue_resolution',
  'P0001',
  'queue_items_not_available',
  '다른 사용자 대기 장소를 처리할 수 없음'
);
select is(
  (select review_status from public.reel_places
   where reel_id = 'b6000000-0000-0000-0000-000000000006'),
  null,
  'RLS로 다른 사용자의 관계를 볼 수 없음'
);

prepare failed_queue_resolution as
  select public.resolve_queue_items(
    array[(select id from public.reel_places
           where reel_id = 'b5000000-0000-0000-0000-000000000005')],
    'SAVE'
  );
select throws_ok(
  'failed_queue_resolution',
  'P0001',
  'queue_items_not_available',
  'FAILED reel의 부분 관계를 처리할 수 없음'
);

prepare own_report as
  insert into public.reel_reports (reel_id)
  values ('b5000000-0000-0000-0000-000000000005');
select lives_ok('own_report', '본인의 FAILED reel 신고 가능');

prepare foreign_report as
  insert into public.reel_reports (reel_id)
  values ('b6000000-0000-0000-0000-000000000006');
select throws_ok(
  'foreign_report',
  '42501',
  null,
  '다른 사용자의 reel 신고 불가'
);

prepare completed_report as
  insert into public.reel_reports (reel_id)
  values ('b3000000-0000-0000-0000-000000000003');
select throws_ok(
  'completed_report',
  '42501',
  null,
  'COMPLETED reel은 실패 신고 대상이 아님'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '82000000-0000-0000-0000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);
select is(
  (select count(*)::integer from public.reel_reports),
  0,
  '다른 사용자는 신고 기록을 볼 수 없음'
);

prepare duplicate_queue_selection as
  select public.resolve_queue_items(
    array[
      'c0000000-0000-0000-0000-000000000001'::uuid,
      'c0000000-0000-0000-0000-000000000001'::uuid
    ],
    'DISCARD'
  );
select throws_ok(
  'duplicate_queue_selection',
  '22023',
  'queue_selection_contains_duplicates_or_nulls',
  '중복 queue id 거부'
);

select * from finish();
rollback;
