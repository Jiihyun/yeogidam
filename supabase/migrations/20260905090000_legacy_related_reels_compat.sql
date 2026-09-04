-- fe-release/1.0.1은 reels?select=...,reel_places!inner(place_id)로
-- 장소 상세의 관련 릴스를 읽는다. 공용 추출을 재사용한 요청에는 물리적인
-- reel_places가 없으므로 PostgREST computed relationship으로 기존 조회를
-- user_related_reels에 연결한다. worker 기록이나 대기함 데이터는 수정하지 않는다.
--
-- 함수 이름이 기존 관계명(reel_places)과 같아 자동 감지된 FK 관계를 덮어쓴다.
-- 반환형은 실제 요청 ID와 장소 ID를 가진 view이며, worker/queue ID를 합성하지 않는다.
create function public.reel_places(public.reels)
returns setof public.user_related_reels
language sql
stable
security invoker
as $$
  select related.*
  from public.reels as owned_reel
  join public.user_related_reels as related
    on related.id = owned_reel.id
  where owned_reel.id = ($1).id
    and owned_reel.user_id = (select auth.uid());
$$;

-- 인자의 user_id/extraction_id는 신뢰하지 않는다. 실제 부모 행을 다시 읽고
-- 소유자를 확인해야 RPC로 조작한 composite 인자를 보내도 다른 사용자의
-- 요청을 조회할 수 없다. 반환형 자체가 RLS를 적용하는 것은 아니므로 원본
-- 테이블과 security_invoker view를 호출자의 권한으로 조회한다.
-- 모든 참조를 schema-qualified로 쓰고 SET search_path를 두지 않아 SQL 함수의
-- inlining을 허용한다. SETOF의 기본 ROWS 1000은 이 관계가 to-many임을 나타낸다.
revoke all on function public.reel_places(public.reels) from public;
revoke all on function public.reel_places(public.reels) from anon;
grant execute on function public.reel_places(public.reels) to authenticated;
grant execute on function public.reel_places(public.reels) to service_role;

comment on function public.reel_places(public.reels) is
  '구버전 reels → reel_places embedding을 공용 결과/legacy fallback/최신 요청 dedupe 조회에 연결하는 읽기 전용 호환 관계';

-- 기존 FK 관계 대신 새 computed relationship을 발견하게 한다.
notify pgrst, 'reload schema';
