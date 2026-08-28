import type {
  AddressType,
  AiCandidateJudgment,
  AiCandidateJudgmentReason,
  PlaceGuess,
} from "./types.ts";

export class AiContractError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AiContractError";
  }
}

export const PLACE_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    places: {
      type: "array",
      items: {
        type: "object",
        properties: {
          placeName: { type: "string" },
          address: { type: ["string", "null"] },
          addressType: {
            type: "string",
            enum: ["ROAD", "JIBUN", "PARTIAL", "NONE"],
          },
          region: { type: ["string", "null"] },
        },
        required: ["placeName", "address", "addressType", "region"],
        additionalProperties: false,
      },
    },
  },
  required: ["places"],
  additionalProperties: false,
} as const;

export const CANDIDATE_JUDGMENT_JSON_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          guessIndex: { type: "integer", minimum: 0 },
          decision: {
            type: "string",
            enum: ["SELECT", "RETRY", "NONE"],
          },
          candidateId: { type: ["string", "null"] },
          retryQueries: {
            type: "array",
            maxItems: 3,
            items: { type: "string" },
          },
          reason: {
            type: "string",
            enum: [
              "MATCH",
              "CANDIDATE_MISSING",
              "AMBIGUOUS_SAME_NAME",
              "NAME_MISMATCH",
              "ADDRESS_CONFLICT",
              "INSUFFICIENT_CONTEXT",
            ],
          },
        },
        required: [
          "guessIndex",
          "decision",
          "candidateId",
          "retryQueries",
          "reason",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["decisions"],
  additionalProperties: false,
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new AiContractError(`${context} contains an unexpected field`);
  }
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AiContractError(`${context} must be a non-empty string`);
  }
  return value.trim();
}

function nullableString(value: unknown, context: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new AiContractError(`${context} must be a string or null`);
  }
  return value.trim() || null;
}

function addressType(value: unknown): AddressType {
  if (
    value === "ROAD" || value === "JIBUN" || value === "PARTIAL" ||
    value === "NONE"
  ) return value;
  throw new AiContractError("place.addressType is invalid");
}

function candidateJudgmentReason(
  value: unknown,
): AiCandidateJudgmentReason | null {
  return value === "MATCH" || value === "CANDIDATE_MISSING" ||
      value === "AMBIGUOUS_SAME_NAME" || value === "NAME_MISMATCH" ||
      value === "ADDRESS_CONFLICT" || value === "INSUFFICIENT_CONTEXT"
    ? value
    : null;
}

function retryQueries(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 3) {
    throw new AiContractError("decision.retryQueries must contain 0-3 strings");
  }
  const unique = new Map<string, string>();
  for (const item of value) {
    const query = requiredString(item, "decision.retryQueries[]");
    if (query.length > 80) {
      throw new AiContractError(
        "decision.retryQueries[] must be at most 80 characters",
      );
    }
    const key = query.normalize("NFKC").toLocaleLowerCase("ko-KR")
      .replace(/\s+/g, " ");
    if (!unique.has(key)) unique.set(key, query.replace(/\s+/g, " "));
  }
  return [...unique.values()];
}

export function parseJsonPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AiContractError("AI response text is not valid JSON", cause);
  }
}

export function parsePlaceExtractionPayload(payload: unknown): PlaceGuess[] {
  const root = record(payload);
  if (!root || !Array.isArray(root.places)) {
    throw new AiContractError("AI place response is missing places[]");
  }
  assertOnlyKeys(root, ["places"], "AI place response");

  const guesses: PlaceGuess[] = [];
  for (const item of root.places) {
    const raw = record(item);
    if (!raw) {
      throw new AiContractError(
        "AI place response contains a non-object place",
      );
    }
    assertOnlyKeys(
      raw,
      ["placeName", "address", "addressType", "region"],
      "AI place",
    );
    guesses.push({
      placeName: requiredString(raw.placeName, "place.placeName"),
      address: nullableString(raw.address, "place.address"),
      addressType: addressType(raw.addressType),
      region: nullableString(raw.region, "place.region"),
    });
  }
  return guesses;
}

export function parseCandidateJudgmentPayload(
  payload: unknown,
  expectedGuessIndexes?: readonly number[],
): AiCandidateJudgment[] {
  const root = record(payload);
  if (!root || !Array.isArray(root.decisions)) {
    throw new AiContractError("AI judgment response is missing decisions[]");
  }
  assertOnlyKeys(root, ["decisions"], "AI judgment response");

  const judgments: AiCandidateJudgment[] = [];
  const seen = new Set<number>();
  for (const item of root.decisions) {
    const raw = record(item);
    if (!raw) {
      throw new AiContractError(
        "AI judgment response contains a non-object decision",
      );
    }
    assertOnlyKeys(
      raw,
      ["guessIndex", "decision", "candidateId", "retryQueries", "reason"],
      "AI judgment decision",
    );
    const guessIndex = raw.guessIndex;
    if (
      typeof guessIndex !== "number" || !Number.isInteger(guessIndex) ||
      guessIndex < 0
    ) {
      throw new AiContractError("decision.guessIndex is invalid");
    }
    if (seen.has(guessIndex)) {
      throw new AiContractError(
        "AI judgment response has duplicate guessIndex",
      );
    }

    const reason = candidateJudgmentReason(raw.reason);
    if (!reason) throw new AiContractError("decision.reason is invalid");
    const queries = retryQueries(raw.retryQueries);
    const candidateId = nullableString(
      raw.candidateId,
      "decision.candidateId",
    );

    if (
      raw.decision === "NONE" && reason !== "MATCH" &&
      reason !== "CANDIDATE_MISSING" && candidateId === null &&
      queries.length === 0
    ) {
      seen.add(guessIndex);
      judgments.push({
        guessIndex,
        decision: "NONE",
        candidateId: null,
        retryQueries: [],
        reason,
      });
      continue;
    }

    if (
      raw.decision === "RETRY" && reason === "CANDIDATE_MISSING" &&
      candidateId === null && queries.length > 0
    ) {
      seen.add(guessIndex);
      judgments.push({
        guessIndex,
        decision: "RETRY",
        candidateId: null,
        retryQueries: queries,
        reason,
      });
      continue;
    }

    if (
      raw.decision === "SELECT" && candidateId && reason === "MATCH" &&
      queries.length === 0
    ) {
      seen.add(guessIndex);
      judgments.push({
        guessIndex,
        decision: "SELECT",
        candidateId,
        retryQueries: [],
        reason,
      });
      continue;
    }

    throw new AiContractError("AI judgment decision fields are inconsistent");
  }

  if (expectedGuessIndexes) {
    const expected = new Set(expectedGuessIndexes);
    if (
      expected.size !== expectedGuessIndexes.length ||
      judgments.length !== expected.size ||
      judgments.some((judgment) => !expected.has(judgment.guessIndex))
    ) {
      throw new AiContractError(
        "AI judgment response does not cover every requested guessIndex",
      );
    }
  }

  return judgments;
}
