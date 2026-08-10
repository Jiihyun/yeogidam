-- Google Places 사진은 월 무료 1,000건보다 낮은 900건에서 차단한다.
-- Edge Function의 동시 요청도 한도를 넘지 않도록 DB에서 원자적으로 예약한다.

create table public.provider_usage_monthly (
  provider      text not null,
  month_start   date not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at    timestamptz not null default now(),
  primary key (provider, month_start)
);

alter table public.provider_usage_monthly enable row level security;

create function public.reserve_google_places_thumbnail()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  reserved_count integer;
begin
  insert into public.provider_usage_monthly (
    provider,
    month_start,
    request_count
  )
  values (
    'google_places_thumbnail',
    date_trunc('month', now() at time zone 'UTC')::date,
    1
  )
  on conflict (provider, month_start) do update
    set request_count = public.provider_usage_monthly.request_count + 1,
        updated_at = now()
    where public.provider_usage_monthly.request_count < 900
  returning request_count into reserved_count;

  return reserved_count is not null;
end;
$$;

revoke all on public.provider_usage_monthly from anon, authenticated;
revoke execute on function public.reserve_google_places_thumbnail() from public, anon, authenticated;
grant execute on function public.reserve_google_places_thumbnail() to service_role;
