# 여기담 MVP 현재 시스템 설계

- 기준일: 2026-08-10
- 상태: 구현 기준(as-built)
- 대상: iOS 17+, Supabase 프로젝트 `hbbrgudsbvnwuylxqlta`

## 1. 시스템 목표

사용자가 Instagram에서 발견한 장소를 URL 입력 또는 공유 메뉴로 여기담에 전달하면 서버가 릴스 캡션을 읽고 장소를 정규화해 개인 저장 목록에 추가합니다.

설계의 핵심 경계는 다음과 같습니다.

- iOS는 인증, 요청 접수, 결과 조회와 화면 표시를 담당합니다.
- Edge Function은 외부 API 조합과 DB 쓰기를 담당합니다.
- 앱은 `anon` 키와 사용자 JWT만 사용하고, 모든 서버 쓰기는 `service_role`로 수행합니다.
- 사용자별 읽기·삭제 권한은 Postgres RLS가 보장합니다.

## 2. 전체 구조

```mermaid
flowchart LR
    subgraph IOS["iOS 앱"]
        APP["SwiftUI 메인 앱"]
        SHARE["Share Extension"]
        GROUP["App Group 세션 저장소"]
        APP <--> GROUP
        SHARE --> GROUP
    end

    APP -->|"URL + JWT"| FN["save-instagram-reel Edge Function"]
    SHARE -->|"URL + JWT"| FN
    APP -->|"RLS 적용 REST 조회/삭제"| DB[("Supabase Postgres")]

    FN --> IG["Instagram oEmbed / HTML"]
    FN --> GEMINI["Gemini"]
    FN --> NAVER["Naver API HUB 지역 검색"]
    FN --> GOOGLE["Google Places API (New)"]
    FN --> STORAGE["Supabase Storage"]
    FN -->|"service_role"| DB
```

## 3. iOS 구성

### 메인 앱 `Yeogidam`

- `AppState`: Supabase 익명 세션 시작, 복원, 로그아웃
- `SharedSessionStore`: App Group `group.com.yeogidam`에 access/refresh token 공유
- `YeogidamAPI`: Edge Function 호출과 PostgREST 조회·삭제
- `SavedPlacesView`: 완료 장소와 처리 중·실패 릴스 표시
- `AddByURLSheet`: Instagram URL 직접 입력
- `SavedPlaceDetailView`: 사진, 주소, 카테고리, 좌표, Naver 링크 표시

Supabase URL과 `anon` 키는 Xcode build setting을 통해 두 타깃의 `Info.plist`에 주입합니다. `anon` 키는 공개 클라이언트 키이며 권한은 RLS로 제한합니다.

### Share Extension

확장은 공유된 `public.url`을 읽고 Instagram 호스트인지 확인한 후 App Group의 access token으로 Edge Function을 호출합니다. 성공 조건은 최종 장소 저장이 아니라 요청 접수 HTTP `2xx`입니다. 무거운 파싱은 확장에서 수행하지 않습니다.

현재 세션 공유는 Keychain이 아니라 App Group `UserDefaults`입니다. MVP 구현은 단순하지만, 배포 전 Keychain Access Group 기반 저장으로 강화하는 것이 권장됩니다.

## 4. Supabase 구성

### Auth

- MVP: 익명 로그인
- JWT 유효시간: 로컬 기본 1시간
- 익명 사용자 생성 시 `profiles` 행 자동 생성
- 향후 Apple/카카오 계정은 익명 계정 링크 방식으로 확장 가능

### 데이터 모델

```mermaid
erDiagram
    AUTH_USERS ||--|| PROFILES : owns
    AUTH_USERS ||--o{ REELS : submits
    AUTH_USERS ||--o{ SAVED_PLACES : saves
    PLACES ||--o{ REELS : matched_to
    PLACES ||--o{ SAVED_PLACES : referenced_by

    PLACES {
      uuid id PK
      text naver_place_id UK
      text google_place_id
      text name
      text source_address
      text road_address
      float latitude
      float longitude
      text thumbnail_url
      text thumbnail_source
      text photo_attribution
    }
    REELS {
      uuid id PK
      uuid user_id FK
      uuid place_id FK
      text instagram_url
      text processing_status
      text failure_reason
    }
    SAVED_PLACES {
      uuid id PK
      uuid user_id FK
      uuid place_id FK
      text thumbnail_url
    }
```

- `places`: 모든 인증 사용자가 읽는 공용 장소 정규화 결과
- `reels`: 사용자 요청과 처리 상태를 보관
- `saved_places`: 사용자와 장소의 유일한 연결, `(user_id, place_id)` unique
- `provider_usage_monthly`: Google 썸네일 워크플로 예약 횟수

### 권한 경계

| 리소스 | 인증 사용자 | Edge Function `service_role` |
|---|---|---|
| `profiles` | 본인 조회·수정 | 전체 접근 |
| `places` | 전체 조회 | 생성·수정 |
| `reels` | 본인 조회·삭제 | 생성·수정 |
| `saved_places` | 본인 조회·삭제 | 생성·수정 |
| `provider_usage_monthly` | 접근 불가 | 예약 RPC 실행 |
| `place-thumbnails` | 공개 읽기 | 업로드 |

## 5. 외부 제공자 역할

| 제공자 | 역할 | 실패 시 동작 |
|---|---|---|
| Instagram | 캡션과 원본 썸네일 후보 | `IG_FETCH_FAILED` |
| Gemini | 상세주소 Naver 검색 실패 후 비정형 캡션에서 장소명·지역 추출 | `PLACE_NOT_FOUND` |
| Naver API HUB | 장소명, 주소, 카테고리, 좌표 정규화 | `PLACE_NOT_FOUND` |
| Google Places | 대표 사진과 Google Place ID | Instagram/Naver 이미지로 폴백 |
| Supabase Storage | 선택된 썸네일 저장 | 이미지 없이 장소 저장 가능 |

## 6. 비동기 처리 모델

Edge Function은 인증과 입력 검증 후 `reels(PROCESSING)`을 먼저 생성하고 HTTP `202`를 반환합니다. 실제 추출은 `EdgeRuntime.waitUntil()`에서 계속됩니다.

앱은 저장 직후 `saved_places`와 `reels`를 다시 조회합니다. 현재 Realtime 구독과 자동 polling은 없으며 화면 진입 또는 당겨서 새로고침으로 갱신합니다.

## 7. 구현 상태

### 완료

- 익명 인증과 RLS
- URL 직접 입력과 Share Extension
- Instagram 캡션 다단계 추출
- 층·동·호 포함 상세주소 우선 검색과 Gemini·Naver 장소명 폴백
- 장소와 사용자 저장 데이터 분리
- Google Places 썸네일, 제공자 폴백, Storage 업로드
- 월간 DB hard cap과 Google Cloud 일일 quota
- 저장 목록, 상세, 삭제, 처리 실패 표시

### 미완료

- Naver 지도 실제 화면
- Apple/카카오 로그인과 익명 계정 링크
- Share Extension의 만료 토큰 자체 갱신
- Realtime 또는 polling 기반 자동 완료 반영
- 실패 요청 재시도·삭제 UI
- 운영용 구조화 로그 대시보드와 경보
- 개인정보 처리방침·서비스 약관·Google attribution 완성

## 8. 주요 기술 부채

1. Instagram의 내부 oEmbed 응답 형식은 변경될 수 있으므로 회귀 테스트와 실패 관측이 필요합니다.
2. Share Extension은 access token 만료 시 사용자에게 앱 실행을 요청하며 자체 refresh를 하지 않습니다.
3. 외부 이미지 업로드 실패는 장소 저장을 막지 않지만, 일부 DB update 오류도 현재 best-effort로 처리됩니다.
4. Google Places 사진 재호스팅은 현행 Google Maps Platform 저장 제한과 충돌할 수 있습니다. 프로덕션 출시 전에 [운영 가이드](deployment-and-operations.md)의 정책 항목을 해결해야 합니다.
