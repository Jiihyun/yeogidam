export class AiRequestTimeoutError extends Error {
  constructor(cause?: unknown) {
    super(
      "AI request timed out",
      cause === undefined ? undefined : { cause },
    );
    this.name = "AiRequestTimeoutError";
  }
}

export class AiResponseJsonError extends Error {
  constructor(cause: unknown) {
    super("AI response body is not valid JSON", { cause });
    this.name = "AiResponseJsonError";
  }
}

export interface AiJsonResponse {
  response: Response;
  payload: unknown | null;
}

/**
 * Applies one deadline to both the HTTP exchange and the successful response
 * body read. Non-success bodies are intentionally not consumed because callers
 * classify them by status only and must not log provider payloads.
 */
export async function fetchJsonWithTimeout(
  request: typeof fetch,
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
): Promise<AiJsonResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(input, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) return { response, payload: null };

    try {
      return { response, payload: await response.json() };
    } catch (cause) {
      if (controller.signal.aborted) throw new AiRequestTimeoutError(cause);
      throw new AiResponseJsonError(cause);
    }
  } catch (cause) {
    if (
      cause instanceof AiRequestTimeoutError ||
      cause instanceof AiResponseJsonError
    ) throw cause;
    if (controller.signal.aborted) throw new AiRequestTimeoutError(cause);
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}
