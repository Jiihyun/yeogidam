# 여기담 Plan 01 — Supabase 백엔드 기반 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 여기담 MVP의 Supabase 백엔드 기반(로컬 개발 환경, DB 스키마, RLS, 트리거, Storage 버킷)을 pgTAP 테스트와 함께 구축한다.

**Architecture:** Supabase CLI 로컬 스택(Docker) 위에서 SQL 마이그레이션으로 스키마를 정의하고, pgTAP로 테이블/제약/RLS/트리거를 TDD한다. 쓰기(`places`/`reels`/`saved_places`)는 추후 Edge Function이 `service_role`로 수행(RLS 우회)하고, 사용자는 자기 데이터 조회·삭제만 가능하도록 RLS를 건다. 인증은 MVP 단계에서 익명 로그인만 사용한다.

**Tech Stack:** Supabase CLI, PostgreSQL 15, pgTAP, Docker.

## Global Constraints

- 로컬 개발은 Supabase CLI + Docker 스택 사용 (`supabase start`). Docker 데몬이 실행 중이어야 함.
- 테이블/컬럼 명명은 `snake_case`.
- enum 값은 Postgres enum 타입이 아니라 `text` + `CHECK` 제약으로 표현한다.
- 모든 사용자 데이터 테이블에 RLS를 켜고, 정책 없는 동작은 기본 거부한다.
- `places`/`reels`/`saved_places`에 대한 INSERT/UPDATE는 사용자 정책을 만들지 않는다(= Edge Function의 `service_role`만 수행). 사용자는 SELECT와 (본인) DELETE만.
- 커밋 메시지 prefix는 AngularJS 스타일: `feat`/`refactor`/`fix`/`style`/`test`/`docs`/`chore`/`build`.
- MVP 인증 = Supabase 익명 인증만 활성화. 카카오/Apple은 이 plan 범위 밖.
- 마이그레이션 파일에는 pgTAP/테스트 전용 코드를 넣지 않는다(테스트는 `supabase/tests/`에만).

## 선행 조건 (사람이 하는 준비)

- Docker Desktop 실행 중일 것 (이 저장소 머신에 Docker 24.x 설치 확인됨).
- Supabase 클라우드 프로젝트 생성 및 대시보드에서 "Anonymous sign-ins" 활성화는 **배포 시점**에 필요. 이 plan은 전부 **로컬**에서 검증 가능하므로 클라우드 프로젝트 없이 진행한다. (로컬 익명 인증은 아래 Task 1의 `config.toml` 설정으로 켠다.)

---

## File Structure

- `supabase/config.toml` — 로컬 스택 설정 (Task 1에서 생성, 익명 인증 on)
- `supabase/migrations/<ts>_init_schema.sql` — 4개 테이블 + CHECK + 인덱스 (Task 2)
- `supabase/migrations/<ts>_rls_policies.sql` — RLS enable + 정책 (Task 3)
- `supabase/migrations/<ts>_triggers.sql` — handle_new_user + updated_at (Task 4)
- `supabase/migrations/<ts>_storage_buckets.sql` — place-thumbnails 버킷 + 정책 (Task 5)
- `supabase/tests/00_smoke.sql` — pgTAP 동작 확인 (Task 1)
- `supabase/tests/01_schema.sql` — 스키마 테스트 (Task 2)
- `supabase/tests/02_rls.sql` — RLS 테스트 (Task 3)
- `supabase/tests/03_triggers.sql` — 트리거 테스트 (Task 4)
- `supabase/tests/04_storage.sql` — Storage 테스트 (Task 5)
- `.gitignore` — supabase 로컬 산출물 무시 (Task 1)

> **마이그레이션 파일명의 `<ts>`**: `supabase migration new <name>`이 생성하는 타임스탬프 접두사를 그대로 사용한다. 아래 예시 경로의 타임스탬프는 실제 생성값으로 대체될 수 있다.

---

### Task 1: 로컬 Supabase 프로젝트 부트스트랩 + pgTAP 스모크

**Files:**
- Create: `supabase/config.toml` (via `supabase init`)
- Create: `supabase/tests/00_smoke.sql`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: (없음 — 최초 태스크)
- Produces: 실행 가능한 로컬 Supabase 스택, `supabase db reset`·`supabase test db` 워크플로우, 익명 인증 활성 설정.

- [ ] **Step 1: Supabase CLI 설치**

Run:
```bash
brew install supabase/tap/supabase
supabase --version
```
Expected: 버전 문자열 출력 (예: `2.x.x`).

- [ ] **Step 2: 프로젝트 초기화**

작업 디렉터리(`/Users/jihyun/dev/yeogidam`)에서:
```bash
supabase init
```
Expected: `supabase/config.toml` 생성. 이미 있으면 덮어쓸지 물으면 `N`.

- [ ] **Step 3: 익명 인증 활성화**

`supabase/config.toml`의 `[auth]` 섹션에 아래 키가 `true`인지 확인/수정한다. 없으면 추가한다:
```toml
[auth]
enable_anonymous_sign_ins = true
```

- [ ] **Step 4: 로컬 산출물 gitignore**

`.gitignore`에 다음을 추가한다(파일이 없으면 생성):
```gitignore
# Supabase local
supabase/.branches
supabase/.temp
```

- [ ] **Step 5: 실패하는 스모크 테스트 작성**

`supabase/tests/00_smoke.sql`:
```sql
begin;
select plan(1);

-- pgTAP이 로드되고 테스트 러너가 동작하는지 확인하는 스모크 테스트
select ok( true, 'pgTAP smoke test runs' );

select * from finish();
rollback;
```

- [ ] **Step 6: 스택 시작 후 테스트 실행 → 통과 확인**

Run:
```bash
supabase start
supabase test db
```
Expected: `supabase start`가 로컬 컨테이너를 띄우고 API/DB URL을 출력. `supabase test db`가 `00_smoke.sql`을 실행해 `ok 1 - pgTAP smoke test runs`, `# All tests passed` 출력.

> 참고: 이 태스크는 "실행 인프라"를 세우는 단계라 스모크 테스트가 처음부터 통과한다. 이후 태스크부터는 정상적인 red→green 사이클을 따른다.

- [ ] **Step 7: 커밋**

```bash
git add supabase/config.toml supabase/tests/00_smoke.sql .gitignore
git commit -m "chore: 로컬 Supabase 스택 초기화 및 pgTAP 스모크 테스트"
```

---

### Task 2: 핵심 스키마 마이그레이션 (profiles/places/reels/saved_places)

**Files:**
- Create: `supabase/migrations/<ts>_init_schema.sql`
- Create/Modify: `supabase/tests/01_schema.sql`

**Interfaces:**
- Consumes: Task 1의 로컬 스택.
- Produces: 다음 스키마 표면(이후 Edge Function/iOS plan이 의존):
  - `public.profiles(id uuid pk→auth.users, nickname text, description text, avatar_url text, created_at, updated_at)`
  - `public.places(id uuid pk, naver_place_id text unique, name text not null, category, road_address, address, latitude double precision, longitude double precision, naver_link, naver_thumbnail_url, telephone, created_at)`
  - `public.reels(id uuid pk, user_id uuid→auth.users, place_id uuid→places null, instagram_url text not null, instagram_title, instagram_description, instagram_thumbnail_url, source text{instagram_share|url_input}, processing_status text{PENDING|PROCESSING|COMPLETED|FAILED}, failure_reason text{IG_FETCH_FAILED|PLACE_NOT_FOUND|UNKNOWN}|null, created_at, updated_at)`
  - `public.saved_places(id uuid pk, user_id uuid→auth.users, place_id uuid→places not null, thumbnail_url text, created_at, unique(user_id, place_id))`

- [ ] **Step 1: 마이그레이션 파일 생성**

Run:
```bash
supabase migration new init_schema
```
Expected: `supabase/migrations/<ts>_init_schema.sql` 빈 파일 생성.

- [ ] **Step 2: 실패하는 스키마 테스트 작성**

`supabase/tests/01_schema.sql`:
```sql
begin;
select plan(20);

-- 테이블 존재
select has_table('public', 'profiles',      'profiles 테이블 존재');
select has_table('public', 'places',        'places 테이블 존재');
select has_table('public', 'reels',         'reels 테이블 존재');
select has_table('public', 'saved_places',  'saved_places 테이블 존재');

-- PK
select col_is_pk('public', 'profiles',     'id', 'profiles.id PK');
select col_is_pk('public', 'places',       'id', 'places.id PK');
select col_is_pk('public', 'reels',        'id', 'reels.id PK');
select col_is_pk('public', 'saved_places', 'id', 'saved_places.id PK');

-- 핵심 컬럼
select has_column('public', 'reels', 'processing_status', 'reels.processing_status 존재');
select has_column('public', 'reels', 'instagram_url',     'reels.instagram_url 존재');
select has_column('public', 'places', 'naver_place_id',   'places.naver_place_id 존재');
select has_column('public', 'saved_places', 'thumbnail_url', 'saved_places.thumbnail_url 존재');

-- NOT NULL
select col_not_null('public', 'reels', 'instagram_url', 'reels.instagram_url NOT NULL');
select col_not_null('public', 'reels', 'user_id',       'reels.user_id NOT NULL');
select col_not_null('public', 'saved_places', 'place_id','saved_places.place_id NOT NULL');
select col_not_null('public', 'places', 'name',          'places.name NOT NULL');

-- UNIQUE / CHECK 동작 검증
-- places.naver_place_id UNIQUE
prepare dup_naver as
  insert into public.places (naver_place_id, name) values ('nv-1', 'A'), ('nv-1', 'B');
select throws_ok('dup_naver', '23505', null, 'naver_place_id 중복은 unique 위반');

-- saved_places(user_id, place_id) UNIQUE 는 03_triggers 이후 데이터 필요 → 여기선 CHECK만 검증
-- reels.processing_status CHECK
prepare bad_status as
  insert into public.reels (user_id, instagram_url, processing_status)
  values ('00000000-0000-0000-0000-000000000000', 'https://x', 'NOPE');
select throws_ok('bad_status', '23514', null, 'processing_status 잘못된 값은 check 위반');

-- reels.source CHECK
prepare bad_source as
  insert into public.reels (user_id, instagram_url, source)
  values ('00000000-0000-0000-0000-000000000000', 'https://x', 'twitter');
select throws_ok('bad_source', '23514', null, 'source 잘못된 값은 check 위반');

-- saved_places.place_id NOT NULL 위반
prepare null_place as
  insert into public.saved_places (user_id, place_id)
  values ('00000000-0000-0000-0000-000000000000', null);
select throws_ok('null_place', '23502', null, 'saved_places.place_id NULL 불가');

select * from finish();
rollback;
```

- [ ] **Step 3: 테스트 실행 → 실패 확인**

Run:
```bash
supabase test db
```
Expected: FAIL — `01_schema.sql`에서 `has_table` 등이 실패 (`relation "public.profiles" does not exist` 류).

- [ ] **Step 4: 스키마 마이그레이션 작성**

`supabase/migrations/<ts>_init_schema.sql`:
```sql
-- 여기담 핵심 스키마: profiles / places / reels / saved_places

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nickname    text,
  description text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.places (
  id                  uuid primary key default gen_random_uuid(),
  naver_place_id      text unique,
  name                text not null,
  category            text,
  road_address        text,
  address             text,
  latitude            double precision,
  longitude           double precision,
  naver_link          text,
  naver_thumbnail_url text,
  telephone           text,
  created_at          timestamptz not null default now()
);

create table public.reels (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  place_id                uuid references public.places(id) on delete set null,
  instagram_url           text not null,
  instagram_title         text,
  instagram_description   text,
  instagram_thumbnail_url text,
  source                  text not null default 'instagram_share'
                            check (source in ('instagram_share', 'url_input')),
  processing_status       text not null default 'PENDING'
                            check (processing_status in ('PENDING','PROCESSING','COMPLETED','FAILED')),
  failure_reason          text
                            check (failure_reason in ('IG_FETCH_FAILED','PLACE_NOT_FOUND','UNKNOWN')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table public.saved_places (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  place_id      uuid not null references public.places(id) on delete cascade,
  thumbnail_url text,
  created_at    timestamptz not null default now(),
  unique (user_id, place_id)
);

-- 목록 조회용 인덱스
create index idx_reels_user_created        on public.reels (user_id, created_at desc);
create index idx_reels_user_place          on public.reels (user_id, place_id);
create index idx_saved_places_user_created on public.saved_places (user_id, created_at desc);
```

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run:
```bash
supabase test db
```
Expected: PASS — `01_schema.sql`의 20개 어서션 모두 통과, `# All tests passed`.

- [ ] **Step 6: 커밋**

```bash
git add supabase/migrations supabase/tests/01_schema.sql
git commit -m "feat: 핵심 DB 스키마(profiles/places/reels/saved_places) 마이그레이션"
```

---

### Task 3: RLS 정책

**Files:**
- Create: `supabase/migrations/<ts>_rls_policies.sql`
- Create: `supabase/tests/02_rls.sql`

**Interfaces:**
- Consumes: Task 2의 테이블.
- Produces: RLS 규칙 —
  - `profiles`: 본인 SELECT/UPDATE
  - `places`: authenticated SELECT(전체 공개), 쓰기 정책 없음
  - `reels`: 본인 SELECT/DELETE, 쓰기 정책 없음
  - `saved_places`: 본인 SELECT/DELETE, 쓰기 정책 없음

- [ ] **Step 1: 마이그레이션 파일 생성**

Run:
```bash
supabase migration new rls_policies
```

- [ ] **Step 2: 실패하는 RLS 테스트 작성**

`supabase/tests/02_rls.sql`:
```sql
begin;
select plan(6);

-- 두 명의 유저를 auth.users에 직접 생성 (테스트 픽스처)
insert into auth.users (id, aud, role, email)
values ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'a@test.dev'),
       ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'b@test.dev');

-- 공용 place 1개, 각 유저의 reels/saved_places 데이터 시드 (service context = 현재 postgres 역할)
insert into public.places (id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PlaceA');
insert into public.reels (id, user_id, instagram_url)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'https://ig/u1'),
       ('dddddddd-dddd-dddd-dddd-dddddddddddd', '22222222-2222-2222-2222-222222222222', 'https://ig/u2');
insert into public.saved_places (user_id, place_id)
values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- 유저1 컨텍스트로 전환
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub','11111111-1111-1111-1111-111111111111','role','authenticated')::text, true);

-- 유저1은 자기 reels만 봄
select is(
  (select count(*)::int from public.reels),
  1, '유저1은 자신의 reels 1건만 조회');

-- 유저1은 자기 saved_places만 봄
select is(
  (select count(*)::int from public.saved_places),
  1, '유저1은 자신의 saved_places 1건만 조회');

-- places는 공개 → 조회 가능
select is(
  (select count(*)::int from public.places),
  1, '유저1은 공용 places 조회 가능');

-- 유저1은 reels에 직접 INSERT 불가 (정책 없음 → 거부)
prepare ins_reel as
  insert into public.reels (user_id, instagram_url)
  values ('11111111-1111-1111-1111-111111111111', 'https://ig/hack');
select throws_ok('ins_reel', '42501', null, '사용자는 reels 직접 INSERT 불가');

-- 유저2 컨텍스트로 전환
select set_config('request.jwt.claims',
  json_build_object('sub','22222222-2222-2222-2222-222222222222','role','authenticated')::text, true);

-- 유저2는 유저1의 saved_places를 못 봄
select is(
  (select count(*)::int from public.saved_places),
  0, '유저2는 유저1의 saved_places 조회 불가');

-- 유저2는 유저1의 reels를 삭제 불가 (본인 것만 삭제 → 0 rows affected)
with del as (
  delete from public.reels
  where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  returning 1
)
select is( (select count(*)::int from del), 0, '유저2는 유저1의 reels 삭제 불가');

select * from finish();
rollback;
```

- [ ] **Step 3: 테스트 실행 → 실패 확인**

Run:
```bash
supabase test db
```
Expected: FAIL — RLS가 아직 없어 유저1이 reels 2건을 다 보거나, INSERT가 성공해 `throws_ok`가 실패.

- [ ] **Step 4: RLS 마이그레이션 작성**

`supabase/migrations/<ts>_rls_policies.sql`:
```sql
-- RLS 활성화
alter table public.profiles     enable row level security;
alter table public.places       enable row level security;
alter table public.reels        enable row level security;
alter table public.saved_places enable row level security;

-- profiles: 본인만 조회/수정
create policy "profiles_select_own" on public.profiles
  for select to authenticated using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- places: 인증 사용자 전체 조회(공개). 쓰기 정책 없음 → service_role만.
create policy "places_select_all" on public.places
  for select to authenticated using (true);

-- reels: 본인 조회/삭제. 쓰기 정책 없음.
create policy "reels_select_own" on public.reels
  for select to authenticated using (auth.uid() = user_id);
create policy "reels_delete_own" on public.reels
  for delete to authenticated using (auth.uid() = user_id);

-- saved_places: 본인 조회/삭제. 쓰기 정책 없음.
create policy "saved_places_select_own" on public.saved_places
  for select to authenticated using (auth.uid() = user_id);
create policy "saved_places_delete_own" on public.saved_places
  for delete to authenticated using (auth.uid() = user_id);
```

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run:
```bash
supabase test db
```
Expected: PASS — `02_rls.sql`의 6개 어서션 통과.

- [ ] **Step 6: 커밋**

```bash
git add supabase/migrations supabase/tests/02_rls.sql
git commit -m "feat: RLS 정책(본인 데이터만 조회·삭제, 쓰기는 service_role)"
```

---

### Task 4: 트리거 (handle_new_user + updated_at)

**Files:**
- Create: `supabase/migrations/<ts>_triggers.sql`
- Create: `supabase/tests/03_triggers.sql`

**Interfaces:**
- Consumes: Task 2의 테이블, Task 3의 RLS.
- Produces:
  - `public.handle_new_user()` — `auth.users` INSERT 시 `profiles` 행 자동 생성(닉네임은 메타데이터에서, 없으면 NULL).
  - `public.set_updated_at()` — UPDATE 시 `updated_at` 자동 갱신 (profiles, reels).

- [ ] **Step 1: 마이그레이션 파일 생성**

Run:
```bash
supabase migration new triggers
```

- [ ] **Step 2: 실패하는 트리거 테스트 작성**

`supabase/tests/03_triggers.sql`:
```sql
begin;
select plan(3);

-- 새 유저 생성 시 profiles 자동 생성 (닉네임 메타데이터 포함)
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values ('33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated',
        'c@test.dev', '{"nickname":"온림러버"}'::jsonb);

select is(
  (select nickname from public.profiles where id = '33333333-3333-3333-3333-333333333333'),
  '온림러버', 'auth.users 생성 시 profiles 자동 생성 + 닉네임 매핑');

-- 메타데이터 없는(익명) 유저도 profiles 생성 (닉네임 NULL)
insert into auth.users (id, aud, role)
values ('44444444-4444-4444-4444-444444444444', 'authenticated', 'authenticated');

select is(
  (select count(*)::int from public.profiles where id = '44444444-4444-4444-4444-444444444444'),
  1, '익명 유저도 profiles 자동 생성');

-- updated_at 자동 갱신: 강제로 과거값으로 만든 뒤 update 하면 now()로 바뀜
update public.profiles set updated_at = 'epoch'
  where id = '33333333-3333-3333-3333-333333333333';
update public.profiles set description = 'hi'
  where id = '33333333-3333-3333-3333-333333333333';

select ok(
  (select updated_at from public.profiles where id = '33333333-3333-3333-3333-333333333333') > now() - interval '1 minute',
  'profiles UPDATE 시 updated_at 자동 갱신');

select * from finish();
rollback;
```

- [ ] **Step 3: 테스트 실행 → 실패 확인**

Run:
```bash
supabase test db
```
Expected: FAIL — 트리거가 없어 `profiles` 자동 생성이 안 되어 첫 어서션부터 실패.

- [ ] **Step 4: 트리거 마이그레이션 작성**

`supabase/migrations/<ts>_triggers.sql`:
```sql
-- auth.users 생성 시 profiles 자동 생성
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, nickname, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nickname', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at 자동 갱신
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger set_reels_updated_at
  before update on public.reels
  for each row execute function public.set_updated_at();
```

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run:
```bash
supabase test db
```
Expected: PASS — `03_triggers.sql`의 3개 어서션 통과.

- [ ] **Step 6: 커밋**

```bash
git add supabase/migrations supabase/tests/03_triggers.sql
git commit -m "feat: 트리거(handle_new_user, updated_at 자동 갱신)"
```

---

### Task 5: Storage 버킷 (place-thumbnails)

**Files:**
- Create: `supabase/migrations/<ts>_storage_buckets.sql`
- Create: `supabase/tests/04_storage.sql`

**Interfaces:**
- Consumes: 로컬 스택.
- Produces: `place-thumbnails` 공개 버킷 — 공개 읽기, 쓰기는 `service_role`만(정책 없음).

- [ ] **Step 1: 마이그레이션 파일 생성**

Run:
```bash
supabase migration new storage_buckets
```

- [ ] **Step 2: 실패하는 Storage 테스트 작성**

`supabase/tests/04_storage.sql`:
```sql
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
```

- [ ] **Step 3: 테스트 실행 → 실패 확인**

Run:
```bash
supabase test db
```
Expected: FAIL — 버킷/정책이 없어 두 어서션 모두 실패.

- [ ] **Step 4: Storage 마이그레이션 작성**

`supabase/migrations/<ts>_storage_buckets.sql`:
```sql
-- 썸네일 재호스팅용 공개 버킷
insert into storage.buckets (id, name, public)
values ('place-thumbnails', 'place-thumbnails', true)
on conflict (id) do nothing;

-- 공개 읽기 정책 (쓰기 정책 없음 → service_role만 업로드)
create policy "place_thumbnails_public_read" on storage.objects
  for select
  using (bucket_id = 'place-thumbnails');
```

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run:
```bash
supabase test db
```
Expected: PASS — `04_storage.sql`의 2개 어서션 통과. 전체 테스트(`00`~`04`)도 함께 통과.

- [ ] **Step 6: 커밋**

```bash
git add supabase/migrations supabase/tests/04_storage.sql
git commit -m "feat: place-thumbnails Storage 버킷 및 공개 읽기 정책"
```

---

## 완료 기준 (Definition of Done)

- `supabase db reset && supabase test db` 실행 시 `00`~`04` 테스트 전부 통과.
- `supabase/migrations/`에 4개 마이그레이션이 순서대로 존재하고 깨끗한 리셋에서 재현 가능.
- 이후 plan(02 iOS, 03 Edge Function)이 이 스키마·RLS·버킷을 그대로 소비.

## 배포 시 남는 수동 작업 (이 plan 범위 밖, 메모)

- Supabase 클라우드 프로젝트 생성 → `supabase link` → `supabase db push`.
- 대시보드 Authentication에서 "Anonymous sign-ins" 활성화(로컬 `config.toml`과 동일).
- 이 값들은 Plan 02(iOS)에서 앱에 넣을 `SUPABASE_URL` / `anon key`로 이어짐.
