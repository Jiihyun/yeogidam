begin;
select plan(25);

select ok(
  to_regprocedure('public.reel_places(public.reels)') is not null,
  '기존 reel_places embed를 위한 계산 관계가 존재'
);
select ok(
  (select provolatile = 's' and not prosecdef
   from pg_proc
   where oid = 'public.reel_places(public.reels)'::regprocedure),
  '계산 관계는 STABLE SECURITY INVOKER로 조회만 수행'
);
select ok(
  has_function_privilege('authenticated', 'public.reel_places(public.reels)', 'EXECUTE'),
  '로그인 사용자는 기존 embed 관계를 조회 가능'
);
select ok(
  not has_function_privilege('anon', 'public.reel_places(public.reels)', 'EXECUTE'),
  '익명 사용자는 계산 관계 실행 권한이 없음'
);

insert into auth.users (id, aud, role, email)
values
  ('a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'compat-a@test.dev'),
  ('a2000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'compat-b@test.dev');

insert into public.places (id, name)
values
  ('b1000000-0000-4000-8000-000000000001', '호환 장소 1'),
  ('b2000000-0000-4000-8000-000000000002', '호환 장소 2'),
  ('b3000000-0000-4000-8000-000000000003', '인계 후 최종 장소');

-- 실제 요청 RPC로 worker, 캐시 재사용, 동시 대기, stale 인계를 구성한다.
-- 모든 fixture와 assertion은 이 테스트의 rollback 안에서만 존재한다.
do $$
declare
  v_a constant uuid := 'a1000000-0000-4000-8000-000000000001';
  v_b constant uuid := 'a2000000-0000-4000-8000-000000000002';
  v_p1 constant uuid := 'b1000000-0000-4000-8000-000000000001';
  v_p2 constant uuid := 'b2000000-0000-4000-8000-000000000002';
  v_p3 constant uuid := 'b3000000-0000-4000-8000-000000000003';
  v_worker jsonb;
  v_request jsonb;
  v_second jsonb;
  v_row public.reels;
begin
  v_worker := public.begin_reel_request(
    v_a, gen_random_uuid(), 'compat-cache',
    'https://www.instagram.com/reel/compat-cache/',
    'instagram_share', 'AUTO_SAVE', 9, now() - interval '15 minutes'
  );
  perform set_config('test.compat_worker', v_worker::text, true);
  perform public.persist_reel_place_result(
    (v_worker ->> 'worker_reel_id')::uuid, v_p1, 0, null,
    (v_worker ->> 'processing_token')::uuid
  );
  perform public.persist_reel_place_result(
    (v_worker ->> 'worker_reel_id')::uuid, v_p2, 1, null,
    (v_worker ->> 'processing_token')::uuid
  );
  perform public.finalize_reel_extraction(
    (v_worker ->> 'extraction_id')::uuid,
    (v_worker ->> 'worker_reel_id')::uuid,
    (v_worker ->> 'processing_token')::uuid, true
  );
  select * into v_row from public.reels where id = (v_worker ->> 'reel_id')::uuid;
  perform set_config('test.compat_foreign_parent', to_jsonb(v_row)::text, true);

  v_request := public.begin_reel_request(
    v_b, gen_random_uuid(), 'compat-cache',
    'https://www.instagram.com/reel/compat-cache/',
    'instagram_share', 'AUTO_SAVE', 9, now() - interval '15 minutes'
  );
  update public.reels set created_at = now() - interval '2 minutes'
  where id = (v_request ->> 'reel_id')::uuid;
  perform set_config('test.compat_cached_first', v_request::text, true);

  v_second := public.begin_reel_request(
    v_b, gen_random_uuid(), 'compat-cache',
    'https://www.instagram.com/reel/compat-cache/',
    'instagram_share', 'AUTO_SAVE', 9, now() - interval '15 minutes'
  );
  update public.reels set created_at = now() - interval '1 minute'
  where id = (v_second ->> 'reel_id')::uuid;
  perform set_config('test.compat_cached_latest', v_second::text, true);
  select * into v_row from public.reels where id = (v_second ->> 'reel_id')::uuid;
  perform set_config('test.compat_own_parent', to_jsonb(v_row)::text, true);

  -- 더 최신인 실패 기록은 이전 성공 릴스를 숨기면 안 된다.
  insert into public.reels (
    user_id, instagram_shortcode, instagram_url, processing_status,
    failure_reason, request_id, save_mode
  ) values (
    v_b, 'compat-cache', 'https://www.instagram.com/reel/compat-cache/',
    'FAILED', 'UNKNOWN', gen_random_uuid(), 'AUTO_SAVE'
  ) returning * into v_row;
  perform set_config('test.compat_failed_parent', to_jsonb(v_row)::text, true);

  v_worker := public.begin_reel_request(
    v_a, gen_random_uuid(), 'compat-inflight',
    'https://www.instagram.com/reel/compat-inflight/',
    'instagram_share', 'AUTO_SAVE', 9, now() - interval '15 minutes'
  );
  v_request := public.begin_reel_request(
    v_b, gen_random_uuid(), 'compat-inflight',
    'https://www.instagram.com/reel/compat-inflight/',
    'instagram_share', 'AUTO_SAVE', 9, now() - interval '15 minutes'
  );
  perform set_config('test.compat_inflight_worker', v_worker::text, true);
  perform set_config('test.compat_inflight_waiter', v_request::text, true);
  perform public.persist_reel_place_result(
    (v_worker ->> 'worker_reel_id')::uuid, v_p1, 0, null,
    (v_worker ->> 'processing_token')::uuid
  );
  perform public.finalize_reel_extraction(
    (v_worker ->> 'extraction_id')::uuid,
    (v_worker ->> 'worker_reel_id')::uuid,
    (v_worker ->> 'processing_token')::uuid, true
  );

  v_worker := public.begin_reel_request(
    v_a, gen_random_uuid(), 'compat-takeover',
    'https://www.instagram.com/reel/compat-takeover/',
    'instagram_share', 'AUTO_SAVE', 9, now() - interval '15 minutes'
  );
  perform set_config('test.compat_stale_worker', v_worker::text, true);
  perform public.persist_reel_place_result(
    (v_worker ->> 'worker_reel_id')::uuid, v_p2, 0, null,
    (v_worker ->> 'processing_token')::uuid
  );
  -- updated_at 트리거는 now()를 사용하므로 stale 판정 cutoff를 앞으로 둔다.
  v_request := public.begin_reel_request(
    v_b, gen_random_uuid(), 'compat-takeover',
    'https://www.instagram.com/reel/compat-takeover/',
    'instagram_share', 'AUTO_SAVE', 9, now() + interval '1 minute'
  );
  perform public.persist_reel_place_result(
    (v_request ->> 'worker_reel_id')::uuid, v_p3, 0, null,
    (v_request ->> 'processing_token')::uuid
  );
  perform public.finalize_reel_extraction(
    (v_request ->> 'extraction_id')::uuid,
    (v_request ->> 'worker_reel_id')::uuid,
    (v_request ->> 'processing_token')::uuid, true
  );

  insert into public.reels (
    id, user_id, instagram_url, instagram_shortcode, processing_status
  ) values (
    'c1000000-0000-4000-8000-000000000001', v_a,
    'https://www.instagram.com/reel/compat-legacy/', 'compat-legacy', 'COMPLETED'
  ) returning * into v_row;
  insert into public.reel_places (reel_id, place_id, position)
  values (v_row.id, v_p2, 0);
  perform set_config('test.compat_legacy_parent', to_jsonb(v_row)::text, true);
end;
$$;

-- 아래 읽기들이 worker 증거 및 단일 모델에 쓰기를 발생시키지 않는지 비교한다.
select set_config('test.compat_physical_before', (
  select coalesce(jsonb_agg(to_jsonb(rp) order by rp.id), '[]'::jsonb)::text
  from public.reel_places rp
  where rp.reel_id <> 'c1000000-0000-4000-8000-000000000001'
), true);
select set_config('test.compat_model_before', jsonb_build_object(
  'reels', (select jsonb_agg(to_jsonb(r) order by r.id) from public.reels r
            where r.id <> 'c1000000-0000-4000-8000-000000000001'),
  'saved', (select jsonb_agg(to_jsonb(s) order by s.id) from public.saved_places s),
  'extractions', (select jsonb_agg(to_jsonb(e) order by e.id) from public.reel_extractions e),
  'places', (select jsonb_agg(to_jsonb(p) order by p.id) from public.reel_extraction_places p),
  'batches', (select jsonb_agg(to_jsonb(b) order by b.id) from public.reel_queue_batches b),
  'items', (select jsonb_agg(to_jsonb(i) order by i.id) from public.reel_queue_items i)
)::text, true);

select is(
  (select count(*)::integer from public.reel_places
   where reel_id = (current_setting('test.compat_cached_latest')::jsonb ->> 'reel_id')::uuid),
  0,
  '다른 사용자 캐시 재사용에는 물리 reel_places 복제가 없음'
);
select is(
  (select count(*)::integer from public.saved_places
   where user_id = 'a2000000-0000-4000-8000-000000000002'
     and place_id in ('b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002')),
  2,
  '기존 AUTO_SAVE 보관함 저장 계약은 유지'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select results_eq(
  $$ select related.place_id from public.reels r
     cross join lateral public.reel_places(r) related
     where r.id = (current_setting('test.compat_cached_latest')::jsonb ->> 'reel_id')::uuid
     order by related.place_id $$,
  $$ values ('b1000000-0000-4000-8000-000000000001'::uuid), ('b2000000-0000-4000-8000-000000000002'::uuid) $$,
  'B는 A의 worker 관계를 볼 권한 없이도 자신의 최종 장소 둘을 조회'
);
select is(
  (select count(*)::integer from public.reels r
   cross join lateral public.reel_places(r) related
   where r.id = (current_setting('test.compat_cached_first')::jsonb ->> 'reel_id')::uuid),
  0,
  '같은 사용자의 재공유 전 요청은 중복 관련 릴스로 반환하지 않음'
);
select is(
  (select count(distinct r.id)::integer from public.reels r
   cross join lateral public.reel_places(r) related
   where r.instagram_shortcode = 'compat-cache' and r.processing_status = 'COMPLETED'),
  1,
  '더 최신인 실패 기록이 있어도 최신 성공 요청 한 건만 반환'
);
select is(
  (select count(*)::integer from public.reel_places(
    jsonb_populate_record(null::public.reels, current_setting('test.compat_failed_parent')::jsonb)
  )),
  0,
  '실패한 요청의 가상 관계는 비어 있음'
);
select is(
  (select count(*)::integer from public.reels r
   cross join lateral public.reel_places(r) related
   where r.instagram_shortcode = 'compat-cache'
     and r.processing_status = 'COMPLETED'
     and related.place_id = 'b1000000-0000-4000-8000-000000000001'),
  1,
  '기존 place_id 필터와 inner 관계는 요청 한 건에 일치'
);
select is(
  (select count(*)::integer from public.reels r
   cross join lateral public.reel_places(r) related
   where r.instagram_shortcode = 'compat-cache'
     and related.place_id = 'b3000000-0000-4000-8000-000000000003'),
  0,
  '다른 장소 필터에 일치하지 않는 부모는 inner 결과에서 제외'
);
select ok(
  current_setting('test.compat_inflight_waiter')::jsonb ->> 'extraction_id'
    = current_setting('test.compat_inflight_worker')::jsonb ->> 'extraction_id'
  and not (current_setting('test.compat_inflight_waiter')::jsonb ->> 'should_process')::boolean,
  '동시 요청 fixture는 같은 extraction을 기다리는 별도 사용자 요청'
);
select results_eq(
  $$ select related.place_id from public.reels r
     cross join lateral public.reel_places(r) related
     where r.id = (current_setting('test.compat_inflight_waiter')::jsonb ->> 'reel_id')::uuid $$,
  $$ values ('b1000000-0000-4000-8000-000000000001'::uuid) $$,
  '다른 사용자의 처리 중 요청을 기다린 B도 완료 후 관계 조회 가능'
);
select is(
  (select count(*)::integer from public.reel_places(jsonb_populate_record(
    null::public.reels,
    current_setting('test.compat_foreign_parent')::jsonb
      || '{"user_id":"a2000000-0000-4000-8000-000000000002"}'::jsonb
  ))),
  0,
  '다른 사용자 행의 composite user_id를 위조해도 실제 소유권 검증으로 차단'
);
select is(
  (select count(*)::integer from public.reel_places(jsonb_populate_record(
    null::public.reels,
    current_setting('test.compat_own_parent')::jsonb
      || '{"extraction_id":null,"instagram_shortcode":"forged","processing_status":"FAILED"}'::jsonb
  ))),
  2,
  '자신의 composite에 조작된 필드를 넣어도 실제 부모와 공용 결과만 사용'
);

select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select results_eq(
  $$ select related.place_id from public.reels r
     cross join lateral public.reel_places(r) related
     where r.id = (current_setting('test.compat_stale_worker')::jsonb ->> 'reel_id')::uuid $$,
  $$ values ('b3000000-0000-4000-8000-000000000003'::uuid) $$,
  '인계된 이전 worker 요청도 stale 중간 장소가 아니라 최종 추출 장소를 반환'
);
select is(
  (select count(*)::integer from public.reel_places
   where reel_id = (current_setting('test.compat_stale_worker')::jsonb ->> 'reel_id')::uuid
     and place_id = 'b2000000-0000-4000-8000-000000000002'),
  1,
  'stale worker의 중간 장소 증거는 물리 테이블에 그대로 보존'
);
select is(
  (select count(*)::integer from public.reels r
   cross join lateral public.reel_places(r) related
   where r.id = (current_setting('test.compat_worker')::jsonb ->> 'reel_id')::uuid),
  2,
  '최초 worker 본인의 기존 관련 릴스 조회도 유지'
);
select results_eq(
  $$ select related.place_id from public.reels r
     cross join lateral public.reel_places(r) related
     where r.id = 'c1000000-0000-4000-8000-000000000001' $$,
  $$ values ('b2000000-0000-4000-8000-000000000002'::uuid) $$,
  'extraction_id 없는 과거 자료는 기존 물리 관계에서 조회'
);

reset role;
delete from public.reels where id = 'c1000000-0000-4000-8000-000000000001';
set local role authenticated;
select is(
  (select count(*)::integer from public.reel_places(
    jsonb_populate_record(null::public.reels, current_setting('test.compat_legacy_parent')::jsonb)
  )),
  0,
  '삭제된 부모의 이전 composite를 재전송해도 결과를 노출하지 않음'
);

set local role anon;
select throws_ok(
  $$ select * from public.reel_places(null::public.reels) $$,
  '42501',
  'permission denied for function reel_places',
  '익명 실행은 빈 결과가 아닌 권한 오류로 거부'
);
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select is(
  (select count(*)::integer from public.reel_places(
    jsonb_populate_record(null::public.reels, current_setting('test.compat_own_parent')::jsonb)
  )),
  0,
  '유효한 사용자 ID 없는 세션에는 실제 부모를 노출하지 않음'
);

reset role;
select is(
  (select coalesce(jsonb_agg(to_jsonb(rp) order by rp.id), '[]'::jsonb)
   from public.reel_places rp
   where rp.reel_id <> 'c1000000-0000-4000-8000-000000000001'),
  current_setting('test.compat_physical_before')::jsonb,
  '조회 전후 물리 worker 행과 token 및 순서가 모두 동일'
);
select is(
  jsonb_build_object(
    'reels', (select jsonb_agg(to_jsonb(r) order by r.id) from public.reels r
              where r.id <> 'c1000000-0000-4000-8000-000000000001'),
    'saved', (select jsonb_agg(to_jsonb(s) order by s.id) from public.saved_places s),
    'extractions', (select jsonb_agg(to_jsonb(e) order by e.id) from public.reel_extractions e),
    'places', (select jsonb_agg(to_jsonb(p) order by p.id) from public.reel_extraction_places p),
    'batches', (select jsonb_agg(to_jsonb(b) order by b.id) from public.reel_queue_batches b),
    'items', (select jsonb_agg(to_jsonb(i) order by i.id) from public.reel_queue_items i)
  ),
  current_setting('test.compat_model_before')::jsonb,
  '조회 어댑터는 요청·추출·보관함·대기함 모델을 수정하거나 복제하지 않음'
);

select * from finish();
rollback;
