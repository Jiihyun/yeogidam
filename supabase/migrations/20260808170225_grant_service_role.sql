-- Edge Function 은 service_role 키로 DB 에 쓴다. service_role 은 RLS 를 우회하지만
-- 테이블 레벨 GRANT 는 별도로 필요하다. (Supabase 로컬은 기본 GRANT 가 없어 명시적으로 부여)
-- 서버(신뢰된) 역할이므로 4개 테이블에 대한 DML 을 부여한다.

grant select, insert, update, delete on public.profiles     to service_role;
grant select, insert, update, delete on public.places       to service_role;
grant select, insert, update, delete on public.reels        to service_role;
grant select, insert, update, delete on public.saved_places to service_role;
