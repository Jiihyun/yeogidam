import {
  AUTO_SAVE,
  isReelSaveMode,
  type ReelSaveMode,
  responseForSaveMode,
} from "./workflow.ts";

export interface ReelRequestPayload {
  instagramUrl?: unknown;
  source?: unknown;
  clientRequestId?: unknown;
}

export interface BegunReelRequest {
  reelId: string;
  extractionId: string;
  workerReelId: string | null;
  processingStatus: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  failureReason: string | null;
  processingToken: string;
  shouldProcess: boolean;
  reused: boolean;
  duplicate: boolean;
  saveMode: ReelSaveMode;
  placeId: string | null;
  placeIds: string[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isIdempotencyKeyPayloadMismatch(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  return candidate.code === "22023" &&
    candidate.message === "idempotency_key_payload_mismatch";
}

/**
 * New clients persist this value across transport retries. Missing keys are
 * generated for old clients so deployments remain backwards compatible.
 */
export function clientRequestId(
  req: Request,
  payload: ReelRequestPayload,
  generate: () => string = () => crypto.randomUUID(),
): { value: string | null; provided: boolean } {
  const candidate = payload.clientRequestId ??
    req.headers.get("Idempotency-Key");
  if (candidate == null) {
    return { value: generate(), provided: false };
  }
  return {
    value: isUUID(candidate) ? candidate.toLowerCase() : null,
    provided: true,
  };
}

export function parseBegunReelRequest(
  data: unknown,
): BegunReelRequest | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  const processingStatus = candidate.processing_status;
  const failureReason = candidate.failure_reason;
  const requestedMode = candidate.save_mode ?? AUTO_SAVE;
  const placeId = candidate.place_id;
  const placeIds = candidate.place_ids;
  const workerReelId = candidate.worker_reel_id;
  const shouldProcess = candidate.should_process;

  if (
    !isUUID(candidate.reel_id) ||
    !isUUID(candidate.extraction_id) ||
    !(workerReelId == null || isUUID(workerReelId)) ||
    !isUUID(candidate.processing_token) ||
    !isReelSaveMode(requestedMode) ||
    ![
      "PENDING",
      "PROCESSING",
      "COMPLETED",
      "FAILED",
    ].includes(String(processingStatus)) ||
    !(failureReason == null || typeof failureReason === "string") ||
    typeof shouldProcess !== "boolean" ||
    (shouldProcess && !isUUID(workerReelId)) ||
    typeof candidate.reused !== "boolean" ||
    typeof candidate.duplicate !== "boolean" ||
    !(placeId == null || isUUID(placeId)) ||
    !Array.isArray(placeIds) ||
    !placeIds.every(isUUID)
  ) {
    return null;
  }

  return {
    reelId: candidate.reel_id,
    extractionId: candidate.extraction_id,
    workerReelId: workerReelId ?? null,
    processingStatus: processingStatus as BegunReelRequest["processingStatus"],
    failureReason: failureReason ?? null,
    processingToken: candidate.processing_token,
    shouldProcess,
    reused: candidate.reused,
    duplicate: candidate.duplicate,
    saveMode: requestedMode,
    placeId: placeId ?? null,
    placeIds,
  };
}

export function begunReelHTTPResult(
  reel: BegunReelRequest,
  requestedSaveMode: ReelSaveMode,
): { body: Record<string, unknown>; status: number } {
  const status = reel.processingStatus;
  const body = responseForSaveMode(
    {
      reelId: reel.reelId,
      status,
      ...(reel.failureReason ? { failureReason: reel.failureReason } : {}),
      ...(reel.placeId
        ? { placeId: reel.placeId, placeIds: reel.placeIds }
        : {}),
      reused: reel.reused,
    },
    requestedSaveMode,
    reel.saveMode,
  );
  return {
    body,
    status: status === "PENDING" || status === "PROCESSING" ? 202 : 200,
  };
}
