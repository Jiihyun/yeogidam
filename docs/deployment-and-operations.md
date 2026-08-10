# 배포 및 운영 가이드

- 기준일: 2026-08-10
- 대상: Supabase Cloud + iOS/Xcode

## 1. 사전 요구 사항

- Supabase CLI 로그인 및 프로젝트 link
- Docker Desktop 또는 호환 Docker 런타임
- Xcode 26+, XcodeGen
- Apple Developer 계정과 App Group 사용 권한
- Google Cloud Places API (New)
- Naver API HUB 지역 검색 애플리케이션
- Gemini API key

## 2. 환경변수와 비밀값

Edge Function에 필요한 사용자 설정 secret:

```text
GEMINI_API_KEY
GEMINI_MODEL                 선택, 기본 gemini-2.0-flash
NAVER_SEARCH_CLIENT_ID
NAVER_SEARCH_CLIENT_SECRET
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
  GEMINI_API_KEY=... \
  NAVER_SEARCH_CLIENT_ID=... \
  NAVER_SEARCH_CLIENT_SECRET=... \
  GOOGLE_PLACES_API_KEY=... \
  --project-ref hbbrgudsbvnwuylxqlta
```

키 값을 문서, Git, 앱 번들에 넣지 않습니다. iOS에 포함되는 Supabase `anon` 키는 공개 클라이언트 키이며 `service_role` 키와 다릅니다.

## 3. 로컬 Supabase

```bash
supabase start
supabase db reset
supabase db test
```

Edge Function 로컬 실행:

```bash
cp supabase/functions/.env.example supabase/functions/.env
supabase functions serve save-instagram-reel \
  --env-file supabase/functions/.env
```

외부 키 없이 파이프라인 구조만 검증하려면 로컬 환경에서만 `STUB_PROVIDERS=1`, 최종 상태를 응답으로 받으려면 `PIPELINE_SYNC=1`을 사용합니다. 두 값은 프로덕션 secret으로 등록하지 않습니다.

## 4. DB와 Function 배포

```bash
supabase link --project-ref hbbrgudsbvnwuylxqlta
supabase db push
supabase functions deploy save-instagram-reel \
  --project-ref hbbrgudsbvnwuylxqlta
```

배포 후 확인:

```bash
supabase migration list
supabase functions list --project-ref hbbrgudsbvnwuylxqlta
```

Supabase Dashboard에서 Anonymous sign-ins가 활성화되어 있어야 합니다.

## 5. iOS 프로젝트 생성과 서명

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

## 6. 검증 명령

### Edge Function

```bash
npx -y deno@2 fmt --check supabase/functions/save-instagram-reel
npx -y deno@2 test supabase/functions/save-instagram-reel/*_test.ts
npx -y deno@2 check supabase/functions/save-instagram-reel/index.ts
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
5. 사진·주소·Naver 링크 확인
6. 장소 삭제와 RLS 격리 확인

## 7. 비용 방어

### 애플리케이션 레벨

- `places.thumbnail_url`이 있으면 외부 사진 API를 다시 호출하지 않습니다.
- `reserve_google_places_thumbnail()`은 UTC 월 기준 900회까지만 원자적으로 예약합니다.
- 900회를 넘으면 Instagram, Naver, placeholder 순으로 폴백합니다.
- RPC는 `service_role`만 실행할 수 있습니다.

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

## 8. Google Places 정책 주의

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
5. Naver 지도와 Google Places 콘텐츠를 함께 표시하는 방식의 적합성 검토

정책 검토가 끝나기 전 현재 사진 저장 방식은 내부 MVP 검증용으로만 취급합니다.

## 9. 운영 관측과 장애 대응

### 확인할 데이터

- `reels.processing_status`, `failure_reason`
- `reels.instagram_title`, `instagram_description` 존재 여부
- `places.thumbnail_source`, `google_place_id`
- `provider_usage_monthly.request_count`
- Storage `place-thumbnails` 업로드 성공 여부

### 실패 분류

| 현상 | 확인 순서 |
|---|---|
| 요청 즉시 401 | 앱 JWT 만료, Share Extension App Group 세션 |
| `IG_FETCH_FAILED` | oEmbed/HTML 응답 상태, Instagram 형식 변경 |
| `PLACE_NOT_FOUND` | 추출 상세주소, Gemini 장소명·지역, Naver API status·itemCount |
| `UNKNOWN` | places upsert와 DB 제약, Function exception log |
| 사진만 없음 | 월 예약 한도, Google quota, Storage upload, 폴백 URL |

Edge Function은 Instagram fetch 실패와 Naver 검색 결과를 JSON 로그로 남깁니다. Supabase Dashboard의 Edge Function Logs와 API Gateway Logs를 함께 확인합니다.

## 10. 릴리스 체크리스트

- [ ] DB migration과 pgTAP 통과
- [ ] Deno 테스트·format·typecheck 통과
- [ ] Edge Function 배포 상태 `ACTIVE`
- [ ] Function secrets 등록 및 테스트
- [ ] Anonymous sign-in 활성화
- [ ] Google API key restriction과 quota 확인
- [ ] Apple Team과 App Group provisioning 확인
- [ ] 실기기 Share Extension E2E 통과
- [ ] Google Places 사진 정책 문제 해결
- [ ] 서비스 약관·개인정보 처리방침·attribution 반영
- [ ] 실패 요청 정리 또는 재시도 UX 결정
