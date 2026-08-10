import { extractKoreanAddress, extractKoreanAddresses } from "./address.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("extracts a complete address including floor", () => {
  const caption = `무화과로 가득찬 디저트를 맛볼 수 있는 연희동 카페

📍보연희
서울 서대문구 연희맛로 17-63 2층`;

  assertEquals(
    extractKoreanAddress(caption),
    "서울 서대문구 연희맛로 17-63 2층",
  );
});

Deno.test("extracts basement, building, and unit address details", () => {
  assertEquals(
    extractKoreanAddress("주소: 서울 마포구 연남로1길 44 B1층"),
    "서울 마포구 연남로1길 44 B1층",
  );
  assertEquals(
    extractKoreanAddress("경기 성남시 판교역로 12 101동 202호"),
    "경기 성남시 판교역로 12 101동 202호",
  );
});

Deno.test("does not depend on a place marker or emoji", () => {
  const caption = `터틀힙 연남에서 복숭아 케이크를 소개합니다.
서울 마포구 연남로1길 44 1층
매일 12:00 - 21:00`;

  assertEquals(
    extractKoreanAddress(caption),
    "서울 마포구 연남로1길 44 1층",
  );
});

Deno.test("extracts every distinct road address in caption order", () => {
  const caption = `
    서울 서대문구 연희맛로 17-63 2층
    광주 동구 제봉로110번길 17 1층
    서울 서대문구 연희맛로 17-63 2층
  `;

  assertEquals(extractKoreanAddresses(caption), [
    "서울 서대문구 연희맛로 17-63 2층",
    "광주 동구 제봉로110번길 17 1층",
  ]);
});
