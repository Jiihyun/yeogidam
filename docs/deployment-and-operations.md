# 배포 및 운영 가이드

- 기준일: 2026-08-30
- 대상: Supabase Cloud + iOS/Xcode

Supabase 프로젝트는 다음과 같이 분리한다.

| 환경 | 프로젝트 | Project ref | 기본 릴스 저장 Function |
|---|---|---|---|
| 개발·QA | `yeogidam develop` | `vowmaqcmwocrocfymyux` | `save-instagram-reel-v2` |
| 운영 | `yeogidam demo` | `hbbrgudsbvnwuylxqlta` | `save-instagram-reel` |

## 1. 사전 요구 사항

- Supabase CLI 로그인 및 프로젝트 link
- Docker Desktop 또는 호환 Docker 런타임
- Xcode 26+, XcodeGen
- Apple Developer 계정과 App Group 사용 권한
- Google Cloud Places API (New)
- Kakao Developers 앱과 Local API REST API 키
- 장소 AI API key. 기본 Gemini이며 OpenAI를 primary 또는 fallback으로 선택할 수 있음

## 2. Kakao Developers 등록

1. [Kakao Developers](https://developers.kakao.com/)에 카카오계정으로 로그인하고 개발자 계정으로 가입한다.
2. 앱 관리의 전체 앱 목록에서 **앱 만들기**를 선택한다.
3. 앱 이름은 `여기담`, 사업자명은 개인 개발자면 본인 또는 서비스 운영 이름, 기본 도메인은 `https://hbbrgudsbvnwuylxqlta.supabase.co`로 등록한다.
4. 생성된 앱의 **앱 > 플랫폼 키 > REST API 키**에서 기본 REST API 키를 복사한다. Admin 키·JavaScript 키·Native App 키가 아니다.
5. Local API의 키워드 장소 검색은 REST API 키만 필요하고 Kakao Login과 사용자 동의항목은 필요하지 않다.
6. 키를 iOS 앱에 넣지 않고 Supabase Function Secret `KAKAO_REST_API_KEY`로만 등록한다.

REST API 키의 호출 허용 IP를 설정하면 보안은 강화되지만, 기본 Supabase Edge Function의 외부 발신 IP는 고정값이 아닐 수 있다. MVP에서는 IP 제한을 비워 두고 키를 서버 secret에만 보관한다. 고정 egress를 도입한 후 IP 제한을 추가한다.

공식 참고:

- [Kakao API 시작하기](https://developers.kakao.com/docs/ko/tutorial/start)
- [Local API 키워드로 장소 검색](https://developers.kakao.com/docs/ko/local/dev-guide)
- [Kakao 지도 장소 ID 바로가기](https://apis.map.kakao.com/web/guide/)

## 3. 환경변수와 비밀값

Edge Function에 필요한 사용자 설정 secret:

```text
PLACE_AI_PRIMARY_PROVIDER    선택, 기본 gemini; gemini 또는 openai
PLACE_AI_FALLBACK_PROVIDER   선택, 미설정 시 자동 fallback 없음; primary와 달라야 함
PLACE_AI_TIMEOUT_MS          선택, 요청당 기본 10000ms; 1000~120000
GEMINI_API_KEY               Gemini를 primary/fallback으로 쓸 때 필수
GEMINI_MODEL                 선택, 기본 gemini-3.5-flash-lite
GEMINI_MATCH_MODEL           선택, 기본 GEMINI_MODEL
OPENAI_API_KEY               OpenAI를 primary/fallback으로 쓸 때 필수
OPENAI_MODEL                 OpenAI를 primary/fallback으로 쓸 때 필수
OPENAI_MATCH_MODEL           선택, 기본 OPENAI_MODEL
KAKAO_REST_API_KEY
GOOGLE_PLACES_API_KEY
PUBLIC_SUPABASE_URL          선택, Storage 공개 URL 기준
```

Supabase가 자동으로 제공하는 값:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

로컬 키는 `supabase/functions/.env`에만 저장합니다. Cloud secret은 다음과 같이 등록합니다.

```bash
supabase secrets set \
  PLACE_AI_PRIMARY_PROVIDER=gemini \
  PLACE_AI_TIMEOUT_MS=10000 \
  GEMINI_API_KEY=... \
  KAKAO_REST_API_KEY=... \
  GOOGLE_PLACES_API_KEY=... \
  --project-ref hbbrgudsbvnwuylxqlta
```

키 값을 문서, Git, 앱 번들에 넣지 않습니다. iOS에 포함되는 Supabase `anon` 키는 공개 클라이언트 키이며 `service_role` 키와 다릅니다.

### 장소 AI 키 교체와 공급자 전환

호출부는 공통 `PlaceAiClient` 계약만 사용하고 Gemini와 OpenAI 구현체가 각 API의 인증·요청·응답 형식을 담당합니다. 이미 포함된 두 구현체 사이를 전환할 때 애플리케이션 코드를 수정할 필요는 없습니다.

- 같은 Gemini 계정의 키를 교체하면 `GEMINI_API_KEY`만 갱신합니다. OpenAI 키 교체도 `OPENAI_API_KEY`만 갱신합니다.
- 같은 공급자에서 모델만 바꾸면 `GEMINI_MODEL` 또는 `OPENAI_MODEL`을 변경합니다. 후보 판단만 별도 모델로 운영하려면 각 공급자의 `*_MATCH_MODEL`을 설정합니다.
- Gemini에서 OpenAI로 전환하려면 `PLACE_AI_PRIMARY_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_MODEL`을 함께 등록합니다. 반대 전환은 primary를 `gemini`로 바꾸고 `GEMINI_API_KEY`를 등록합니다.
- 자동 대체가 필요하면 `PLACE_AI_FALLBACK_PROVIDER`에 primary와 다른 공급자를 지정하고 그 공급자의 key/model도 등록합니다. 변수가 비어 있으면 fallback은 실행되지 않습니다.

fallback은 quota·HTTP 429, timeout, 네트워크 오류, 5xx, 잘못된 공급자 응답에만 실행합니다. 정상적인 빈 장소 결과, 인증 오류, 잘못된 요청, 콘텐츠 차단에는 실행하지 않습니다. 따라서 키를 잘못 등록한 상태가 보조 공급자로 가려지지 않습니다. primary와 fallback을 같은 값으로 두거나 선택한 공급자의 필수 key/model이 없으면 `PROVIDER_CONFIG_MISSING`으로 처리합니다.

예를 들어 Gemini primary와 OpenAI fallback을 활성화할 때는 다음 secret을 추가합니다.

```bash
supabase secrets set \
  PLACE_AI_PRIMARY_PROVIDER=gemini \
  PLACE_AI_FALLBACK_PROVIDER=openai \
  PLACE_AI_TIMEOUT_MS=10000 \
  GEMINI_API_KEY=... \
  OPENAI_API_KEY=... \
  OPENAI_MODEL=... \
  --project-ref hbbrgudsbvnwuylxqlta
```

## 4. 로컬 Supabase

```bash
supabase start
supabase db reset
supabase db test
```

Edge Function 로컬 실행:

```bash
cp supabase/functions/.env.example supabase/functions/.env
supabase functions serve --env-file supabase/functions/.env
```

현재 CLI는 등록된 Function을 함께 serve하므로 v1과 v2를 각각 positional
argument로 넘기지 않는다.

외부 키 없이 파이프라인 구조만 검증하려면 로컬 환경에서만 `STUB_PROVIDERS=1`, 최종 상태를 응답으로 받으려면 `PIPELINE_SYNC=1`을 사용합니다. 스텁 모드에서는 장소 AI와 Kakao 설정을 읽지 않습니다. 두 값은 프로덕션 secret으로 등록하지 않습니다.

## 5. DB와 Function 배포

대기함 API는 기존 앱의 자동 저장 계약을 유지하는 v1과 새 대기함 계약을 쓰는
v2를 별도 slug로 운영한다.

- v1: `/functions/v1/save-instagram-reel`
- v2: `/functions/v1/save-instagram-reel-v2`

`/functions/v1`의 `v1`은 Supabase Edge Function gateway 경로이고, API 버전은
함수 이름의 `-v2`로 구분한다.

배포 순서는 반드시 **DB migration → 업데이트된 v1 → v2**로 고정한다. DB보다
Function을 먼저 배포하거나 v1보다 v2를 먼저 배포하면 전환 구간의 구버전 앱과
v1/v2 경합 처리가 새 스키마 계약을 보장하지 못한다. 각 Function을 이름으로
배포하고 `--prune`은 사용하지 않아 기존 `delete-account`와
`gemini-quota-discord`를 삭제하지 않는다.

개발·QA 프로젝트 배포:

```bash
supabase link --project-ref vowmaqcmwocrocfymyux
supabase db push
supabase functions deploy save-instagram-reel \
  --project-ref vowmaqcmwocrocfymyux
supabase functions deploy save-instagram-reel-v2 \
  --project-ref vowmaqcmwocrocfymyux
supabase functions deploy gemini-quota-discord \
  --no-verify-jwt \
  --project-ref vowmaqcmwocrocfymyux
```

`gemini-quota-discord`는 환경 간 Function 구성을 맞추기 위해 개발 프로젝트에도
배포 상태를 유지한다. 단, 개발 프로젝트에는
`DISCORD_GEMINI_ALERT_WEBHOOK_URL`, `MONITORING_WEBHOOK_USERNAME`,
`MONITORING_WEBHOOK_PASSWORD`를 등록하지 않고, Google Cloud Monitoring 알림
채널도 개발 URL에 연결하지 않으며, 개발 Discord 알림 시험 호출도 하지 않는다.
실제 알림 설정과 호출은 운영 프로젝트에만 둔다.

프론트와 백엔드가 함께 검증된 뒤 운영 프로젝트에 승격할 때도 같은 순서를
사용한다.

```bash
supabase link --project-ref hbbrgudsbvnwuylxqlta
supabase db push
supabase functions deploy save-instagram-reel \
  --project-ref hbbrgudsbvnwuylxqlta
supabase functions deploy save-instagram-reel-v2 \
  --project-ref hbbrgudsbvnwuylxqlta
```

개발·QA 배포 후 확인:

```bash
supabase migration list
supabase functions list --project-ref vowmaqcmwocrocfymyux
```

Function 목록에서 `save-instagram-reel`, `save-instagram-reel-v2`,
`gemini-quota-discord`가 모두 `ACTIVE`인지 확인한다. QA 앱과 Share Extension은
다음 v2 경로를 사용해 저장 요청과 대기함 반영을 확인한다.

```text
https://vowmaqcmwocrocfymyux.supabase.co/functions/v1/save-instagram-reel-v2
```

동시에 v1 경로로 요청한 기존 앱 계약이 자동 저장을 계속 유지하는지 회귀
검증한다.

```text
https://vowmaqcmwocrocfymyux.supabase.co/functions/v1/save-instagram-reel
```

Supabase Dashboard에서 Anonymous sign-ins가 활성화되어 있어야 합니다.

## 6. iOS 프로젝트 생성과 서명

프로젝트 파일은 `ios/project.yml`에서 XcodeGen으로 생성하며 `.xcodeproj`는 Git에 포함하지 않습니다.

```bash
cd ios
xcodegen generate
open Yeogidam.xcodeproj
```

프로젝트 설정:

| 타깃 | Bundle ID | Entitlement |
|---|---|---|
| `Yeogidam` | `com.yeogidam.app` | `group.com.yeogidam` |
| `ShareExtension` | `com.yeogidam.app.ShareExtension` | `group.com.yeogidam` |

두 타깃에 같은 Apple Team과 App Group을 적용합니다. Automatic Signing을 사용합니다. CLI에서 `No Account for Team` 오류가 나면 Xcode `Settings > Accounts`에서 Apple 계정에 로그인한 후 다시 빌드합니다.

## 7. 검증 명령

### Edge Function

```bash
npx -y deno@2 fmt --check \
  supabase/functions/save-instagram-reel \
  supabase/functions/save-instagram-reel-v2
npx -y deno@2 test supabase/functions/save-instagram-reel/*_test.ts
npx -y deno@2 check supabase/functions/save-instagram-reel/index.ts
npx -y deno@2 check supabase/functions/save-instagram-reel-v2/index.ts
```

### DB

```bash
supabase db test
```

### iOS Simulator

```bash
xcodebuild -project ios/Yeogidam.xcodeproj \
  -scheme Yeogidam \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/yeogidam-derived \
  CODE_SIGNING_ALLOWED=NO build
```

### 실기기 최종 확인

1. 앱에서 `시작하기`로 익명 로그인
2. URL 직접 입력으로 장소 저장
3. Instagram 공유 메뉴에서 `여기담` 선택
4. 처리 중 → 완료 전환 또는 새로고침 확인
5. 사진·주소·Kakao 장소 링크 확인
6. 장소 삭제와 RLS 격리 확인

## 8. 비용 방어

### 애플리케이션 레벨

- Gemini structured output과 파서는 장소 개수 상한을 두지 않습니다. 모델이 반환한 모든 유효 장소를 후속 처리합니다.
- 장소당 Kakao 쿼리는 한 번이며 현재 순차 실행합니다. 따라서 Kakao 호출 수는 추출 장소 수에 비례합니다.
- `places.thumbnail_url`이 있으면 외부 사진 API를 다시 호출하지 않습니다.
- `reserve_google_places_thumbnail()`은 UTC 월 기준 900회까지만 원자적으로 예약합니다.
- 900회를 넘으면 Instagram, Kakao, placeholder 순으로 폴백합니다.
- RPC는 `service_role`만 실행할 수 있습니다.

장소 개수 상한을 제거했으므로 매우 긴 장소 모음 캡션에서는 Kakao·사진·Storage 호출량과 처리 시간이 함께 증가한다. 공급자 quota와 Edge Function 실행 시간을 관측하고, 필요하면 장소를 잘라내는 방식이 아닌 제한된 병렬 처리와 재개 가능한 배치 처리로 보호합니다.

### Google Cloud Console

현재 프로젝트에는 다음 quota가 운영 안전장치로 설정되어 있습니다. 이 값은 저장소에서 자동 배포되지 않으므로 Cloud Console 변경 시 문서도 갱신합니다.

| API 요청 | 제한 |
|---|---:|
| Text Search 일일 | 30 |
| Place Photo 일일 | 30 |
| Autocomplete 일일 | 0 |
| Place Details 일일 | 0 |
| Nearby Search 일일 | 0 |
| 사용하지 않는 미디어·리뷰 요청 | 분당 0 |

API 키는 Places API (New)만 호출하도록 API restriction을 설정합니다. Console quota는 외부 hard stop, DB 900회는 앱 내부 hard stop입니다.

## 9. Google Places 정책 주의

현재 MVP는 Google Place Photo를 다운로드해 Supabase Storage에 재호스팅합니다. 기술적으로는 동작하지만 **프로덕션 출시 전 정책 검토와 구현 변경이 필요한 상태**입니다.

Google Maps Platform 약관은 Google Maps Content의 저장·재호스팅과 일반적인 caching을 제한하고, Places 정책은 place ID를 제외한 콘텐츠 저장을 제한합니다. 사진에는 attribution 및 원본 Google Maps 접근 요구도 적용됩니다.

- [Google Maps Platform Terms, 3.2.3](https://cloud.google.com/maps-platform/terms)
- [Places API policies and attributions](https://developers.google.com/maps/documentation/places/web-service/policies)
- [Place Photos (New)](https://developers.google.com/maps/documentation/places/web-service/place-photos)

출시 전 권장 조치:

1. Google 사진 재호스팅 제거 또는 Google의 서면 허용 범위 확인
2. 사진을 요청 시점에 불러오는 방식으로 전환 검토
3. Google Maps logo, 작성자 attribution, 원본 사진 링크 제공
4. 공개 서비스 약관과 개인정보 처리방침에 Google 요구사항 반영
5. Kakao 지도와 Google Places 콘텐츠를 함께 표시하는 방식의 적합성 검토

정책 검토가 끝나기 전 현재 사진 저장 방식은 내부 MVP 검증용으로만 취급합니다.

## 10. 운영 관측과 장애 대응

### 확인할 데이터

- `reels.processing_status`, `failure_reason`
- `reels.instagram_description` 존재 여부. `instagram_title`은 레거시 컬럼이며 신규 처리에서는 저장하지 않음
- `places.thumbnail_source`, `google_place_id`
- `provider_usage_monthly.request_count`
- Storage `place-thumbnails` 업로드 성공 여부

### 실패 분류

| 현상 | 확인 순서 |
|---|---|
| 요청 즉시 401 | 앱 JWT 만료, Share Extension App Group 세션 |
| `IG_FETCH_FAILED` | 릴스 HTML 응답 상태, head description 존재 여부, Instagram 형식 변경 |
| `PLACE_NOT_FOUND` | Gemini 다중 장소, 원문 검증, Kakao API status·itemCount·verifiedCount |
| `UNKNOWN` | places upsert와 DB 제약, Function exception log |
| 사진만 없음 | 월 예약 한도, Google quota, Storage upload, 폴백 URL |
| `COMPLETED`인데 일부 장소가 없음 | 캡션 장소 수와 AI 추출·sanitizedCount, 장소별 candidateCount·2차 판단, `reel_places.position` |
| 같은 릴스를 다시 보내도 재처리 안 됨 | 같은 사용자 shortcode 캐시, processing version, 기존 `reel_places` 복원 여부 |
| 알고리즘 배포 후 기존 릴스 결과가 그대로임 | `PIPELINE_VERSION`을 올렸는지 확인. 같은 버전의 완료 결과는 정상적으로 캐시됨 |
| `FAILED/UNKNOWN`인데 일부 장소가 목록에 보임 | 다중 장소 비트랜잭션 저장 중 뒤 항목 실패 여부, 남은 `saved_places`·`reel_places` 확인 |
| 장소 상세에 관련 릴스가 없음 | 릴스 상태 `COMPLETED`, `reel_places` 연결, 해당 릴스의 `user_id`, RLS 정책 배포 여부 |

Edge Function은 Instagram fetch, 장소 AI 공급자·모델·fallback 여부, Kakao 검색·후보 검증 결과를 JSON 로그로 남깁니다. Supabase Dashboard의 Edge Function Logs와 API Gateway Logs를 함께 확인합니다. `ai_provider_call_failed` 뒤 `ai_provider_fallback_started`와 `ai_provider_fallback_completed`가 이어지면 보조 공급자가 해당 작업을 대신 완료한 것입니다. `ai_providers_exhausted` 또는 `ai_pipeline_failed`는 더 이상 사용할 공급자가 없음을 뜻합니다.

### 부분 저장 진단 순서

1. `reels.instagram_description`의 장소 수와 `ai_provider_call_completed`의 `PLACE_EXTRACTION` `resultCount`를 비교합니다.
2. `ai_place_guesses_sanitized`의 `provider`, `model`, `fallbackUsed`, `extractedCount`, `sanitizedCount`로 실제 공급자와 원문 검증 탈락을 확인합니다.
3. 각 `kakao_place_candidates_classified`의 `candidateCount`, `decision`을 확인합니다.
4. 2차 AI의 호출 성공 여부와 `ai_candidate_selection_guarded`·`ai_candidate_judgment_unresolved`의 결정 및 사유를 확인합니다.
5. `RETRY`이면 `kakao_retry_candidates_resolved`의 검색어·후보 수·최종 검증 결과를 확인합니다.
6. 최종 `reel_places`의 `position`과 장소명을 확인합니다.

애플리케이션 개수 상한은 없지만 선택한 AI 모델이 원문의 모든 장소를 항상 반환한다는 보장은 없다. 캡션과 추출 로그를 비교해 모델 누락을 판단합니다.

`reel_places.position`은 캡션 절대 순번이 아니라 성공한 결과의 압축 순서다. 누락 위치를 판단할 때 position만 보지 말고 캡션과 AI 구조화 로그를 같이 확인합니다.

## 11. 릴리스 체크리스트

- [ ] DB migration과 pgTAP 통과
- [ ] Deno 테스트·format·typecheck 통과
- [ ] DB migration → 업데이트된 v1 → v2 순서로 배포
- [ ] `save-instagram-reel`, `save-instagram-reel-v2`, `gemini-quota-discord` 배포 상태 `ACTIVE`
- [ ] 개발 프로젝트의 `gemini-quota-discord`는 배포만 유지하고 Discord secret·Monitoring 연결·시험 호출은 하지 않았는지 확인
- [ ] 릴스 처리 Function secrets 등록 및 테스트 (개발 Discord secret 제외)
- [ ] 장소 AI primary/fallback이 서로 다르고 선택한 공급자의 key/model이 모두 등록됐는지 확인
- [ ] 키 회전은 해당 공급자 secret만 갱신하고, 공급자 전환은 `PLACE_AI_PRIMARY_PROVIDER`와 대상 key/model을 함께 변경했는지 확인
- [ ] Kakao Local API 실제 후보의 `id`·`place_url` 확인
- [ ] Anonymous sign-in 활성화
- [ ] Google API key restriction과 quota 확인
- [ ] Apple Team과 App Group provisioning 확인
- [ ] Apple 유료 Developer Team을 Xcode에 추가·선택하고 `com.yeogidamm.app`의 Sign in with Apple 개발용 provisioning profile을 발급한 뒤 `정콩이🌳` 실기기 빌드·설치 및 로그인 E2E 확인
- [ ] 실기기 Share Extension E2E 통과
- [ ] 12개 이상 다중 장소가 끝 항목까지 추출·검색되는지 확인
- [ ] 장소 상세에서 관련 릴스 여러 개 조회 및 Instagram 이동 확인
- [ ] 매칭 알고리즘 변경 시 `PIPELINE_VERSION` 증가와 기존 결과 정리 정책 확인
- [ ] 다중 장소 중간 DB 실패 후 잔여 관계가 없는지 확인
- [ ] Google Places 사진 정책 문제 해결
- [ ] 서비스 약관·개인정보 처리방침·attribution 반영
- [ ] 실패 요청 정리 또는 재시도 UX 결정
