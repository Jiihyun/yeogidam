import { AiConfigError } from "./errors.ts";
import { createFallbackPlaceAiClient } from "./fallback.ts";
import type { AiLog, PlaceAiClient, PlaceAiProvider } from "./provider.ts";
import { createGeminiProvider } from "./providers/gemini.ts";
import { createOpenAiProvider } from "./providers/openai.ts";
import type { AiProviderName } from "./types.ts";

export interface EnvReader {
  get(name: string): string | undefined;
}

interface ProviderConfig {
  name: AiProviderName;
  apiKey: string;
  fallbackApiKeys?: string[];
  extractionModel: string;
  judgmentModel: string;
  timeoutMs: number;
}

export interface PlaceAiConfig {
  primary: ProviderConfig;
  fallback?: ProviderConfig;
}

export interface PlaceAiFactoryDependencies {
  fetch?: typeof fetch;
  log?: AiLog;
}

function value(env: EnvReader, name: string): string | null {
  return env.get(name)?.trim() || null;
}

function values(env: EnvReader, name: string): string[] {
  const raw = env.get(name);
  if (!raw) return [];
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function providerName(
  raw: string | null,
  defaultName?: AiProviderName,
): AiProviderName {
  const normalized = raw?.toLocaleLowerCase("en-US") ?? defaultName;
  if (normalized === "gemini" || normalized === "openai") return normalized;
  throw new AiConfigError(`Unsupported AI provider: ${raw ?? "missing"}`);
}

function timeoutMs(env: EnvReader): number {
  const raw = value(env, "PLACE_AI_TIMEOUT_MS");
  if (!raw) return 10_000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new AiConfigError("PLACE_AI_TIMEOUT_MS must be 1000-120000");
  }
  return parsed;
}

function loadProvider(
  env: EnvReader,
  name: AiProviderName,
  requestTimeoutMs: number,
): ProviderConfig {
  if (name === "gemini") {
    const apiKey = value(env, "GEMINI_API_KEY");
    if (!apiKey) throw new AiConfigError("GEMINI_API_KEY is required");
    const fallbackApiKeys = values(env, "GEMINI_API_KEY_FALLBACKS");
    if (
      new Set([apiKey, ...fallbackApiKeys]).size !== fallbackApiKeys.length + 1
    ) {
      throw new AiConfigError(
        "GEMINI_API_KEY_FALLBACKS must contain unique keys",
      );
    }
    const extractionModel = value(env, "GEMINI_MODEL") ??
      "gemini-3.5-flash-lite";
    return {
      name,
      apiKey,
      ...(fallbackApiKeys.length > 0 ? { fallbackApiKeys } : {}),
      extractionModel,
      judgmentModel: value(env, "GEMINI_MATCH_MODEL") ?? extractionModel,
      timeoutMs: requestTimeoutMs,
    };
  }

  const apiKey = value(env, "OPENAI_API_KEY");
  const extractionModel = value(env, "OPENAI_MODEL");
  if (!apiKey) throw new AiConfigError("OPENAI_API_KEY is required");
  if (!extractionModel) throw new AiConfigError("OPENAI_MODEL is required");
  return {
    name,
    apiKey,
    extractionModel,
    judgmentModel: value(env, "OPENAI_MATCH_MODEL") ?? extractionModel,
    timeoutMs: requestTimeoutMs,
  };
}

export function loadPlaceAiConfig(env: EnvReader): PlaceAiConfig {
  const requestTimeoutMs = timeoutMs(env);
  const primaryName = providerName(
    value(env, "PLACE_AI_PRIMARY_PROVIDER"),
    "gemini",
  );
  const fallbackValue = value(env, "PLACE_AI_FALLBACK_PROVIDER");
  const fallbackName = fallbackValue ? providerName(fallbackValue) : null;
  if (fallbackName === primaryName) {
    throw new AiConfigError("Primary and fallback AI providers must differ");
  }
  return {
    primary: loadProvider(env, primaryName, requestTimeoutMs),
    ...(fallbackName
      ? { fallback: loadProvider(env, fallbackName, requestTimeoutMs) }
      : {}),
  };
}

function createProvider(
  config: ProviderConfig,
  dependencies: PlaceAiFactoryDependencies,
): PlaceAiProvider {
  const providerConfig = {
    apiKey: config.apiKey,
    extractionModel: config.extractionModel,
    judgmentModel: config.judgmentModel,
    timeoutMs: config.timeoutMs,
  };
  return config.name === "gemini"
    ? createGeminiProvider(
      {
        ...providerConfig,
        fallbackApiKeys: config.fallbackApiKeys,
      },
      { fetch: dependencies.fetch, log: dependencies.log },
    )
    : createOpenAiProvider(providerConfig, { fetch: dependencies.fetch });
}

export function createPlaceAiClient(
  env: EnvReader,
  dependencies: PlaceAiFactoryDependencies = {},
): PlaceAiClient {
  const config = loadPlaceAiConfig(env);
  return createFallbackPlaceAiClient(
    createProvider(config.primary, dependencies),
    config.fallback ? createProvider(config.fallback, dependencies) : undefined,
    { log: dependencies.log },
  );
}
