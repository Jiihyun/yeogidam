import type { AiOperation, AiProviderName } from "./types.ts";

export type AiProviderFailureKind =
  | "AUTH"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NETWORK"
  | "UPSTREAM"
  | "BAD_REQUEST"
  | "CONTENT_BLOCKED"
  | "INVALID_RESPONSE"
  | "CANCELLED";

export interface AiProviderErrorOptions {
  status?: number | null;
  model?: string;
  retryable: boolean;
  cause?: unknown;
}

export class AiProviderError extends Error {
  readonly status: number | null;
  readonly model: string | null;
  readonly retryable: boolean;

  constructor(
    readonly provider: AiProviderName,
    readonly operation: AiOperation,
    readonly kind: AiProviderFailureKind,
    options: AiProviderErrorOptions,
  ) {
    super(
      `${provider}:${operation}:${kind}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AiProviderError";
    this.status = options.status ?? null;
    this.model = options.model ?? null;
    this.retryable = options.retryable;
  }
}

export class AiProvidersExhaustedError extends Error {
  constructor(readonly attempts: readonly AiProviderError[]) {
    super("all_ai_providers_failed");
    this.name = "AiProvidersExhaustedError";
  }
}

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

export function aiHttpError(
  provider: AiProviderName,
  operation: AiOperation,
  model: string,
  status: number,
): AiProviderError {
  if (status === 401 || status === 403) {
    return new AiProviderError(provider, operation, "AUTH", {
      status,
      model,
      retryable: false,
    });
  }
  if (status === 408) {
    return new AiProviderError(provider, operation, "TIMEOUT", {
      status,
      model,
      retryable: true,
    });
  }
  if (status === 429) {
    return new AiProviderError(provider, operation, "RATE_LIMITED", {
      status,
      model,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new AiProviderError(provider, operation, "UPSTREAM", {
      status,
      model,
      retryable: true,
    });
  }
  return new AiProviderError(provider, operation, "BAD_REQUEST", {
    status,
    model,
    retryable: false,
  });
}

export function isFallbackEligible(error: AiProviderError): boolean {
  return error.kind === "QUOTA_EXCEEDED" ||
    error.kind === "RATE_LIMITED" || error.kind === "TIMEOUT" ||
    error.kind === "NETWORK" || error.kind === "UPSTREAM" ||
    error.kind === "INVALID_RESPONSE";
}
