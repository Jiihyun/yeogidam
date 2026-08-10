export interface InstagramReelReference {
  shortcode: string;
  canonicalUrl: string;
}

export interface ReelProcessingState {
  processingStatus: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  processingVersion: number;
  updatedAt: string;
}

const CONTENT_PATHS = new Set(["reel", "reels", "p", "tv"]);

export function parseInstagramReelURL(
  value: string,
): InstagramReelReference | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLocaleLowerCase("en-US");
  if (hostname !== "instagram.com" && hostname !== "www.instagram.com") {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || !CONTENT_PATHS.has(parts[0].toLowerCase())) {
    return null;
  }
  const shortcode = parts[1];
  if (!/^[A-Za-z0-9_-]+$/.test(shortcode)) return null;

  const contentPath = parts[0].toLowerCase() === "reels"
    ? "reel"
    : parts[0].toLowerCase();
  return {
    shortcode,
    canonicalUrl: `https://www.instagram.com/${contentPath}/${shortcode}/`,
  };
}

export function shouldRetryReel(
  state: ReelProcessingState,
  currentVersion: number,
  staleProcessingMs: number,
  now = Date.now(),
): boolean {
  if (state.processingVersion !== currentVersion) return true;
  if (state.processingStatus === "FAILED") return true;
  if (
    state.processingStatus !== "PENDING" &&
    state.processingStatus !== "PROCESSING"
  ) return false;

  const updatedAt = Date.parse(state.updatedAt);
  return Number.isFinite(updatedAt) && now - updatedAt >= staleProcessingMs;
}
