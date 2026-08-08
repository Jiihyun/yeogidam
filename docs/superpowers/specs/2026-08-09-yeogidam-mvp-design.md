# 여기담 iOS MVP — 시스템 설계안

- 작성일: 2026-08-09
- 상태: 설계 확정 (구현 계획 수립 전)
- 범위: 인스타그램 릴스 → 장소 자동 저장 MVP

---

## 0. 개요

인스타그램 릴스에서 발견한 장소를 **공유 버튼 한 번**으로 내 지도에 저장하는 iOS 앱.
사용자는 릴스 URL 외에 아무것도 입력하지 않는 것을 목표로 한다.

핵심 플로우:
```
인스타 릴스 → 공유 → 여기담 선택 → (백그라운드) 장소 추출·매칭 → 지도/목록에 자동 저장
```

---

## 1. 확정된 기술 스택 결정

| 항목 | 결정 | 비고 |
|------|------|------|
| 백엔드 | **지금은 Supabase, 나중에 Spring** | MVP는 Supabase Edge Functions. Edge Function 경계를 얇게 유지해 추후 Spring 포팅 용이하게 |
| 인증 | Supabase Auth — **MVP는 익명 인증**, 카카오/Apple은 후순위 | 별도 인증 서버 없음. 익명 세션도 실제 JWT/`auth.uid()`를 제공하므로 RLS·토큰 공유 구조 동일 |
| DB | Supabase Postgres + RLS | |
| 파일 저장 | Supabase Storage | 썸네일 재호스팅 용도 |
| 서버 로직 | Supabase Edge Functions (Deno/TS) | `save-instagram-reel` |
| 지도 | **네이버 지도 iOS SDK** | NCP client ID 필요 (Phase 6 전까지) |
| AI | **Gemini** | 캡션 → 장소명 추출, 구조화된 JSON |
| 장소 검색 | 네이버 지역검색 API | 좌표(mapx/mapy TM128) 제공, 이미지 미제공 |
| iOS | Swift + SwiftUI + Share Extension | |

### 확정된 정책 결정
- **인스타그램 수집 전략: 최선 시도 + 실패는 정직하게(FAILED) 처리.** 무리한 우회 없음.
- **네이버 대표 이미지: 베스트에포트 스크래핑 + 폴백 포함.** (공식 API로는 불가 → `m.place.naver.com` og:image 스크래핑, 실패 시 폴백)
- **썸네일 Storage 재호스팅 도입.** (IG/네이버 CDN URL 만료 방지)
- **중복 저장: 에러 아님.** 같은 장소를 다른 릴스로 또 저장하면 장소 상세에 릴스만 누적 (1 장소 : N 릴스).
- **avatars 버킷 생략.** 소셜 로그인 프로필 이미지 URL을 그대로 사용.
- **지도 탭은 뒤로 미룸.** 네이버 NCP 키 준비 후 Phase 6에서 구현.
- **소셜 로그인은 후순위.** 빠른 개발을 위해 MVP는 **Supabase 익명 인증**으로 시작(로그인 화면 = "시작하기" 버튼). 익명 세션도 실제 JWT를 발급하므로 RLS·Share Extension 토큰 공유·Edge Function이 최종 설계와 동일하게 동작. 카카오/Apple은 나중에 익명 계정 **링크**로 추가(구조 변경 없음).

---

## 2. 저장소 현황 (설계 시점)

- 깃에 추적되는 것: 빈 `README.md` 3개(`/`, `Frontend/`, `Backend/`).
- `Backend/`에 Gradle 캐시와 빈 `src/main/java/com/yeogidam` 폴더가 있으나 `build.gradle`·소스 없음 = 사실상 빈 뼈대.
- 이 iOS MVP는 신규로 구성한다. `Backend/` 폴더는 추후 Spring 포팅용 자리로 남겨둔다.
- 커밋 컨벤션: AngularJS 스타일 (`feat/refactor/fix/style/test/docs/chore/build`).

---

## 3. 전체 시스템 아키텍처

```
┌─────────────────────── iOS (한 앱, 두 타깃) ───────────────────────┐
│  [메인 앱 · SwiftUI]              [Share Extension · 가볍게]         │
│   - 로그인(카카오/Apple)            - 공유된 URL 검증                  │
│   - 저장됨/지도/마이 탭              - 공유 세션(JWT) 읽기             │
│   - URL 직접 입력                   - Edge Function 호출 후 즉시 종료  │
│        └──────────┬───────────────────────┘                        │
│                   │  (App Group + 공유 Keychain 으로 세션 공유)       │
└───────────────────┼────────────────────────────────────────────────┘
                    │  HTTPS + Authorization: Bearer <supabase jwt>
                    ▼
        ┌───────────────────────────────────────────┐
        │  Supabase Edge Function                     │
        │  POST /functions/v1/save-instagram-reel     │
        │   1) JWT 인증 → user 확인                    │
        │   2) IG URL 검증                             │
        │   3) reels(PROCESSING) 즉시 insert           │
        │   4) 202 응답 반환 (빠르게)                   │
        │   5) waitUntil() 로 백그라운드 파이프라인 계속 │
        └───────────────────────────────────────────┘
                    │ (백그라운드)
     ┌──────────────┼───────────────┬───────────────┬──────────────┐
     ▼              ▼               ▼               ▼              ▼
 Instagram      정규식 주소       Gemini          Naver          Supabase
 공개 HTML  →   추출(코드)   →   장소명 추출  →   지역검색+좌표 →  Storage
 (og:*)         (1순위)         (2순위, 필요시)   변환/지오코딩   (썸네일 재호스팅)
                    │
                    ▼
        places upsert · saved_places upsert · reels = COMPLETED (또는 FAILED)
                    │
                    ▼  (앱을 다음에 열면)
        메인 앱이 Supabase에서 직접 조회 (RLS 필터) → 목록/지도 표시
```

### 핵심 설계 원칙
- Share Extension은 **저장 요청만** 하고 즉시 종료 (무거운 파싱·AI 호출 없음).
- Edge Function은 **PROCESSING 행을 먼저 만들고 202를 빠르게 반환**한 뒤 `EdgeRuntime.waitUntil()`로 나머지 처리를 이어감 (비동기).
- iOS는 "URL 하나 던지고 결과는 DB에서 읽는다"는 얇은 계약만 유지 → 추후 Spring 포팅 시 Edge Function만 교체.

---

## 4. 인증 토큰 공유 (Share Extension ↔ 앱)

Share Extension은 별도 프로세스라 앱 세션을 직접 못 본다.
- **App Group**(`group.com.yeogidam`) + **Keychain 공유 그룹** 구성.
- 메인 앱이 로그인 성공 시 Supabase 세션(access/refresh 토큰)을 공유 Keychain에 저장.
- Share Extension이 그것을 읽어 `Authorization: Bearer`로 Edge Function 호출.
- 토큰 만료(401) 시 refresh 토큰으로 1회 갱신, 그래도 실패면 "여기담 앱에서 로그인해 주세요" 안내 후 종료.

---

## 5. 정직하게 짚은 기술적 한계 (설계 반영됨)

1. **네이버 지역검색 API는 대표 이미지를 주지 않는다.**
   → 공식 API만으로 "썸네일 1순위 = 네이버 이미지"는 불가.
   → **베스트에포트**: 지역검색으로 placeId 확보 → `m.place.naver.com/place/{id}/home`의 `og:image` 스크래핑. 실패 시 폴백.
   → placeId 확보: (a) 지역검색 `link`에서 파싱, (b) 없으면 비공식 검색 엔드포인트 조회. **비공식·비문서화라 깨질 수 있음.**
2. **IG/네이버 CDN 썸네일 URL은 만료된다.**
   → 선택된 썸네일을 다운로드해 Supabase Storage(`place-thumbnails`)에 재호스팅하고 그 안정적 URL을 저장.
3. **네이버 지역검색 좌표는 mapx/mapy(TM128).**
   → WGS84(위도/경도)로 변환해 지도에 사용. 변환이 애매하면 지오코딩 API 폴백.

### 최종 썸네일 우선순위 (기획서 유지)
```
네이버 대표 이미지 (베스트에포트 스크래핑)
   ↓ 없으면
Instagram og:image
   ↓ 없으면
여기담 로고
```

---

## 6. DB 스키마 (Supabase Postgres)

원칙: **장소 데이터(`places`, 공용)** 와 **사용자 저장 데이터(`saved_places`, 개인)** 분리.
릴스(저장 요청)와 저장한 장소를 분리해 1 장소 : N 릴스 관계를 표현.

### `profiles` — auth.users 미러
```
id            uuid   PK, FK→auth.users(id)
nickname      text
description   text
avatar_url    text          ← 소셜 로그인 프로필 URL 그대로
created_at    timestamptz
updated_at    timestamptz
```

### `places` — 공용 장소 (Edge Function만 쓰기)
```
id                   uuid   PK (gen_random_uuid)
naver_place_id       text   UNIQUE   ← 중복 방지 자연키
name                 text   NOT NULL
category             text
road_address         text
address              text
latitude             double precision   ← TM128→WGS84 변환값
longitude            double precision
naver_link           text               ← "네이버 플레이스에서 보기"
naver_thumbnail_url  text               ← 베스트에포트로 얻은 원본(참고)
telephone            text
created_at           timestamptz
```

### `reels` — 공유 요청 1건 = 1행 (처리 상태 보유)
```
id                      uuid PK
user_id                 uuid FK→auth.users NOT NULL
place_id                uuid FK→places  NULL 허용(매칭 전)
instagram_url           text NOT NULL
instagram_title         text
instagram_description   text
instagram_thumbnail_url text            ← 이 릴스의 og:image
source                  text ('instagram_share'|'url_input')
processing_status       text ('PENDING'|'PROCESSING'|'COMPLETED'|'FAILED')
failure_reason          text NULL ('IG_FETCH_FAILED'|'PLACE_NOT_FOUND'|'UNKNOWN')
created_at              timestamptz
updated_at              timestamptz
```

### `saved_places` — 사용자가 저장한 장소 (장소당 1행)
```
id            uuid PK
user_id       uuid FK→auth.users NOT NULL
place_id      uuid FK→places NOT NULL
thumbnail_url text            ← 카드용 최종 대표 이미지(Storage URL)
created_at    timestamptz

UNIQUE (user_id, place_id)
```

### 저장 흐름
```
릴스 공유 → reels(PROCESSING) 생성
   → 장소 매칭 → places upsert (naver_place_id 기준)
   → saved_places (user_id, place_id) upsert   ← 이미 있으면 그 행 재사용
   → reels.place_id 연결 + COMPLETED
```
- 같은 장소를 또 저장하면 `saved_places`는 그대로, `reels`만 추가.
- **장소 상세**의 "저장한 릴스"는 `reels WHERE user_id & place_id` 전부 표시.

### 저장됨 탭 리스트 = 세 종류 카드의 합집합
- 완료된 장소(`saved_places`) → 일반 카드
- 처리 중 릴스(`reels` PROCESSING, place 아직 없음) → "장소를 찾고 있어요…" 카드
- 실패 릴스(`reels` FAILED) → 실패 카드

### Storage
- `place-thumbnails` (public read) — Edge Function이 썸네일 재호스팅. `saved_places.thumbnail_url`이 여기를 가리킴.
- `avatars` — 생략 (소셜 프로필 URL 사용).

### RLS 정책
| 테이블 | SELECT | INSERT | UPDATE | DELETE |
|--------|--------|--------|--------|--------|
| `profiles` | 본인(`auth.uid()=id`) | 가입 트리거 | 본인 | ✕ |
| `places` | 인증 사용자 전체(공개) | ✕(서버만) | ✕(서버만) | ✕ |
| `reels` | 본인(`auth.uid()=user_id`) | ✕(Edge Function만) | ✕(서버만) | 본인 |
| `saved_places` | 본인(`auth.uid()=user_id`) | ✕(Edge Function만) | ✕(서버만) | 본인 |

- 쓰기는 Edge Function이 `service_role` 키로 수행(RLS 우회). 사용자는 조회·삭제만.

### 트리거
- `auth.users` insert → `profiles` 자동 생성(닉네임은 소셜 provider 메타데이터).
- `updated_at` 자동 갱신.

### 실시간 (선택)
- `reels`/`saved_places` Realtime 구독 시 `PROCESSING→COMPLETED` 자동 반영. MVP는 포그라운드 재조회 + 당겨서 새로고침으로 시작.

---

## 7. iOS 앱 구조

### 프로젝트 구성 — 3개 모듈
```
Yeogidam.xcodeproj
├── Yeogidam            (메인 앱 타깃)
├── ShareExtension      (공유 확장 타깃, 가볍게)
└── YeogidamKit         (공유 로컬 Swift Package)
```

### `YeogidamKit` (앱 + Share Extension 공유)
```
YeogidamKit/
├── Models/       SavedPlace, Place, Reel, Profile, ProcessingStatus, FailureReason
├── SharedSession/  App Group + Keychain 세션 읽기/쓰기 (SessionStore)
├── EdgeFunction/   EdgeFunctionClient (save-instagram-reel 호출)
└── InstagramURL/   URL 검증 (isValidInstagramReelURL)
```

### 메인 앱
```
Yeogidam/
├── App/
│   ├── YeogidamApp.swift        진입점, 세션 상태로 로그인/메인 분기
│   └── AppState.swift           로그인 세션·현재 사용자 관찰
├── Core/
│   ├── SupabaseClient.swift     supabase-swift 단일 인스턴스
│   ├── AuthService.swift        카카오/Apple 로그인 → Supabase 세션 → SessionStore 저장
│   ├── SavedPlacesRepository.swift
│   └── ProfileRepository.swift
├── Features/
│   ├── Auth/LoginView.swift
│   ├── SavedPlaces/
│   │   ├── SavedPlacesListView.swift   카드 목록 / 빈 상태 / 처리중·실패 카드
│   │   ├── SavedPlaceCard.swift
│   │   ├── EmptyStateView.swift
│   │   └── PlaceDetailView.swift        대표 이미지·주소·저장한 릴스(N)·[네이버에서 보기]
│   ├── Map/
│   │   ├── MapScreen.swift
│   │   ├── NaverMapView.swift           UIViewRepresentable로 네이버 지도 SDK 래핑
│   │   └── PlaceCardOverlay.swift
│   ├── AddPlace/AddByURLSheet.swift     + 버튼 → URL 직접 입력
│   └── MyPage/
│       ├── MyPageView.swift
│       └── SettingsView.swift
├── Navigation/RootTabView.swift         TabView(저장됨 | 지도 | 마이)
├── DesignSystem/  Colors / Typography / Components / Assets(여기담 로고)
└── Resources/  Info.plist, 로컬라이즈 문자열
```

### Share Extension
```
ShareExtension/
├── ShareViewController.swift   (SwiftUI 화면 호스팅)
├── ShareView.swift            "저장하는 중…" → "✓ 저장했어요" / 실패 안내
└── Info.plist                 NSExtension: 공유 대상 = URL / 텍스트
```
동작: `URL 수신 → 검증 → SessionStore 토큰 → EdgeFunctionClient 호출(202=성공) → 종료`.

### 짚을 점
- **네이버 지도**: `UIViewRepresentable`(`NaverMapView`)로 `NMFMapView` 래핑. NCP client ID를 Info.plist에 넣어야 함(Phase 6).
- **인증 (MVP = 익명)**:
  - 로그인 화면은 "시작하기" 버튼 → `AuthService`가 Supabase `signInAnonymously()` 호출.
  - 세션(JWT)을 공유 Keychain(SessionStore)에 기록 → Share Extension이 동일하게 사용.
  - (후순위) Apple: `AuthenticationServices` → `signInWithIdToken(.apple)`, 카카오: SDK 로그인 → Supabase 카카오 provider 교환. 기존 익명 계정에 **링크**로 추가.
- **데이터 갱신**: 포그라운드 진입 + 당겨서 새로고침으로 재조회. Realtime은 선택.
- **마이페이지(설정)**: 실동작 = 로그아웃/내 정보/문의하기(메일). MVP UI만 = 알림 설정·기본 지도 설정·카테고리 관리·데이터 내보내기.

---

## 8. Edge Function `save-instagram-reel`

- 엔드포인트: `POST /functions/v1/save-instagram-reel`
- 요청: `{ "instagramUrl": "https://www.instagram.com/reel/xxxxx/", "source": "instagram_share" | "url_input" }`
- 처리:
  1. JWT 인증 → user 확인
  2. Instagram URL 검증
  3. `reels`(PROCESSING) insert → **202 반환**
  4. `waitUntil` 백그라운드:
     - Instagram HTML fetch (best-effort) → og:title/description/image/url 파싱
     - 본문/캡션 **주소 정규식 추출**(1순위)
     - 주소 부족 시 **Gemini 장소명 추출**(구조화 JSON, 2순위)
     - **네이버 지역검색** → 장소 매칭 → mapx/mapy → WGS84 변환
     - 썸네일 결정(네이버 베스트에포트 → IG → 로고) + Storage 재호스팅
     - `places` upsert → `saved_places` upsert → `reels` COMPLETED
     - 실패 시 `reels` FAILED + `failure_reason`

### AI 사용 경계 (기획서 원칙 3)
- 코드: HTML og 파싱, 주소 정규식.
- AI(Gemini): 비정형 캡션에서 장소명 후보 추출 (반드시 구조화 JSON 응답).
- 검색/매칭: 네이버 지역검색 API.

---

## 9. 실패 처리 (기획서 22번)
- IG 접근 실패 → `FAILED / IG_FETCH_FAILED` → "릴스 정보를 가져오지 못했어요."
- 장소 못 찾음 → `FAILED / PLACE_NOT_FOUND` → "장소를 찾지 못했어요."
- 그 외 오류 → `FAILED / UNKNOWN`.
- 실패해도 전체가 죽지 않고 해당 `reels` 행만 실패로 마감, 앱에서 실패 카드로 확인.

---

## 10. 구현 순서

### Phase 0 — 준비 (외부 계정·키 = 블로커)
- Supabase 프로젝트 생성 + **익명 인증(Anonymous sign-in) 활성화**
- Gemini API 키
- 네이버 지역검색 API 키 (Phase 3 필요)
- Xcode 프로젝트 + App Group / Keychain 공유 그룹
- *(네이버 지도 NCP client ID는 Phase 6 직전까지)*
- *(카카오/Apple 개발자 설정은 소셜 로그인 단계로 연기 — 아래 Phase 8)*

### Phase 1 — Supabase 백엔드
- 테이블·CHECK 제약·인덱스·UNIQUE(user_id, place_id), RLS, `handle_new_user`·`updated_at` 트리거
- Storage `place-thumbnails` 버킷, Auth provider(카카오·Apple) 연결

### Phase 2 — iOS 뼈대 + 인증(익명)
- `YeogidamKit`, `SupabaseClient`
- "시작하기" → `signInAnonymously()` → 세션 → `SessionStore`
- `RootTabView`, 마이페이지(로그아웃/세션 초기화), 저장됨 빈 상태
- ✅ 검증: 익명 세션 생성/초기화, 세션이 공유 Keychain에 써지는지

### Phase 3 — Edge Function (심장부)
- `save-instagram-reel` 전체 파이프라인
- ✅ 검증: 앱 "URL 직접 입력"으로 e2e (Share Extension 없이 파이프라인 확인)

### Phase 4 — Share Extension
- 공유 타깃, URL 검증, 토큰 읽기, 호출, "저장했어요" UI
- ✅ 검증: 인스타 → 공유 → 여기담 → 저장

### Phase 5 — 저장됨/상세 완성
- 카드 목록(완료/처리중/실패), `PlaceDetailView`(릴스 N, 네이버 링크)
- 당겨서 새로고침 + 포그라운드 재조회
- ✅ 검증: 공유 후 앱 열면 장소 존재 / 실패는 실패 카드

### Phase 6 — 지도 (네이버 NCP 키 준비 후)
- `NaverMapView`, 마커, 하단 `PlaceCardOverlay`

### Phase 7 — 실패 케이스·UX 다듬기
- 실패 문구, (선택) Realtime 자동 반영

### Phase 8 — 소셜 로그인 (후순위)
- 카카오/Apple 개발자 설정, Supabase provider 연결
- 카카오 SDK / Sign in with Apple → 익명 계정에 **링크**
- 로그인 화면 "시작하기" → 카카오/Apple 버튼으로 교체

**의존성**: `Phase 0 → 1 → 2 → 3 → 4 → 5`가 핵심 선. 지도(6)·소셜 로그인(8)은 독립. 7은 상시.

---

## 11. MVP 범위 밖 (기획서 26번 준수)
친구/공유/댓글/좋아요/팔로우/추천/피드/복잡한 카테고리/리뷰/챗봇/여행코스/다중플랫폼 — 구현하지 않음.
추가: 같은 장소 릴스 누적은 지원하되, "장소 수동 편집", "프로필 사진 업로드", "Realtime"은 후순위.
