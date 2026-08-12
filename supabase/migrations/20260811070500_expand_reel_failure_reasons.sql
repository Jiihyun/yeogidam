alter table public.reels
  drop constraint if exists reels_failure_reason_check,
  add constraint reels_failure_reason_check
    check (
      failure_reason in (
        'IG_FETCH_FAILED',
        'IG_CAPTION_NOT_FOUND',
        'PROVIDER_CONFIG_MISSING',
        'GEMINI_PLACE_NOT_FOUND',
        'KAKAO_PLACE_NOT_FOUND',
        'PLACE_NOT_FOUND',
        'UNKNOWN'
      )
    );
