// 응답 본문 처리까지 동일한 요청 제한 시간을 적용한다.
export async function mediaHttp<T>(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("source_analysis_request_timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      request(url, { ...init, signal: controller.signal }).then((response) =>
        consume(response, controller.signal)
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function sourceJson(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  return await mediaHttp(request, url, init, timeoutMs, async (response) => {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`source_analysis_http_${response.status}`);
    }
    return await response.json();
  });
}
