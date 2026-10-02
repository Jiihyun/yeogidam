import { isUUID } from "./request.ts";

export interface InternalReelRequest {
  action: "process_place_batch" | "retry_reel_processing";
  extractionId: string;
  workerReelId: string;
  processingToken: string;
}

export function parseInternalReelRequest(
  value: unknown,
): InternalReelRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    (payload.action !== "process_place_batch" &&
      payload.action !== "retry_reel_processing") ||
    !isUUID(payload.extractionId) || !isUUID(payload.workerReelId) ||
    !isUUID(payload.processingToken)
  ) return null;
  return {
    action: payload.action,
    extractionId: payload.extractionId,
    workerReelId: payload.workerReelId,
    processingToken: payload.processingToken,
  };
}
