# 릴스 장소 저장 구현 플로우

- 엔드포인트: `POST /functions/v1/save-instagram-reel`
- 구현: `supabase/functions/save-instagram-reel`
- 처리: 접수는 동기, 장소 추출·저장은 비동기
- 장소 자연키: Kakao Local API `id`

## 1. 요청 계약

```http
POST /functions/v1/save-instagram-reel
Authorization: Bearer <Supabase user JWT>
apikey: <Supabase anon key>
Content-Type: application/json
```

```json
{
  "instagramUrl": "https://www.instagram.com/reel/SHORTCODE",
  "source": "instagram_share"
}
```

신규 접수는 `202`와 `reelId`를 반환한다. 이미 완료된 동일 릴스 결과를 재사용한 경우에는 `200`, `status: COMPLETED`, `reused: true`, `placeIds`를 바로 반환한다.

## 2. 전체 순서

```mermaid
sequenceDiagram
    participant U as iOS / Share Extension
    participant F as Edge Function
    participant D as Postgres
    participant I as Instagram
    participant AI as Gemini
    participant K as Kakao Local API
    participant G as Google Places
    participant S as Storage

    U->>F: URL + JWT
    F->>F: JWT 검증 + URL에서 shortcode 정규화
    F->>D: 동일 사용자 또는 완료된 shortcode 조회
    alt 재사용 가능한 결과 있음
        F->>D: saved_places + reel_places 복원/복사
        F-->>U: 200/202 + 기존 결과 + reused=true
    else 신규 또는 재처리 필요
    F->>D: reels(PROCESSING) insert
    F-->>U: 202 + reelId
    F->>I: 릴스 HTML head meta
    I-->>F: caption + thumbnail
    F->>AI: 전체 caption, places[] schema
    AI-->>F: 0..N 장소명·주소·지역
    loop 원문에 근거가 있는 각 장소
        F->>K: 장소명 키워드 검색
        K-->>F: 0..15 후보 + Kakao place id
        F->>F: Kakao place id 중복 제거
        alt 후보 0개
            F->>F: 장소별 실패 기록
        else 후보 1개
            F->>F: 즉시 선택
        else 후보 2개 이상
            F->>F: 주소·지역으로 유일 후보 확인
            opt 위치만으로 하나를 못 고름
                F->>AI: 전체 caption + Kakao 후보
                AI-->>F: candidateId 또는 NONE
                F->>F: 전달한 candidateId인지 확인
            end
        end
        opt 후보가 선택됨
            F->>D: places upsert on kakao_place_id
            F->>G: 대표 사진 조회
            F->>S: 선택된 이미지 업로드
            F->>D: saved_places + reel_places upsert
        end
    end
    F->>D: reels(COMPLETED / FAILED)
    end
```

## 3. Instagram 추출

1. 캡션: HTML `og:description` → `name="description"` → `twitter:description`
2. 보조 저장: `og:image`, `og:url`

릴스 URL의 HTML head가 유일한 캡션 입력이자 SSOT다. HTML 태그 배치 순서와 무관하게 위 description 우선순위를 적용하고, 큰따옴표·작은따옴표를 모두 처리하며 HTML entity를 디코딩한다. 한 번의 릴스 HTML 요청에서 description을 얻지 못하면 추가 Instagram 요청 없이 `IG_FETCH_FAILED`다.

Gemini 입력과 DB의 캡션 원문은 선택된 description 하나다. `og:title`과 `twitter:title`은 파싱하거나 저장하지 않는다. title과 description에 같은 전체 캡션이 반복되는 Instagram 응답에서 불필요한 데이터 보관과 중복 입력 가능성을 없앤다. 릴스 HTML 요청이 non-2xx이거나 description이 없으면 Gemini를 호출하지 않는다.

레거시 스키마의 `reels.instagram_title` 컬럼은 기존 배포 호환을 위해 당분간 nullable 상태로 남겨 두지만 신규 처리와 동일 릴스 결과 재사용에서는 값을 쓰지 않는다. UI, 장소 매칭, 중복 판정, 재시도 어느 경로에서도 사용하지 않으며 다음 스키마 정리 때 제거할 수 있다.

## 4. Gemini-first 다중 추출

캡션 전체를 structured output으로 보낸다.

```json
{
  "places": [
    {
      "placeName": "보연희",
      "address": "서울 서대문구 연희맛로 17-63 2층",
      "addressType": "ROAD",
      "region": "연희동"
    }
  ]
}
```

- 애플리케이션이 장소 개수를 제한하지 않고 Gemini가 반환한 유효 항목을 모두 처리
- 여러 주소·장소는 별도 원소
- 같은 장소의 도로명·지번 병기는 하나로 통합
- 층·동·호를 포함한 상세주소 보존
- 이름·주소·지역은 추론하지 않고 원문 문자열 복사

호출 후 각 필드가 실제로 캡션에 있는지 다시 검증한다. 장소명이 원문에 없으면 항목을 제거하고, 주소·지역이 원문에 없으면 해당 필드만 `null`로 둔다. 주소와 지역이 모두 없어도 원문에 실제 방문 장소로 언급된 장소명은 후속 Kakao 검색에 넘긴다.

response schema와 응답 파서에는 장소 개수 상한을 두지 않는다. Gemini가 반환한 모든 유효 장소가 후속 Kakao 단계에 들어가며, 2차 후보 선택도 전체 대상 장소의 판단을 파싱한다. 다만 모델의 출력 토큰·컨텍스트 같은 공급자 한계나 모델 자체 누락 가능성까지 없어지는 것은 아니다.

현재 프롬프트는 원문 순서대로 반환하라고 명시하지 않는다. `reel_places.position`도 원문 절대 인덱스가 아니라 최종 매칭에 성공한 결과를 0부터 다시 센 순서다. 원문 1·3·5번째만 성공하면 position은 0·1·2가 된다.

1차 장소 추출 Gemini는 캡션당 한 번 호출한다. 복수 Kakao 후보가 남은 장소가 있으면 해당 장소들을 묶어 2차 후보 선택 Gemini를 최대 한 번 추가 호출한다. 비용과 지연은 주로 각 결과에 대한 Kakao 검색, 필요한 2차 Gemini 판단, 새 장소의 Google 사진 조회, Storage 업로드에서 증가한다.

`address.ts`는 캡션의 도로명 주소를 `matchAll()`로 모두 수집하지만 현재는 shadow log에만 사용한다.

## 5. Kakao 후보 생성과 선택

각 `PlaceGuess`는 주소·지역 유무와 관계없이 `장소명` 하나로 Kakao 키워드 검색을 한 번 호출한다. 주소 문자열을 검색어에 섞거나, 결과가 없을 때 장소명으로 다시 검색하는 fallback은 없다. Kakao 응답은 정확도순 최대 15개이며, 같은 Kakao place id가 반복되면 첫 결과만 남긴다.

HTTP 200 응답의 `documents: []`만 실제 후보 0개로 처리한다. Kakao가 401·403·429·5xx를 반환하거나 네트워크·응답 형식 오류가 발생하면 후보 0개로 바꾸지 않고 공급자 오류로 중단한다. 현재 별도 DB 실패 enum을 늘리지 않고 재시도 가능한 `UNKNOWN`으로 기록하며, `kakao_place_search_failed` 로그에 오류 종류·HTTP status·재시도 가능 여부를 남긴다.

후보 선택 정책은 다음과 같다.

| Kakao place id 중복 제거 후 후보 수 | 처리 |
|---|---|
| 0개 | 해당 장소를 `NO_KAKAO_CANDIDATE`로 기록하고 저장하지 않음 |
| 1개 | 이름·주소를 다시 비교하지 않고 즉시 `AUTO_MATCH` |
| 2개 이상 | 캡션에서 추출한 주소·지역으로 정확히 하나만 특정되면 `AUTO_MATCH`; 그 외에는 원본 후보 전체를 2차 Gemini에 전달 |

복수 후보의 위치 자동 선택은 **양성 일치**에만 쓴다. 파싱 가능한 행정구역 토큰, 도로명, 건물번호가 후보 주소와 정확히 맞아 하나만 남을 때만 자동 선택한다. 불완전하거나 파싱할 수 없는 위치, 일치 후보 0개, 일치 후보 2개 이상은 후보를 버리는 근거가 아니라 2차 Gemini로 넘기는 조건이다.

2차 Gemini는 전체 캡션과 최대 15개의 Kakao 후보를 함께 받는다. `@아이디`, 해시태그, 지점명, 지역 문맥, 한글·영문·음차·철자 차이를 종합해 전달된 `candidateId` 하나를 선택하거나 근거가 부족하면 `NONE`을 반환한다. 코드의 최종 가드는 Gemini가 새 장소를 만들어 내지 못하도록 선택 ID가 전달 후보 목록에 있는지만 확인하며, 이름이나 주소 규칙으로 그 판단을 다시 뒤집지 않는다.

이전의 상호명 지점 접미사 규칙, 4글자 이상 한 글자 오타 규칙, 도로명 숫자 전치 허용, 상세주소 기반 장소명-only fallback, Gemini 선택 후 이름·다지역·도로·건물번호 재검증은 제거했다. 표기 차이와 문맥 판단은 2차 Gemini가 맡는다.

현재 장소는 순차 처리하며, Gemini가 추출한 장소마다 Kakao 키워드 검색을 한 번 호출한다. 애플리케이션 개수 상한이 없으므로 요청 수는 추출 장소 수에 비례한다.

## 6. 저장과 중복

`places.kakao_place_id` 유니크 제약으로 upsert한다.

- `places.id`: 내부 UUID
- `kakao_place_id`: 외부 자연키
- `kakao_place_url`: `https://map.kakao.com/link/map/{id}`
- `source_address`: Instagram 원문의 상세주소
- `road_address`, `address`, 좌표, 전화, 카테고리: Kakao 정규화 결과

`saved_places(user_id, place_id)`는 사용자별 중복을 막고, `reel_places(reel_id, place_id, position)`는 하나의 릴스와 여러 장소 관계를 보존한다. `position`은 성공한 Gemini 결과의 상대 순서다. 기존 앱 호환을 위해 `reels.place_id`는 첫 장소를 계속 가리킨다.

인증 사용자는 `reel_places`를 임의로 쓰지 못한다. 다만 장소 상세의 관련 릴스를 조회할 수 있도록, RLS가 현재 사용자의 `reels.user_id`와 연결된 관계에 한해서 읽기를 허용한다. iOS는 이 관계로 완료된 릴스를 최신순 조회하고 썸네일을 누르면 원본 `instagram_url`을 연다.

`reels.instagram_shortcode`는 Instagram 콘텐츠 식별자다. `(user_id, instagram_shortcode)` partial unique index로 같은 사용자의 동시 중복 요청을 한 행으로 수렴시킨다.

- 같은 사용자의 `PROCESSING` 또는 `COMPLETED`: 기존 `reelId`와 상태 반환
- 다른 사용자의 같은 shortcode가 현재 알고리즘 버전으로 완료됨: 장소 관계와 저장 목록만 복사하고 외부 API 생략
- `FAILED`, 15분 이상 갱신되지 않은 작업, 낮은 `processing_version`: 같은 행을 비우고 재처리
- 완료된 릴스의 저장 장소를 사용자가 삭제한 뒤 다시 저장: 기존 `reel_places`에서 `saved_places` 복원

장소 매칭 결과가 달라지는 코드를 배포할 때 `PIPELINE_VERSION`을 올리지 않으면 완료된 같은 shortcode는 기존 결과를 계속 재사용한다. 반대로 버전을 올리면 재처리되지만, 현재 정리는 `reel_places`만 대상으로 하고 사용자 단위 `saved_places`는 자동 삭제하지 않는다. 과거 오탐을 제거하려면 다른 릴스가 같은 장소를 참조하는지 확인하는 별도 정리 정책이 필요하다.

Naver 전용 `naver_place_id`, `naver_link`, `naver_thumbnail_url`은 Kakao 전환 마이그레이션에서 제거한다. 장소 식별자와 지도 링크의 SSOT는 각각 `kakao_place_id`, `kakao_place_url`이다.

`places.source_address`는 공용 장소 행에 저장되므로 릴스별 주소 이력이 아니다. 같은 Kakao 장소가 다른 캡션의 상세주소로 다시 저장되면 최근 non-null 원문 주소로 바뀔 수 있다. 릴스별 원문 보존이 필요하면 `reel_places`에 별도 컬럼을 두어야 한다.

다중 장소 저장은 현재 하나의 Postgres 트랜잭션으로 묶이지 않는다. 앞 장소의 `places`·`saved_places`·`reel_places` 저장 후 뒤 장소에서 DB 오류가 발생하면 릴스는 `FAILED/UNKNOWN`이지만 앞선 쓰기가 남을 수 있다.

## 7. 썸네일

1. `places.thumbnail_url` 캐시
2. DB 월간 예약 한도 통과 후 Google Places 사진
3. Instagram `og:image`
4. Kakao 장소 상세 페이지 `og:image`
5. 모두 실패하면 앱 placeholder

외부 URL을 그대로 보관하지 않고 `place-thumbnails` Storage에 업로드한다.

## 8. 상태

| 상태 | 의미 |
|---|---|
| `PROCESSING` | 접수 후 백그라운드 처리 중 |
| `COMPLETED` | 선택된 장소가 1개 이상 저장됨 |
| `FAILED` | 구조화 또는 저장 실패 |

| 실패 사유 | 대표 원인 |
|---|---|
| `IG_FETCH_FAILED` | Instagram 요청 실패 또는 non-2xx 응답 |
| `IG_CAPTION_NOT_FOUND` | HTML 응답은 성공했지만 description 메타데이터 없음 |
| `PROVIDER_CONFIG_MISSING` | Gemini 또는 Kakao API 키 누락 |
| `GEMINI_PLACE_NOT_FOUND` | Gemini 결과가 없거나 원문 검증 후 후보가 0개 |
| `KAKAO_PLACE_NOT_FOUND` | Kakao 후보가 없거나 2차 Gemini가 선택하지 않아 저장할 장소가 0개 |
| `PLACE_NOT_FOUND` | 이전 버전 호환용 일반 장소 탐색 실패 |
| `UNKNOWN` | DB·Storage 또는 예상하지 못한 예외 |

`COMPLETED`가 모든 캡션 장소의 저장을 보장하지는 않는다. 다음은 실패 상태가 아닌 부분 성공이다.

- Gemini 모델이 캡션의 일부 장소를 응답에서 누락함
- 여러 Gemini 항목 중 일부만 Kakao 후보 선택에 성공함
- 동일 Kakao 장소 ID가 캡션에 반복되어 하나로 합쳐짐
- 썸네일 제공자가 모두 실패하여 이미지 없이 장소만 저장됨

운영에서 저장 개수가 예상보다 적으면 `instagram_description`의 장소 순서, Gemini `placeCount`, sanitized count, 장소별 Kakao `candidateCount`·`decision`, 2차 Gemini의 `NONE` 사유, 최종 `reel_places.position`을 차례로 확인한다.

상세 알고리즘, 정규식 조사, 실패 매트릭스는 [MVP 장소 매칭 보고서](mvp-place-matching-release-report.md)를 참고한다.
