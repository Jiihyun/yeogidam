-- Instagram 캡션에서 추출한 층·동·호 포함 상세주소를 보존한다.
alter table public.places
  add column source_address text;

comment on column public.places.source_address is
  'Instagram caption address including floor, building, and unit details';
