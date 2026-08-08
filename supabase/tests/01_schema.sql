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
