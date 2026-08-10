import { extractKoreanAddress, extractPinnedPlaceName } from "./address.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("extracts address and pinned place from an Instagram caption", () => {
  const caption = `무화과로 가득찬 디저트를 맛볼 수 있는 연희동 카페

📍보연희
서울 서대문구 연희맛로 17-63 2층`;

  assertEquals(
    extractKoreanAddress(caption),
    "서울 서대문구 연희맛로 17-63",
  );
  assertEquals(extractPinnedPlaceName(caption), "보연희");
});
