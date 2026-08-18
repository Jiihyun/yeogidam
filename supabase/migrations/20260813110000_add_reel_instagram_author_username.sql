alter table public.reels
  add column instagram_author_username text
  constraint reels_instagram_author_username_check
  check (
    instagram_author_username is null
    or instagram_author_username ~ '^[a-z0-9._]{1,30}$'
  );

comment on column public.reels.instagram_author_username is
  'Instagram 공개 title/description metadata에서 추출한 username(@ 제외, 소문자). Instagram numeric user ID가 아님.';

-- 기존에 title 또는 description wrapper가 저장된 행만 보수적으로 채운다.
with parsed as (
  select
    id,
    lower(coalesce(
      substring(
        instagram_title from
        '\(@([A-Za-z0-9._]{1,30})\)\s*[•·]\s*Instagram'
      ),
      substring(
        instagram_description from
        '^\s*@?([A-Za-z0-9._]{1,30})\s*-\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+[0-9]{1,2},\s+[0-9]{4}\s*:'
      ),
      substring(
        instagram_description from
        '^\s*[0-9][0-9.,]*[KMBkmb]?\s+likes?,\s*[0-9][0-9.,]*[KMBkmb]?\s+comments?\s*-\s*@?([A-Za-z0-9._]{1,30})\s+on\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+[0-9]{1,2},\s+[0-9]{4}\s*:'
      )
    )) as author_username
  from public.reels
  where instagram_title is not null
     or instagram_description is not null
)
update public.reels as reels
set instagram_author_username = parsed.author_username
from parsed
where reels.id = parsed.id
  and parsed.author_username is not null
  and reels.instagram_author_username is null;
