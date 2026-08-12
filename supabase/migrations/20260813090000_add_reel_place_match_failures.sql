-- 한 릴스에 여러 장소가 섞일 수 있으므로 reels.failure_reason은 파이프라인
-- 전체의 대분류로 유지하고, 장소별 매칭 실패 원인은 별도 행으로 기록한다.

create table public.reel_place_match_failures (
  reel_id           uuid not null references public.reels(id) on delete cascade,
  guess_index       integer not null check (guess_index >= 0 and guess_index < 10),
  place_name        text not null,
  source_address    text,
  source_region     text,
  failure_stage     text not null
                      check (failure_stage in ('KAKAO_SEARCH','AI_REVIEW','FINAL_GUARD')),
  failure_reason    text not null
                      check (
                        failure_reason in (
                          'NO_KAKAO_CANDIDATE',
                          'NO_KAKAO_CANDIDATE_AFTER_EXPANSION',
                          'AI_JUDGMENT_UNAVAILABLE',
                          'AMBIGUOUS_SAME_NAME',
                          'NAME_MISMATCH',
                          'ADDRESS_CONFLICT',
                          'INSUFFICIENT_CONTEXT',
                          'AI_SELECTED_UNKNOWN_CANDIDATE',
                          'REGION_CONFLICT',
                          'ROAD_CONFLICT',
                          'BUILDING_NUMBER_CONFLICT',
                          'UNRESOLVED_MULTI_REGION',
                          'INSUFFICIENT_ADDRESS_EVIDENCE'
                        )
                      ),
  search_origin     text not null
                      check (search_origin in ('INITIAL','EXPANDED_NAME_ONLY')),
  classifier_reason text
                      check (
                        classifier_reason is null or
                        classifier_reason in (
                          'NO_VERIFIED_CANDIDATE',
                          'MULTIPLE_VERIFIED_CANDIDATES'
                        )
                      ),
  candidate_count   integer not null default 0 check (candidate_count >= 0),
  candidate_ids     text[] not null default '{}',
  created_at        timestamptz not null default now(),
  primary key (reel_id, guess_index)
);

create index idx_reel_place_match_failures_reason
  on public.reel_place_match_failures (failure_reason, created_at desc);

alter table public.reel_place_match_failures enable row level security;

grant select on public.reel_place_match_failures to authenticated;
grant select, insert, update, delete
  on public.reel_place_match_failures to service_role;

create policy "reel_place_match_failures_select_own"
  on public.reel_place_match_failures
  for select to authenticated
  using (
    exists (
      select 1
      from public.reels
      where reels.id = reel_place_match_failures.reel_id
        and reels.user_id = auth.uid()
    )
  );

comment on table public.reel_place_match_failures is
  '릴스에서 추출됐지만 최종 저장되지 않은 장소별 매칭 실패 진단';

comment on column public.reel_place_match_failures.failure_reason is
  '검색 실패, AI 판단 불가, 최종 코드 가드 거부를 구분하는 장소별 enum 코드';
