import { parseInstagramReelURL, shouldRetryReel } from "./reel.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("extracts the same shortcode from shared reel URL variants", () => {
  const expected = {
    shortcode: "Dbx5SpgJdKL",
    canonicalUrl: "https://www.instagram.com/reel/Dbx5SpgJdKL/",
  };

  assertEquals(
    parseInstagramReelURL(
      "https://www.instagram.com/reel/Dbx5SpgJdKL/?igsh=abc123",
    ),
    expected,
  );
  assertEquals(
    parseInstagramReelURL("https://instagram.com/reels/Dbx5SpgJdKL/"),
    expected,
  );
});

Deno.test("rejects non-Instagram hosts and profile URLs", () => {
  assertEquals(
    parseInstagramReelURL("https://example.com/reel/Dbx5SpgJdKL/"),
    null,
  );
  assertEquals(parseInstagramReelURL("https://instagram.com/yeogidam"), null);
});

Deno.test("retries outdated, failed, or stale processing rows", () => {
  const now = Date.parse("2026-08-10T14:00:00Z");
  const staleMs = 15 * 60 * 1000;

  assertEquals(
    shouldRetryReel(
      {
        processingStatus: "COMPLETED",
        processingVersion: 1,
        updatedAt: "2026-08-10T13:59:00Z",
      },
      2,
      staleMs,
      now,
    ),
    true,
  );
  assertEquals(
    shouldRetryReel(
      {
        processingStatus: "FAILED",
        processingVersion: 2,
        updatedAt: "2026-08-10T13:59:00Z",
      },
      2,
      staleMs,
      now,
    ),
    true,
  );
  assertEquals(
    shouldRetryReel(
      {
        processingStatus: "PROCESSING",
        processingVersion: 2,
        updatedAt: "2026-08-10T13:44:59Z",
      },
      2,
      staleMs,
      now,
    ),
    true,
  );
  assertEquals(
    shouldRetryReel(
      {
        processingStatus: "PROCESSING",
        processingVersion: 2,
        updatedAt: "2026-08-10T13:59:00Z",
      },
      2,
      staleMs,
      now,
    ),
    false,
  );
  assertEquals(
    shouldRetryReel(
      {
        processingStatus: "COMPLETED",
        processingVersion: 2,
        updatedAt: "2026-08-10T13:00:00Z",
      },
      2,
      staleMs,
      now,
    ),
    false,
  );
});
