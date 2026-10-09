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
- Gemini API key와 캡션·미디어 분석을 지원하는 Gemini 모델

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
GEMINI_API_KEY               필수, Gemini 단일 API key
GEMINI_MODEL                 필수, 캡션·미디어에 같은 모델 사용
KAKAO_REST_API_KEY
GOOGLE_PLACES_API_KEY
PUBLIC_SUPABASE_URL          선택, Storage 공개 URL 기준
APP_UPDATE_IOS_MINIMUM_SUPPORTED_VERSION
APP_UPDATE_IOS_STORE_URL
APP_UPDATE_ANDROID_MINIMUM_SUPPORTED_VERSION  Android 배포 후 설정
APP_UPDATE_ANDROID_STORE_URL                  Android 배포 후 설정
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
  GEMINI_API_KEY=... \
  GEMINI_MODEL=gemini-3.5-flash-lite \
  KAKAO_REST_API_KEY=... \
  GOOGLE_PLACES_API_KEY=... \
  --project-ref hbbrgudsbvnwuylxqlta
```

키 값을 문서, Git, 앱 번들에 넣지 않습니다. iOS에 포함되는 Supabase `anon` 키는 공개 클라이언트 키이며 `service_role` 키와 다릅니다.

### 앱 업데이트 정책

`app-update-policy` Function은 앱이 로그인하기 전에도 호출하는 공개 API다.
현재 앱 버전이 플랫폼별 최소 지원 버전보다 낮으면 `updateRequired=true`를
반환한다. 정책은 프로젝트별 Function Secret으로 관리해 함수를 재배포하지
않고도 바꿀 수 있다.

```bash
supabase secrets set \
  APP_UPDATE_IOS_MINIMUM_SUPPORTED_VERSION=1.1.0 \
  APP_UPDATE_IOS_STORE_URL=https://apps.apple.com/app/id6801408355 \
  --project-ref vowmaqcmwocrocfymyux
```

운영의 최소 지원 버전은 App Store에서 해당 버전을 실제로 다운로드할 수
있는지 확인한 뒤에만 다음과 같이 올린다.

```bash
supabase secrets set \
  APP_UPDATE_IOS_MINIMUM_SUPPORTED_VERSION=1.1.0 \
  APP_UPDATE_IOS_STORE_URL=https://apps.apple.com/app/id6801408355 \
  --project-ref hbbrgudsbvnwuylxqlta
```

Android는 Play Store 배포 후 같은 형식의 `APP_UPDATE_ANDROID_*` 값을
등록한다. 요청한 플랫폼의 정책이 누락되거나 잘못되면 HTTP 503을
반환하므로 앱은 조회 장애 시 진입을 차단하지 않는다. `ios`, `android`
외의 플랫폼 값은 HTTP 400을 반환한다.

이 API 호출 로직이 없는 기존 앱에는 소급해서 강제 업데이트를 표시할
수 없다. 업데이트 조회가 처음 포함된 버전부터 이후 버전의 강제 전환을
제어할 수 있다.

API 요청과 응답 계약은 다음과 같다. `appVersion`은 `major.minor` 또는
`major.minor.patch` 형식이다.

```http
GET /functions/v1/app-update-policy?platform=ios&appVersion=1.0
```

```json
{
  "updateRequired": true,
  "minimumSupportedVersion": "1.1.0",
  "storeUrl": "https://apps.apple.com/app/id6801408355"
}
```

### 장소 분석 설정

분석 버전 11은 `2026-Yeogidam`의 Gemini 단일 key/model 방식을 사용한다.
`GEMINI_API_KEY`와 `GEMINI_MODEL`을 모두 등록해야 한다. 값이 없으면 기존
`PROVIDER_CONFIG_MISSING` 실패 코드로 처리한다. 모델 기본값은 없다.

캡션 분석은 Interactions API와 URL Context, 미디어 분석은 Files API와
`generateContent`를 사용한다. 사용할 모델이 이 요청 형식을 지원하는지
배포 환경에서 확인한다. 요청 제한은 캡션 20초, 미디어 관련 HTTP 120초,
원본 다운로드 30초, 카카오 5초다. 업로드 파일의 준비 대기는 최대 2분이다.

기존 `PLACE_AI_*`, `GEMINI_API_KEY_FALLBACKS`, `GEMINI_MATCH_MODEL`, `OPENAI_*`
secret이 남아 있어도 새 장소 분석 경로는 사용하지 않는다. 공급자 전환이나
key fallback으로 원본과 다른 분석 흐름을 만들지 않는다.

미디어 원본은 `/tmp`에 스트리밍으로 저장하며 파일당 100MiB, 전체 200MiB,
최대 20개로 제한한다. 업로드는 최대 8MiB의 조각으로 나눠 Content-Length와
resumable offset을 보존한다. 성공·실패 시 로컬 파일과 Gemini 업로드 파일을 정리한다.
백그라운드 처리도 Supabase worker의 실행 시간 제한을 넘길 수 없으므로 긴 영상과
많은 캐러셀 항목은 배포 환경에서 검증해야 한다.

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
supabase functions deploy app-update-policy \
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
supabase functions deploy app-update-policy \
  --no-verify-jwt \
  --project-ref hbbrgudsbvnwuylxqlta
```

개발·QA 배포 후 확인:

```bash
supabase migration list
supabase functions list --project-ref vowmaqcmwocrocfymyux
```

Function 목록에서 `save-instagram-reel`, `save-instagram-reel-v2`,
`gemini-quota-discord`, `app-update-policy`가 모두 `ACTIVE`인지 확인한다.
QA 앱과 Share Extension은
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
  supabase/functions/save-instagram-reel-v2 \
  supabase/functions/app-update-policy
npx -y deno@2 test supabase/functions/save-instagram-reel/*_test.ts
npx -y deno@2 test supabase/functions/app-update-policy/*_test.ts
npx -y deno@2 check supabase/functions/save-instagram-reel/index.ts
npx -y deno@2 check supabase/functions/save-instagram-reel-v2/index.ts
npx -y deno@2 check supabase/functions/app-update-policy/index.ts
```

### DB

```bash
supabase db test
```

### 구버전 관련 릴스 HTTP 회귀 테스트

`20260905090000_legacy_related_reels_compat.sql`은 데이터를 변경하지 않고
`reels → reel_places` embedding을 `user_related_reels`에 연결한다.
PostgREST computed relationship으로 기존 FK 관계를 덮어쓰는 방식이며,
마이그레이션 끝에서 schema cache reload를 요청한다.

- [PostgREST computed relationship 공식 문서](https://docs.postgrest.org/en/v14/references/api/resource_embedding.html#overriding-relationships)
- DB 검증: `supabase/tests/10_legacy_related_reels.sql`
- HTTP 검증: `supabase/scripts/test-legacy-related-reels-http.mjs`

SQL 테스트만으로는 PostgREST의 관계 선택과 `!inner` 필터를 검증할 수 없으므로
실제 HTTP 테스트를 함께 실행한다. 테스트 대상은 애플리케이션 마이그레이션과
Supabase `auth`/`storage` 스키마가 준비된 **폐기 가능한 로컬 전용 DB**와 그 DB에
연결한 PostgREST다. 아래 이름의 DB를 미리 만들고, 서버의 JWT secret과 같은
로컬 테스트 전용 값을 지정한다. 운영 secret은 사용하지 않는다.

```bash
POSTGRES_TEST_URL=postgresql://postgres@127.0.0.1:55432/yeogidam_compat_test \
POSTGREST_TEST_URL=http://127.0.0.1:55433 \
POSTGREST_TEST_JWT_SECRET=local-only-compat-test-secret-at-least-32-chars \
PSQL_BINARY=/path/to/psql \
node --test supabase/scripts/test-legacy-related-reels-http.mjs
```

이 스크립트는 loopback 주소와 `yeogidam_compat_test` 또는
`yeogidam_compat_test_*` 이름의 DB만 허용한다. 임의 UUID의 테스트 사용자·장소를
만들고 종료 시 해당 자료만 삭제하며, 마이그레이션을 실행하거나 기존 테이블을
비우지 않는다. 구버전 프론트의 실제 select/filter를 그대로 사용해 다음을 검증한다.

- 다른 사용자의 완료 캐시 및 진행 중 분석을 재사용한 요청의 관련 릴스 조회
- 재공유 시 최신 성공 요청 한 건만 표시하고 신규 조회와 결과가 일치하는지
- 작성자·캡션·썸네일과 보관함 자동 저장 유지
- 사용자 격리, 익명 요청 거부, 장소 필터와 `!inner` 동작
- 기존 자료 조회, stale worker 결과 제외, 물리 worker 기록 보존

개발 환경에서 구버전 앱으로 URL 저장·인스타 공유·보관함·장소 상세를 확인한 뒤
운영에 적용한다. **DB migration → 업데이트된 v1 → v2** 배포 순서는 유지한다.
계산 관계만 되돌릴 때는 `public.reel_places(public.reels)` 함수를 제거하고
PostgREST schema cache를 다시 로드하면 기존 FK 조회로 돌아간다. 이 경우
재사용 요청의 구버전 관련 릴스 누락도 다시 발생한다. 반복 요청 데이터가 생긴
뒤 저장 함수 전체를 예전 main으로 되돌리는 것은 별도 문제이므로, 이를 안전한
전체 서버 롤백 절차로 취급하지 않는다.

#### 2026-09-05 로컬 검증 기록

- PostgreSQL 17.11 / PostgREST 16.2 / pgTAP 1.3.4의 격리된 로컬 환경에서 검증했다.
- 수정 전에는 다른 사용자의 진행 중·완료 결과를 재사용한 요청의 관련 릴스가
  누락됐고, 인계된 worker의 이전 중간 결과가 조회되는 문제도 재현했다.
- 수정 후 구버전 HTTP 조회 10개 시나리오가 모두 통과했다. 동일 테스트에서
  신규 `user_related_reels` 조회와 보관함 조회가 유지되는 것도 확인했다.
- DB 테스트 11개 파일의 assertion 236개와 Edge Function 단위 테스트 248개가
  모두 통과했다. 조회 전후 worker·요청·추출·보관함·대기함 데이터가 동일했다.
- 로컬 `auth`/`storage`는 DB 테스트용 최소 스키마로 구성했다. 실제 Supabase
  Auth·Storage HTTP 서비스, Edge Runtime, 운영 JWT 설정과 실기기 앱은 검증하지
  않았으며 운영 DB에도 적용하지 않았다. 운영 승격 전 개발 프로젝트에서
  기존 앱으로 확인하는 절차는 별도로 필요하다.

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
| `COMPLETED`인데 일부 장소가 없음 | 캡션 장소 수와 추출 단서, 장소별 유효 후보 수·저장 작업 상태, `reel_places.position` |
| 같은 릴스를 다시 보내도 재처리 안 됨 | 같은 사용자 shortcode 캐시, processing version, 기존 `reel_places` 복원 여부 |
| 알고리즘 배포 후 기존 릴스 결과가 그대로임 | `PIPELINE_VERSION`을 올렸는지 확인. 같은 버전의 완료 결과는 정상적으로 캐시됨 |
| `FAILED/UNKNOWN`인데 일부 장소가 목록에 보임 | 다중 장소 비트랜잭션 저장 중 뒤 항목 실패 여부, 남은 `saved_places`·`reel_places` 확인 |
| 장소 상세에 관련 릴스가 없음 | 릴스 상태 `COMPLETED`, `reel_places` 연결, 해당 릴스의 `user_id`, RLS 정책 배포 여부 |

Edge Function은 Instagram 조회, `source_place_hints_extracted`의 추출 단서,
`source_kakao_search`의 검색어·후보 수, `reel_processing_failed`의 처리 오류를
JSON 로그로 남긴다. 새 분석 경로는 기존 `ai_provider_*`,
`ai_place_guesses_sanitized`, `ai_candidate_selection_guarded` 로그를 생성하지 않는다.

저장 개수가 예상보다 적으면 다음 순서로 확인한다.

1. 캡션과 작성자 정보를 확인한다. `with_sol_mate`는 처음부터 통합 분석한다.
2. 추출 단서에 예상 장소가 포함됐는지, 위치 출처와 보정명이 올바른지 확인한다.
3. 장소별 검색어와 유효 후보 수를 확인한다. 결과가 없으면 이름만으로 재검색한다.
4. 첫 유효 결과 선택과 카카오 ID 중복 제거 후 저장된 `reel_places.position`을 확인한다.
5. 파일 업로드·다운로드·응답 오류는 처리 실패 로그를 확인한다.

애플리케이션 장소 개수 상한은 없지만 선택한 모델이 게시물의 모든 장소를
항상 반환하지는 않는다. 캡션·미디어의 장소와 추출 단서를 비교한다.
`reel_places.position`은 성공한 결과의 압축 순서이므로 원문의 절대 순번을
나타내지 않는다. 같은 카카오 ID로 선택된 장소는 하나만 저장한다.

## 11. 릴리스 체크리스트

- [ ] DB migration과 pgTAP 통과
- [ ] Deno 테스트·format·typecheck 통과
- [ ] DB migration → 업데이트된 v1 → v2 순서로 배포
- [ ] `save-instagram-reel`, `save-instagram-reel-v2`, `gemini-quota-discord` 배포 상태 `ACTIVE`
- [ ] 개발 프로젝트의 `gemini-quota-discord`는 배포만 유지하고 Discord secret·Monitoring 연결·시험 호출은 하지 않았는지 확인
- [ ] 릴스 처리 Function secrets 등록 및 테스트 (개발 Discord secret 제외)
- [ ] `GEMINI_API_KEY`, `GEMINI_MODEL`이 모두 등록됐는지 확인
- [ ] Gemini key/model 변경 후 캡션·미디어 분석과 URL Context 요청이 정상인지 확인
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
