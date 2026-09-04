export const AUTO_SAVE = "AUTO_SAVE" as const;
export const REVIEW_QUEUE = "REVIEW_QUEUE" as const;

export type ReelSaveMode = typeof AUTO_SAVE | typeof REVIEW_QUEUE;

export function isReelSaveMode(value: unknown): value is ReelSaveMode {
  return value === AUTO_SAVE || value === REVIEW_QUEUE;
}

/** 구버전 자동 저장 요구가 한 번이라도 있으면 queue mode로 되돌리지 않는다. */
export function dominantSaveMode(
  current: ReelSaveMode,
  requested: ReelSaveMode,
): ReelSaveMode {
  return current === AUTO_SAVE || requested === AUTO_SAVE
    ? AUTO_SAVE
    : REVIEW_QUEUE;
}

/** v1 응답은 그대로 두고 v2 응답에만 DB가 확정한 실제 mode를 노출한다. */
export function responseForSaveMode<T extends Record<string, unknown>>(
  body: T,
  requestedMode: ReelSaveMode,
  actualMode: ReelSaveMode,
): T | (T & { saveMode: ReelSaveMode }) {
  if (requestedMode === AUTO_SAVE) return body;
  return { ...body, saveMode: actualMode };
}
