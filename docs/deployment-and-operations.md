# 배포 및 운영 가이드

- 기준일: 2026-08-10
- 대상: Supabase Cloud + iOS/Xcode

## 1. 사전 요구 사항

- Supabase CLI 로그인 및 프로젝트 link
- Docker Desktop 또는 호환 Docker 런타임
- Xcode 26+, XcodeGen
- Apple Developer 계정과 App Group 사용 권한
- Google Cloud Places API (New)
- Kakao Developers 앱과 Local API REST API 키
- Gemini API key

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
GEMINI_API_KEY
GEMINI_MODEL                 선택, 기본 gemini-3.5-flash-lite
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
  GEMINI_API_KEY=... \
  KAKAO_REST_API_KEY=... \
  GOOGLE_PLACES_API_KEY=... \
  --project-ref hbbrgudsbvnwuylxqlta
```

키 값을 문서, Git, 앱 번들에 넣지 않습니다. iOS에 포함되는 Supabase `anon` 키는 공개 클라이언트 키이며 `service_role` 키와 다릅니다.

## 4. 로컬 Supabase

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

## 5. DB와 Function 배포

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
5. 사진·주소·Kakao 장소 링크 확인
6. 장소 삭제와 RLS 격리 확인

## 8. 비용 방어

### 애플리케이션 레벨

- `places.thumbnail_url`이 있으면 외부 사진 API를 다시 호출하지 않습니다.
- `reserve_google_places_thumbnail()`은 UTC 월 기준 900회까지만 원자적으로 예약합니다.
- 900회를 넘으면 Instagram, Kakao, placeholder 순으로 폴백합니다.
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
- `reels.instagram_title`, `instagram_description` 존재 여부
- `places.thumbnail_source`, `google_place_id`
- `provider_usage_monthly.request_count`
- Storage `place-thumbnails` 업로드 성공 여부

### 실패 분류

| 현상 | 확인 순서 |
|---|---|
| 요청 즉시 401 | 앱 JWT 만료, Share Extension App Group 세션 |
| `IG_FETCH_FAILED` | oEmbed/HTML 응답 상태, Instagram 형식 변경 |
| `PLACE_NOT_FOUND` | Gemini 다중 장소, 원문 검증, Kakao API status·itemCount·verifiedCount |
| `UNKNOWN` | places upsert와 DB 제약, Function exception log |
| 사진만 없음 | 월 예약 한도, Google quota, Storage upload, 폴백 URL |

Edge Function은 Instagram fetch, Gemini 구조화, Kakao 검색·후보 검증 결과를 JSON 로그로 남깁니다. Supabase Dashboard의 Edge Function Logs와 API Gateway Logs를 함께 확인합니다.

## 11. 릴리스 체크리스트

- [ ] DB migration과 pgTAP 통과
- [ ] Deno 테스트·format·typecheck 통과
- [ ] Edge Function 배포 상태 `ACTIVE`
- [ ] Function secrets 등록 및 테스트
- [ ] Kakao Local API 실제 후보의 `id`·`place_url` 확인
- [ ] Anonymous sign-in 활성화
- [ ] Google API key restriction과 quota 확인
- [ ] Apple Team과 App Group provisioning 확인
- [ ] 실기기 Share Extension E2E 통과
- [ ] Google Places 사진 정책 문제 해결
- [ ] 서비스 약관·개인정보 처리방침·attribution 반영
- [ ] 실패 요청 정리 또는 재시도 UX 결정
