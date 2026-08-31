# Gemini Primary/Fallback RPD 80% Discord 알림

> 이 문서는 실행 전 설정 절차다. 저장소의 수신 함수와 테스트만 설명하며, Google
> Cloud 정책·metrics scope·Discord Webhook·Supabase 배포가 실제로 변경되었다고
> 간주하지 않는다.

## 최종 알림 정책

Cloud Monitoring에서 Discord로 보내는 quota 알림은 아래 두 개뿐이다.

| 프로젝트 역할 | Google Cloud 프로젝트 ID     | quota | 임계치 | 등급    |
| ------------- | ---------------------------- | ----- | ------ | ------- |
| Primary       | `gen-lang-client-0666690473` | RPD   | 80%    | WARNING |
| Fallback      | `yeogidam`                   | RPD   | 80%    | WARNING |

RPM 80%와 TPM 80% Cloud Monitoring 정책은 만들지 않는다. 이미 존재한다면
runtime의 Fallback 이벤트 알림이 동작하는지 먼저 검증한 뒤 삭제한다. 1분 quota는
Cloud Monitoring의 수집 지연보다 runtime의 실제 429/Fallback 이벤트가 더 빠르고
정확하다. 수신 함수도 남아 있는 RPM/TPM incident를 `202`로 확인만 하고 Discord로
전달하지 않는다.

예상 Discord 메시지는 다음 형태다. 역할, 임계치, 등급은 정책 라벨에서 읽는다.
Embed 제목은 Primary일 때 `[WARN][PRIMARY] Gemini RPD 80%`, Fallback일 때
`[WARN][FALLBACK] Gemini RPD 80%`다.

> ⚠️ WARNING · Gemini Primary RPD 사용량이 86.7%에 도달했습니다 (경고선 80%) ·
> 2026-08-28 21:42 KST

알림에는 `Primary` 또는 `Fallback`, `WARNING`, 설정 임계치, 현재 사용률, 한국
시간 기준 감지 시각, 모델, 실제 quota 소유 Google Cloud 프로젝트, Google 한도
이름과 incident 링크가 포함된다. 종료 및 `renotify` 알림은 보내지 않으며, 같은
Edge isolate에서 동일 incident가 중복 전달돼도 `incident_id` 기준으로 한 번만
보낸다. Discord 전송 실패 시에는 claim을 해제해 Google의 재전송을 다시 받을 수
있게 한다.

```text
Primary/Fallback Gemini RPD metric
                 ↓
Google Cloud Monitoring (RPD 80%, WARNING)
                 ↓ Basic Auth
Supabase Edge Function (정책 라벨 검증 → Discord payload)
                 ↓
Discord 채널
```

## Runtime 전환·복구 알림

`save-instagram-reel`은 같은 Discord Webhook으로 다음 상태 전환만 보낸다.
요청마다 보내거나 30분 단위로 모아 보내지 않는다.

| 표시 제목                                    | 발생 조건                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `[WARN] Gemini Primary → Fallback 전환`      | RPM·TPM·RPD 429로 Primary가 cooldown되고 Fallback이 실제 요청에 성공함     |
| `[WARN] Gemini Primary/Fallback UNKNOWN 429` | 해당 key의 429를 RPM·TPM·RPD로 분류하지 못함                               |
| `[RECOVERED] Gemini Fallback → Primary 복귀` | cooldown이 끝난 뒤 Primary가 실제 요청에 성공함                            |
| `[CRITICAL] Gemini 전체 API 키 사용 불가`    | Primary와 모든 Fallback이 cooldown 또는 429 상태여서 요청을 처리할 수 없음 |
| `[CRITICAL] Gemini API 키 인증 오류`         | Gemini key가 HTTP 401 또는 403을 반환함                                    |
| `[RECOVERED] Gemini 서비스 복구`             | 전체 key 사용 불가 상태 뒤 어느 key든 실제 요청에 성공함                   |

시간이 지났다는 이유만으로 복구 알림을 보내지 않는다. 실제 Gemini 성공 응답이
있어야만 Primary 또는 서비스 복구로 처리한다. Fallback 시도 시작, 요청별
Fallback 완료, 반복 RPM/TPM 요약, 30분 digest는 알림 대상이 아니다. OpenAI
provider fallback도 현재 배포에는 없다.

UNKNOWN 알림에는 원문 오류 대신 `classificationReason`, `quotaIds`, `retryAt`,
`retryHintSource`, 모델, operation, Primary/Fallback 역할과 slot을 넣는다. 429
본문 없음, 크기 초과, JSON 파싱 실패, 읽기 실패와 Google quota detail
누락·미인식·복수 분류를 구별한다. API key, 프롬프트, 전체 Google 오류 본문은
Discord나 진단 메타데이터에 넣지 않는다.

같은 cooldown 전환과 같은 전체 장애는 Edge isolate 안에서 한 번만 보낸다.
Discord 전송의 네트워크 오류·429·5xx는 한 `waitUntil` 작업 안에서 최대 3회
시도하고, 각 시도는 5초 `AbortController` 제한 시간이 적용되어 응답이 끝나지
않아도 다음 재시도 또는 실패 처리로 진행한다. 애플리케이션 요청은 계속 처리한다.
세 번 모두 실패하면 로컬 로그를 남기고 claim을 해제하지만 transition 이벤트
자체는 다시 발생하지 않을 수 있으므로 전송 보장이 필요하면 durable outbox가
추가로 필요하다. 중복 방지와 cooldown 상태도 메모리 기반이므로 cold start나 여러
isolate 사이에서 전역적으로 한 번만 처리해야 한다면 DB 또는 KV 저장소로 교체해야
한다.

## 프로젝트와 metrics scope

두 프로젝트만 사용하는 최소 구성에서는 Primary 프로젝트
`gen-lang-client-0666690473`를 scoping project로 두고 Fallback 프로젝트
`yeogidam`을 그 metrics scope에 추가한다. 두 RPD 정책과 Webhook notification
channel은 scoping project에 둔다.

쿼리는 각 정책에서 `resource_container`를 정확한 프로젝트 ID로 제한한다. 수신
함수 역시 `incident.scoping_project_id`보다
`incident.resource.labels.resource_container`를 우선 표시하므로 Fallback 알림에
Primary scoping project가 잘못 표시되지 않는다.

두 API key가 서로 독립된 quota를 가지려면 서로 다른 Google Cloud 프로젝트에
속해야 한다. 계정과 역할의 기준은 Primary 계정 `cwlgusc`의
`gen-lang-client-0666690473`, Fallback 계정 `yeogidam`의 `yeogidam`이며 API key
값은 문서, 정책 이름, 라벨에 기록하지 않는다.

## 정책 라벨 계약

수신 함수는 정책 이름을 해석하지 않고 `policy_user_labels`만 신뢰한다. 각 정책에
아래 네 라벨을 모두 설정한다.

| 라벨                | Primary 값 | Fallback 값 | Discord 표시           |
| ------------------- | ---------- | ----------- | ---------------------- |
| `quota_kind`        | `rpd`      | `rpd`       | `RPD`                  |
| `project_role`      | `primary`  | `fallback`  | `Primary` / `Fallback` |
| `threshold_percent` | `80`       | `80`        | `80%`                  |
| `severity`          | `warning`  | `warning`   | `WARNING`              |

Google Cloud user label은 소문자·숫자·밑줄·하이픈만 허용하므로 저장값은
`quota_kind=rpd`, `severity=warning`처럼 소문자로 쓴다. 정책의 별도 severity
설정도 `WARNING`으로 맞춘다.

다음 incident만 Discord로 전달된다.

- `state=open`, `renotify=false`
- `quota_kind=rpd`
- `project_role=primary` 또는 `project_role=fallback`
- `threshold_percent=80`
- `severity=warning`

라벨 누락·오타, 다른 임계치/등급, RPM/TPM, 종료/반복 incident는 fail-closed로
무시한다. 또한 실제 source project가 Primary이면 `gen-lang-client-0666690473`,
Fallback이면 `yeogidam`과 정확히 일치해야 한다. 역할 라벨과 프로젝트가
뒤바뀌거나 source project label이 없으면 Discord로 보내지 않는다.

## 1. Discord Webhook과 Supabase Function 준비

Discord에서 알림을 받을 채널의 `채널 편집 > 연동 > 웹후크 > 새 웹후크`를 선택한
뒤 Webhook URL을 복사한다. 이 URL은 비밀번호와 같으므로 Git이나 문서에 저장하지
않는다.

아래 값을 Supabase secret으로 등록하고 함수를 배포한다.

```bash
supabase secrets set \
  DISCORD_GEMINI_ALERT_WEBHOOK_URL='<Discord Webhook URL>' \
  MONITORING_WEBHOOK_USERNAME='<영문·숫자 임의 사용자명>' \
  MONITORING_WEBHOOK_PASSWORD='<충분히 긴 임의 비밀번호>' \
  --project-ref hbbrgudsbvnwuylxqlta

supabase functions deploy gemini-quota-discord \
  --no-verify-jwt \
  --project-ref hbbrgudsbvnwuylxqlta
```

Google Cloud에 등록할 수신 URL은 다음과 같다.

```text
https://hbbrgudsbvnwuylxqlta.supabase.co/functions/v1/gemini-quota-discord
```

Supabase JWT 검사는 끄지만 Google Cloud Webhook에 설정한 Basic Auth를 반드시
검증한다. 인증 실패 시 함수는 `401`과 `WWW-Authenticate`를 반환한다. Discord
오류 본문과 secret은 응답이나 로그에 포함하지 않는다.

## 2. Google Cloud Webhook notification channel 준비

scoping project `gen-lang-client-0666690473`에서 다음과 같이 설정한다.

1. `Monitoring > Alerting > Edit notification channels`로 이동한다.
2. `Webhooks > Add new`를 선택한다.
3. Supabase Function URL을 입력한다.
4. Basic authentication에 Supabase secret과 같은 사용자명·비밀번호를 입력한다.
5. 표시 이름을 `Yeogidam Gemini RPD Discord`로 지정한다.
6. connection test가 `2xx`로 완료되는지 확인한다. 테스트 payload는 실제
   incident가 아니므로 Discord 메시지 없이 `202`로 처리되는 것이 정상이다.

## 3. RPD 80% 정책 두 개 준비

먼저 각 프로젝트의 Metrics Explorer에서 실제 RPD `limit_name`과 request quota
metric family를 확인한다. 아래 쿼리는 무료 tier 예시다. 프로젝트가 다른 tier라면
`usage`와 `limit`을 그 프로젝트에 노출된 동일 family로 함께 교체한다. 이름에
`_internal`이 들어간 metric은 사용하지 않는다.

`Monitoring > Alerting > Create policy > Select a metric > PromQL`에서 아래
template의 `<PROJECT_ID>`를 각 프로젝트 ID로 바꾼다.

```promql
(
  sum by (resource_container, location, limit_name, model) (
    increase({
      "__name__"="generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/usage",
      "monitored_resource"="generativelanguage.googleapis.com/Location",
      "resource_container"="<PROJECT_ID>",
      "limit_name"=~".*PerDay.*"
    }[23h])
  )
  /
  max by (resource_container, location, limit_name, model) (
    {
      "__name__"="generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/limit",
      "monitored_resource"="generativelanguage.googleapis.com/Location",
      "resource_container"="<PROJECT_ID>",
      "limit_name"=~".*PerDay.*"
    }
  )
) >= 0.8
```

가능하면 `.*PerDay.*` 대신 Metrics Explorer에서 확인한 정확한 `limit_name`을
사용한다. 모델별 quota 시계열이 섞이지 않도록 `model` 그룹을 유지한다.

### Primary 정책

- 프로젝트 필터: `resource_container="gen-lang-client-0666690473"`
- 정책/조건 이름: `Gemini Primary RPD 80% WARNING`
- severity: `WARNING`
- user labels: `quota_kind=rpd`, `project_role=primary`, `threshold_percent=80`,
  `severity=warning`
- notification channel: `Yeogidam Gemini RPD Discord`
- 반복 알림과 incident 종료 알림: 사용하지 않음

### Fallback 정책

- 프로젝트 필터: `resource_container="yeogidam"`
- 정책/조건 이름: `Gemini Fallback RPD 80% WARNING`
- severity: `WARNING`
- user labels: `quota_kind=rpd`, `project_role=fallback`,
  `threshold_percent=80`, `severity=warning`
- notification channel: `Yeogidam Gemini RPD Discord`
- 반복 알림과 incident 종료 알림: 사용하지 않음

이 쿼리는 정확한 Pacific 달력 날짜 누적이 아니라 최근 23시간의 rolling
근삿값이다. 짧은 재검사 기간을 둘 수 있지만 운영 대응 시간을 늦추지 않도록 0~2분
범위에서 결정한다. 정책 생성 후 Preview에서 해당 역할의 프로젝트 시계열만
선택되는지 확인한다.

## 단계별 rollout 순서

아래는 수행해야 할 순서이며, 체크되지 않은 항목이 완료되었다는 뜻은 아니다.

- [ ] Primary `gen-lang-client-0666690473`와 Fallback `yeogidam`이 서로 다른
      quota 프로젝트이며 각 계정에 올바르게 연결되었는지 확인한다.
- [ ] runtime의 RPM/TPM 429 및 Fallback 성공/실패 이벤트 알림을 먼저 배포하고
      검증한다.
- [ ] 이 수신 함수를 배포하고 Basic Auth가 설정된 Webhook connection test를
      통과시킨다.
- [ ] Fallback 프로젝트를 Primary scoping project's metrics scope에 추가하고, 두
      프로젝트의 RPD metric family와 정확한 `limit_name`을 확인한다.
- [ ] `Gemini Primary RPD 80% WARNING` 정책을 먼저 만들고 쿼리, 네 라벨,
      notification channel을 검토한다.
- [ ] Primary 정책의 incident payload와 Discord 표시가 맞는지 검증한 뒤
      `Gemini Fallback RPD 80% WARNING` 정책을 만든다.
- [ ] Fallback 정책이 Fallback 프로젝트 시계열만 선택하고 Discord에 `Fallback`과
      실제 Fallback 프로젝트 ID를 표시하는지 검증한다.
- [ ] runtime 이벤트 알림과 두 RPD 정책이 모두 검증된 뒤 기존 Cloud Monitoring
      `Gemini RPM 80%`, `Gemini TPM 80%` 정책을 삭제한다. 기존 정책이 없다면
      새로 만들지 않는다.
- [ ] 최종 정책 목록에 Primary RPD 80% WARNING과 Fallback RPD 80% WARNING만
      남았는지 별도로 확인한다.

## 지연과 RPD 해석

- RPD는 Pacific Time 자정에 초기화되지만 최근 23시간 쿼리는 달력 날짜가 아닌
  rolling window다. 자정 직후에는 전날 사용량 대부분을 포함하므로 이전
  incident가 계속 열려 있거나 실제 당일 사용량보다 일찍 경고할 수 있다. 정확한
  PT 날짜별 80% 경고가 필요하면 PT 자정에 초기화되는 별도 durable request
  counter와 그 metric을 사용해야 한다. 이 Cloud 정책은 운영용 조기 경보이고 실제
  전환은 runtime 429가 결정한다.
- Gemini quota metric은 샘플링 후 보이기까지 최대 150초가 걸릴 수 있고,
  Monitoring 평가·재검사·Webhook 전송 시간이 추가된다. 이 알림은 runtime
  Fallback을 제어하는 실시간 신호가 아니라 운영 경보다.
- Discord의 감지 시각은 실제 Gemini 요청 시각이 아니라 Google Cloud가 incident를
  연 시각이다.
- 사용 이력이 없는 프로젝트는 metric 시계열이 아직 나타나지 않을 수 있다. 시계열
  부재를 사용률 0% 또는 정상 상태로 간주하지 않는다.

## 로컬 검증

```bash
npx -y deno@2 fmt --check supabase/functions/gemini-quota-discord
npx -y deno@2 test supabase/functions/gemini-quota-discord/handler_test.ts
npx -y deno@2 check supabase/functions/gemini-quota-discord/index.ts
```

## 공식 참고

- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Google Cloud Gemini quota metric 목록](https://docs.cloud.google.com/monitoring/api/metrics_gcp_d_h)
- [quota metric 80% PromQL 예제](https://docs.cloud.google.com/monitoring/alerts/using-quota-metrics)
- [Cloud Monitoring metrics scope](https://docs.cloud.google.com/monitoring/settings)
- [Cloud Monitoring user label 제약](https://docs.cloud.google.com/monitoring/alerts/labels)
- [Cloud Monitoring Webhook와 Basic Auth](https://docs.cloud.google.com/monitoring/support/notification-options)
