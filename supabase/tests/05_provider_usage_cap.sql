begin;
select plan(5);

select has_table(
  'public',
  'provider_usage_monthly',
  'provider_usage_monthly 테이블 존재'
);

insert into public.provider_usage_monthly (provider, month_start, request_count)
values (
  'google_places_thumbnail',
  date_trunc('month', now() at time zone 'UTC')::date,
  899
);

select ok(
  public.reserve_google_places_thumbnail(),
  '월 899건에서는 Google Places 호출 1건 예약 가능'
);

select is(
  (
    select request_count
    from public.provider_usage_monthly
    where provider = 'google_places_thumbnail'
  ),
  900,
  '예약 후 월 사용량은 900건'
);

select is(
  public.reserve_google_places_thumbnail(),
  false,
  '월 900건부터 Google Places 호출 차단'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.reserve_google_places_thumbnail()',
    'EXECUTE'
  ),
  'authenticated 사용자는 사용량 예약 함수 실행 불가'
);

select * from finish();
rollback;
