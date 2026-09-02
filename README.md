# 여기담 (Yeogidam)

Instagram 릴스에서 발견한 장소를 추출해 개인 장소 목록에 저장하는 iOS MVP입니다.

현재 MVP는 SwiftUI 앱과 Share Extension, Supabase Auth/Postgres/Storage/Edge Functions로 구성됩니다. 인증은 익명 로그인을 사용하며, 환경변수로 선택한 장소 AI(Gemini 또는 OpenAI)가 릴스 캡션의 여러 장소와 주소를 구조화하고 Kakao Local API로 검증·정규화합니다.

## 현재 구현 범위

- 익명 로그인 및 Supabase 세션 복원
- 릴스 URL 직접 입력
- Instagram Share Extension
- 비동기 장소 추출 및 처리 상태 표시
- Kakao 장소 ID 기반 장소 저장과 다중 장소 처리
- Google Places 대표 사진 조회 및 썸네일 폴백
- 저장 장소 목록, 상세 화면, 삭제
- RLS, Storage, 외부 API 사용량 제한

지도 화면과 Apple/카카오 로그인은 아직 구현 전입니다.

## 문서

- [문서 인덱스](docs/README.md)
- [현재 시스템 설계](docs/architecture.md)
- [릴스 저장 구현 플로우](docs/save-instagram-reel-flow.md)
- [배포 및 운영 가이드](docs/deployment-and-operations.md)
- [초기 MVP 설계안](docs/superpowers/specs/2026-08-09-yeogidam-mvp-design.md)

## 빠른 검증

```bash
# Edge Function 단위 테스트와 타입 검사
npx -y deno@2 test supabase/functions/save-instagram-reel/*_test.ts
npx -y deno@2 test supabase/functions/app-update-policy/*_test.ts
npx -y deno@2 check supabase/functions/save-instagram-reel/index.ts
npx -y deno@2 check supabase/functions/app-update-policy/index.ts

# 로컬 Supabase DB 테스트
supabase start
supabase db test

# Xcode 프로젝트 재생성 및 시뮬레이터 빌드
cd ios
xcodegen generate
xcodebuild -project Yeogidam.xcodeproj \
  -scheme Yeogidam \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

실제 API 키는 `supabase/functions/.env` 또는 Supabase Function Secrets에만 저장합니다. `SUPABASE_ANON_KEY`는 클라이언트 공개 키이며, `service_role` 키와 외부 API 키는 앱에 포함하지 않습니다.

## 커밋 컨벤션

커밋 메시지는 AngularJS 형식의 `<type>(<scope>): <한글 요약>`을 사용합니다. `scope`는 생략할 수 있으며 한글을 원칙으로 합니다. 주요 `type`은 `feat`, `fix`, `docs`, `refactor`, `test`, `chore`입니다.

```text
feat(장소): 카카오 장소 ID 기반 중복 방지 추가
fix(인스타그램): HTML 메타데이터를 캡션 1순위로 변경
docs: 장소 매칭 출시 보고서 갱신
```
