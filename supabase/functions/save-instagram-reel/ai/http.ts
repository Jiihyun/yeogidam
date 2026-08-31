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
  errorBodyStatus?: AiErrorBodyStatus;
}

const MAX_ERROR_BODY_BYTES = 32 * 1024;

export type AiErrorBodyStatus =
  | "PARSED"
  | "EMPTY"
  | "TOO_LARGE"
  | "INVALID_JSON"
  | "READ_TIMEOUT"
  | "READ_FAILED";

interface BoundedErrorJson {
  payload: unknown | null;
  status: AiErrorBodyStatus;
}

type SignalAwareRead =
  | { aborted: true }
  | { aborted: false; result: ReadableStreamReadResult<Uint8Array> };

function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<SignalAwareRead> {
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: SignalAwareRead) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(cause);
    };
    const onAbort = () => finish({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => finish({ aborted: false, result }),
      fail,
    );
  });
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  void reader.cancel().catch(() => undefined);
}

async function readBoundedErrorJson(
  response: Response,
  signal: AbortSignal,
): Promise<BoundedErrorJson> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_ERROR_BODY_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return { payload: null, status: "TOO_LARGE" };
  }

  const reader = response.body?.getReader();
  if (!reader) return { payload: null, status: "EMPTY" };
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  try {
    while (true) {
      const read = await readWithSignal(reader, signal);
      if (read.aborted) {
        cancelReader(reader);
        return { payload: null, status: "READ_TIMEOUT" };
      }
      const chunk = read.result;
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_ERROR_BODY_BYTES) {
        cancelReader(reader);
        return { payload: null, status: "TOO_LARGE" };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    cancelReader(reader);
    return {
      payload: null,
      status: signal.aborted ? "READ_TIMEOUT" : "READ_FAILED",
    };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }

  if (!text.trim()) return { payload: null, status: "EMPTY" };

  try {
    return { payload: JSON.parse(text), status: "PARSED" };
  } catch {
    return { payload: null, status: "INVALID_JSON" };
  }
}

/**
 * Applies one deadline to both the HTTP exchange and response body read.
 * HTTP 429 bodies are parsed only within a small byte limit so callers can
 * inspect quota metadata without retaining or logging raw provider payloads.
 * Other non-success bodies remain unconsumed and are classified by status.
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
    if (!response.ok) {
      const errorBody = response.status === 429
        ? await readBoundedErrorJson(response, controller.signal)
        : null;
      if (response.status !== 429 && controller.signal.aborted) {
        throw new AiRequestTimeoutError();
      }
      return {
        response,
        payload: errorBody?.payload ?? null,
        ...(errorBody ? { errorBodyStatus: errorBody.status } : {}),
      };
    }

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
