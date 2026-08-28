# Gemini 무료 한도 80% Discord 알림

## 목표

Google Cloud Monitoring에서 Gemini 무료 한도의 RPM, RPD, TPM 사용률을 각각
감시하고, 80% 이상이면 Discord에 다음과 같이 한 번 알린다.

> ⚠️ Gemini TPM 사용량이 86.7%에 도달했습니다 · 2026-08-28 21:42 KST

알림에는 기준(RPM/RPD/TPM), 현재 사용률, 한국 시간 기준 감지 시각, Gemini
모델, Google Cloud 프로젝트, 해당 Google Cloud incident 링크가 포함된다. 종료
알림과 반복 알림은 Discord로 보내지 않는다.

```text
Gemini quota metric
        ↓
Google Cloud Monitoring (80% 감지)
        ↓ Basic Auth
Supabase Edge Function (Google payload → Discord payload)
        ↓
Discord 채널
```

## 1. Discord Webhook 만들기

Discord에서 알림을 받을 채널의 `채널 편집 > 연동 > 웹후크 > 새 웹후크`를
선택한 뒤 `웹후크 URL 복사`를 누른다. 이 URL은 비밀번호와 같으므로 Git이나
문서에 저장하지 않는다.

## 2. Supabase Function 설정과 배포

아래 세 값을 Supabase secret으로 등록한다.

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

Google Cloud에 등록할 공개 수신 URL은 다음과 같다.

```text
https://hbbrgudsbvnwuylxqlta.supabase.co/functions/v1/gemini-quota-discord
```

## 3. Google Cloud Webhook 알림 채널 만들기

프로젝트 `savvy-night-435401-a0`에서 다음 순서로 설정한다.

1. `Monitoring > Alerting > Edit notification channels`로 이동한다.
2. `Webhooks > Add new`를 선택한다.
3. 위 Supabase Function URL을 입력한다.
4. Basic authentication에 Supabase secret과 동일한 사용자명과 비밀번호를
   입력한다.
5. 표시 이름을 `Yeogidam Gemini Discord`로 저장한다.

함수는 인증 실패 시 Google이 요구하는 `401`과 `WWW-Authenticate` 응답을
반환한다. Supabase JWT 검사는 끄되, Google Monitoring 외의 요청은 이 Basic
Auth로 차단한다.

## 4. 80% 정책 세 개 만들기

`Monitoring > Alerting > Create policy > Select a metric > PromQL`에서 정책을
각각 하나씩 만든다. 알림 채널은 모두 `Yeogidam Gemini Discord`를 선택하고,
반복 알림과 incident 종료 알림은 사용하지 않는다.

### RPM — 최근 1분 요청 수

정책과 조건 이름을 모두 `Gemini RPM 80%`로 지정한다.

```promql
(
  sum by (resource_container, location, limit_name, model) (
    increase({
      "__name__"="generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/usage",
      "monitored_resource"="generativelanguage.googleapis.com/Location",
      "limit_name"=~".*PerMinute.*"
    }[1m])
  )
  /
  max by (resource_container, location, limit_name, model) (
    {
      "__name__"="generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/limit",
      "monitored_resource"="generativelanguage.googleapis.com/Location",
      "limit_name"=~".*PerMinute.*"
    }
  )
) >= 0.8
```

### TPM — 최근 1분 입력 토큰 수

정책과 조건 이름을 모두 `Gemini TPM 80%`로 지정한다.

```promql
(
  sum by (resource_container, location, limit_name, model) (
    increase({
      "__name__"="generativelanguage.googleapis.com/quota/generate_content_free_tier_input_token_count/usage",
      "monitored_resource"="generativelanguage.googleapis.com/Location",
      "limit_name"=~".*PerMinute.*"
    }[1m])
  )
  /
  max by (resource_container, location, limit_name, model) (
    {
      "__name__"="generativelanguage.googleapis.com/quota/generate_content_free_tier_input_token_count/limit",
      "monitored_resource"="generativelanguage.googleapis.com/Location",
      "limit_name"=~".*PerMinute.*"
    }
  )
) >= 0.8
```

### RPD — 하루 누적 요청 수

정책과 조건 이름을 모두 `Gemini RPD 80%`로 지정한다.

```promql
(
  sum by (resource_container, location, limit_name, model) (
    increase({
      "__name__"="generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/usage",
      "monitored_resource"="generativelanguage.googleapis.com/Location",
      "limit_name"=~".*PerDay.*"
    }[23h])
  )
  /
  max by (resource_container, location, limit_name, model) (
    {
      "__name__"="generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/limit",
      "monitored_resource"="generativelanguage.googleapis.com/Location",
      "limit_name"=~".*PerDay.*"
    }
  )
) >= 0.8
```

RPM과 TPM은 1분짜리 순간 사용량을 놓치지 않도록 재검사 기간을 사용하지
않는다. RPD는 누적값이므로 1분 평가 간격과 2분 재검사 기간을 사용할 수 있다.
Google이 프로젝트에 실제로 노출한 `limit_name`을 Metrics Explorer에서 먼저
확인한 뒤, 가능하면 정규식 대신 그 정확한 이름으로 고정한다.

## 알아둘 점

- RPM과 TPM은 매 1분 창의 사용량이다. 경고가 도착할 때는 해당 1분 창이 이미
  지나갔을 수 있다.
- RPD는 Pacific Time 자정에 초기화된다. Google 공식 quota 예제 방식인 최근
  23시간 쿼리는 Pacific 달력 날짜와 최대 약 1시간 차이가 나는 근삿값이다.
- metric은 수집 후 보이기까지 최대 약 150초 걸릴 수 있고, Monitoring 평가와
  전송에도 시간이 추가될 수 있다. Discord의 시각은 실제 API 호출 시각이 아니라
  Google Cloud가 incident를 연 `감지 시각`이다.
- Gemini 한도는 API key가 아니라 Google Cloud 프로젝트 단위다. 같은 프로젝트의
  다른 key로 교체해도 RPM/RPD/TPM은 초기화되지 않는다.
- 정확한 Pacific 날짜 기준 RPD가 필요하면 모든 Gemini 호출을 여기담 서버에서
  직접 집계하는 별도 카운터가 필요하다.

## 로컬 검증

```bash
npx -y deno@2 fmt --check supabase/functions/gemini-quota-discord
npx -y deno@2 test supabase/functions/gemini-quota-discord/handler_test.ts
npx -y deno@2 check supabase/functions/gemini-quota-discord/index.ts
```

구현 파일은 `supabase/functions/gemini-quota-discord`에 있다.

## 공식 참고

- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Google Cloud Gemini quota metric 목록](https://docs.cloud.google.com/monitoring/api/metrics_gcp_d_h)
- [quota metric 80% PromQL 예제](https://docs.cloud.google.com/monitoring/alerts/using-quota-metrics)
- [Cloud Monitoring Webhook와 Basic Auth](https://docs.cloud.google.com/monitoring/support/notification-options)
