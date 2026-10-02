create table public.reel_extraction_place_jobs (
  id uuid primary key default gen_random_uuid(),
  extraction_id uuid not null references public.reel_extractions(id) on delete cascade,
  position integer not null check (position >= 0),
  matched_place jsonb not null check (jsonb_typeof(matched_place) = 'object'),
  place_id uuid references public.places(id),
  thumbnail_source_url text,
  instagram_description text not null,
  instagram_author_username text,
  instagram_thumbnail_url text,
  has_match_failures boolean not null default false,
  match_failures jsonb not null default '[]'::jsonb
    check (jsonb_typeof(match_failures) = 'array'),
  processing_status text not null default 'PENDING'
    check (processing_status in ('PENDING', 'PROCESSING', 'COMPLETED')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_processing_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (extraction_id, position)
);

create index idx_reel_extraction_place_jobs_claim
  on public.reel_extraction_place_jobs (
    extraction_id,
    processing_status,
    position
  );

alter table public.reel_extraction_place_jobs enable row level security;
revoke all on public.reel_extraction_place_jobs from public, anon, authenticated;
grant select, insert, update, delete
  on public.reel_extraction_place_jobs to service_role;

create function public.enqueue_reel_extraction_place_jobs(
  p_extraction_id uuid,
  p_worker_reel_id uuid,
  p_processing_token uuid,
  p_instagram_description text,
  p_instagram_author_username text,
  p_instagram_thumbnail_url text,
  p_has_match_failures boolean,
  p_match_failures jsonb,
  p_jobs jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_extraction public.reel_extractions%rowtype;
  v_inserted_count integer;
begin
  if p_extraction_id is null
     or p_worker_reel_id is null
     or p_processing_token is null
     or p_instagram_description is null
     or p_has_match_failures is null
     or jsonb_typeof(p_match_failures) is distinct from 'array'
     or jsonb_typeof(p_jobs) is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'invalid_reel_extraction_place_jobs';
  end if;

  if jsonb_array_length(p_jobs) = 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_reel_extraction_place_jobs';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_jobs) as input(job)
    where jsonb_typeof(input.job) is distinct from 'object'
       or input.job ->> 'position' is null
       or (input.job ->> 'position') !~ '^[0-9]+$'
       or jsonb_typeof(input.job -> 'matched_place') is distinct from 'object'
  ) then
    raise exception using
      errcode = '22023',
      message = 'invalid_reel_extraction_place_job';
  end if;

  select extraction.*
  into v_extraction
  from public.reel_extractions as extraction
  where extraction.id = p_extraction_id
  for update;

  if not found
     or v_extraction.processing_status <> 'PROCESSING'
     or v_extraction.worker_reel_id is distinct from p_worker_reel_id
     or v_extraction.processing_token is distinct from p_processing_token then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  insert into public.reel_extraction_place_jobs (
    extraction_id,
    position,
    matched_place,
    thumbnail_source_url,
    instagram_description,
    instagram_author_username,
    instagram_thumbnail_url,
    has_match_failures,
    match_failures
  )
  select
    p_extraction_id,
    (input.job ->> 'position')::integer,
    input.job -> 'matched_place',
    nullif(input.job ->> 'thumbnail_source_url', ''),
    p_instagram_description,
    p_instagram_author_username,
    p_instagram_thumbnail_url,
    p_has_match_failures,
    p_match_failures
  from jsonb_array_elements(p_jobs) as input(job)
  on conflict (extraction_id, position) do nothing;

  get diagnostics v_inserted_count = row_count;

  update public.reel_extractions
  set updated_at = now()
  where id = p_extraction_id;

  return v_inserted_count;
end;
$$;

revoke all on function public.enqueue_reel_extraction_place_jobs(
  uuid, uuid, uuid, text, text, text, boolean, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.enqueue_reel_extraction_place_jobs(
  uuid, uuid, uuid, text, text, text, boolean, jsonb, jsonb
) to service_role;

create function public.claim_reel_extraction_place_batch(
  p_extraction_id uuid,
  p_worker_reel_id uuid,
  p_processing_token uuid,
  p_limit integer default 5,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_extraction public.reel_extractions%rowtype;
  v_jobs jsonb;
  v_has_unfinished boolean;
begin
  if p_extraction_id is null
     or p_worker_reel_id is null
     or p_processing_token is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_reel_extraction_place_batch';
  end if;

  select extraction.*
  into v_extraction
  from public.reel_extractions as extraction
  where extraction.id = p_extraction_id
  for update;

  if not found
     or v_extraction.worker_reel_id is distinct from p_worker_reel_id
     or v_extraction.processing_token is distinct from p_processing_token
     or v_extraction.processing_status not in ('PROCESSING', 'COMPLETED') then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  if v_extraction.processing_status = 'PROCESSING' and not exists (
    select 1
    from public.reels as reel
    where reel.id = p_worker_reel_id
      and reel.extraction_id = p_extraction_id
      and reel.processing_status = 'PROCESSING'
      and reel.processing_token = p_processing_token
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  with candidates as (
    select job.id
    from public.reel_extraction_place_jobs as job
    where job.extraction_id = p_extraction_id
      and (
        job.processing_status = 'PENDING'
        or (
          job.processing_status = 'PROCESSING'
          and (
            job.lease_processing_token is distinct from p_processing_token
            or job.lease_expires_at <= now()
          )
        )
      )
    order by job.position
    for update skip locked
    limit least(greatest(coalesce(p_limit, 5), 1), 5)
  ), claimed as (
    update public.reel_extraction_place_jobs as job
    set
      processing_status = 'PROCESSING',
      attempt_count = job.attempt_count + 1,
      lease_processing_token = p_processing_token,
      lease_expires_at = now() + make_interval(
        secs => least(greatest(coalesce(p_lease_seconds, 300), 60), 600)
      ),
      updated_at = now()
    from candidates
    where job.id = candidates.id
    returning
      job.position,
      job.matched_place,
      job.thumbnail_source_url,
      job.instagram_description,
      job.instagram_author_username,
      job.instagram_thumbnail_url,
      job.has_match_failures,
      job.match_failures,
      job.attempt_count
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'position', claimed.position,
        'matched_place', claimed.matched_place,
        'thumbnail_source_url', claimed.thumbnail_source_url,
        'instagram_description', claimed.instagram_description,
        'instagram_author_username', claimed.instagram_author_username,
        'instagram_thumbnail_url', claimed.instagram_thumbnail_url,
        'has_match_failures', claimed.has_match_failures,
        'match_failures', claimed.match_failures,
        'attempt_count', claimed.attempt_count
      ) order by claimed.position
    ),
    '[]'::jsonb
  )
  into v_jobs
  from claimed;

  select exists (
    select 1
    from public.reel_extraction_place_jobs as job
    where job.extraction_id = p_extraction_id
      and job.processing_status <> 'COMPLETED'
  )
  into v_has_unfinished;

  if v_extraction.processing_status = 'PROCESSING' then
    update public.reel_extractions
    set updated_at = now()
    where id = p_extraction_id;
  end if;

  return jsonb_build_object(
    'jobs', v_jobs,
    'has_unfinished', v_has_unfinished
  );
end;
$$;

revoke all on function public.claim_reel_extraction_place_batch(
  uuid, uuid, uuid, integer, integer
) from public, anon, authenticated;
grant execute on function public.claim_reel_extraction_place_batch(
  uuid, uuid, uuid, integer, integer
) to service_role;

create function public.complete_reel_extraction_place_job(
  p_extraction_id uuid,
  p_worker_reel_id uuid,
  p_processing_token uuid,
  p_position integer,
  p_place_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_extraction public.reel_extractions%rowtype;
  v_has_unfinished boolean;
  v_has_match_failures boolean;
begin
  if p_extraction_id is null
     or p_worker_reel_id is null
     or p_processing_token is null
     or p_position is null
     or p_position < 0
     or p_place_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_reel_extraction_place_job';
  end if;

  select extraction.*
  into v_extraction
  from public.reel_extractions as extraction
  where extraction.id = p_extraction_id
  for update;

  if not found
     or v_extraction.worker_reel_id is distinct from p_worker_reel_id
     or v_extraction.processing_token is distinct from p_processing_token then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  if v_extraction.processing_status = 'COMPLETED' then
    return false;
  end if;

  if v_extraction.processing_status <> 'PROCESSING'
     or not exists (
       select 1
       from public.reels as reel
       where reel.id = p_worker_reel_id
         and reel.extraction_id = p_extraction_id
         and reel.processing_status = 'PROCESSING'
         and reel.processing_token = p_processing_token
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  update public.reel_extraction_place_jobs as job
  set
    processing_status = 'COMPLETED',
    place_id = p_place_id,
    lease_processing_token = null,
    lease_expires_at = null,
    last_error = null,
    completed_at = coalesce(job.completed_at, now()),
    updated_at = now()
  where job.extraction_id = p_extraction_id
    and job.position = p_position
    and job.processing_status = 'PROCESSING'
    and job.lease_processing_token = p_processing_token;

  if not found and not exists (
    select 1
    from public.reel_extraction_place_jobs as job
    where job.extraction_id = p_extraction_id
      and job.position = p_position
      and job.processing_status = 'COMPLETED'
  ) then
    raise exception using
      errcode = 'P0002',
      message = 'reel_extraction_place_job_not_claimed';
  end if;

  if exists (
    select 1
    from public.reel_extraction_place_jobs as job
    where job.extraction_id = p_extraction_id
      and job.position = p_position
      and job.processing_status = 'COMPLETED'
      and job.place_id is distinct from p_place_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'reel_extraction_place_job_result_mismatch';
  end if;

  select exists (
    select 1
    from public.reel_extraction_place_jobs as job
    where job.extraction_id = p_extraction_id
      and job.processing_status <> 'COMPLETED'
  )
  into v_has_unfinished;

  update public.reel_extractions
  set updated_at = now()
  where id = p_extraction_id;

  if not v_has_unfinished then
    select exists (
      select 1
      from public.reel_extraction_place_jobs as job
      where job.extraction_id = p_extraction_id
        and job.has_match_failures
    )
    into v_has_match_failures;

    perform public.finalize_reel_extraction(
      p_extraction_id,
      p_worker_reel_id,
      p_processing_token,
      not v_has_match_failures
    );

    delete from public.reel_extraction_place_jobs
    where extraction_id = p_extraction_id;
  end if;

  return v_has_unfinished;
end;
$$;

revoke all on function public.complete_reel_extraction_place_job(
  uuid, uuid, uuid, integer, uuid
) from public, anon, authenticated;
grant execute on function public.complete_reel_extraction_place_job(
  uuid, uuid, uuid, integer, uuid
) to service_role;

create function public.hydrate_reel_extraction_place_results(
  p_extraction_id uuid,
  p_worker_reel_id uuid,
  p_processing_token uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_extraction public.reel_extractions%rowtype;
  v_job record;
  v_count integer := 0;
begin
  select extraction.*
  into v_extraction
  from public.reel_extractions as extraction
  where extraction.id = p_extraction_id
  for update;

  if not found
     or v_extraction.worker_reel_id is distinct from p_worker_reel_id
     or v_extraction.processing_token is distinct from p_processing_token then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  if v_extraction.processing_status = 'COMPLETED' then
    return 0;
  end if;

  if v_extraction.processing_status <> 'PROCESSING'
     or not exists (
       select 1
       from public.reels as reel
       where reel.id = p_worker_reel_id
         and reel.extraction_id = p_extraction_id
         and reel.processing_status = 'PROCESSING'
         and reel.processing_token = p_processing_token
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  for v_job in
    select job.position, job.place_id, place.thumbnail_url
    from public.reel_extraction_place_jobs as job
    join public.places as place on place.id = job.place_id
    where job.extraction_id = p_extraction_id
      and job.processing_status = 'COMPLETED'
      and job.place_id is not null
      and not exists (
        select 1
        from public.reel_places as reel_place
        where reel_place.reel_id = p_worker_reel_id
          and reel_place.place_id = job.place_id
          and reel_place.processing_token = p_processing_token
      )
    order by job.position
  loop
    perform public.persist_reel_place_result(
      p_worker_reel_id,
      v_job.place_id,
      v_job.position,
      v_job.thumbnail_url,
      p_processing_token
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.hydrate_reel_extraction_place_results(
  uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.hydrate_reel_extraction_place_results(
  uuid, uuid, uuid
) to service_role;

create function public.release_reel_extraction_place_job(
  p_extraction_id uuid,
  p_worker_reel_id uuid,
  p_processing_token uuid,
  p_position integer,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_extraction public.reel_extractions%rowtype;
begin
  select extraction.*
  into v_extraction
  from public.reel_extractions as extraction
  where extraction.id = p_extraction_id
  for update;

  if not found
     or v_extraction.processing_status <> 'PROCESSING'
     or v_extraction.worker_reel_id is distinct from p_worker_reel_id
     or v_extraction.processing_token is distinct from p_processing_token then
    raise exception using
      errcode = 'P0001',
      message = 'stale_reel_processing_attempt';
  end if;

  update public.reel_extraction_place_jobs as job
  set
    processing_status = 'PENDING',
    lease_processing_token = null,
    lease_expires_at = null,
    last_error = left(coalesce(p_error, 'unknown'), 1000),
    updated_at = now()
  where job.extraction_id = p_extraction_id
    and job.position = p_position
    and job.processing_status = 'PROCESSING'
    and job.lease_processing_token = p_processing_token;
end;
$$;

revoke all on function public.release_reel_extraction_place_job(
  uuid, uuid, uuid, integer, text
) from public, anon, authenticated;
grant execute on function public.release_reel_extraction_place_job(
  uuid, uuid, uuid, integer, text
) to service_role;

comment on table public.reel_extraction_place_jobs is
  '매칭된 장소 후보의 durable checkpoint; Edge Function은 한 호출에서 순차적으로 최대 5개를 저장한다';
