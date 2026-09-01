// 게시글 본문/캡션에서 한국 도로명 주소와 층·동·호 상세주소를 추출한다.

const SIDO =
  "서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|충청북도|충북|충청남도|충남|전북특별자치도|전라북도|전북|전라남도|전남|경상북도|경북|경상남도|경남|제주(?:특별자치도)?";

const ROAD_ADDRESS =
  `(?:${SIDO})\\s*[가-힣]{1,10}(?:시|군|구)\\s*[가-힣0-9]{1,20}(?:로|길)\\s*\\d+(?:-\\d+)?`;
const JIBUN_AREA = `(?:[가-힣]{1,20}(?:동|읍|면|리)|[가-힣]{1,20}\\d+가)`;
const JIBUN_ADDRESS =
  `(?:${SIDO})\\s*[가-힣]{1,10}(?:시|군|구)\\s*${JIBUN_AREA}\\s*(?:산\\s*)?\\d+(?:-\\d+)?`;
const ADDRESS_DETAIL =
  `(?:\\s+(?:(?:지하\\s*)?\\d+\\s*층|B\\d+\\s*층|\\d+(?:\\s*,\\s*\\d+)*\\s*F|\\d+\\s*동|\\d+\\s*호))*`;
const ADDRESS_RE = new RegExp(
  // 금남로5가처럼 "로+숫자+가"인 법정동을 도로명+건물번호로 먼저
  // 잘라 먹지 않도록 지번 주소를 먼저 시도한다.
  `(?:${JIBUN_ADDRESS}|${ROAD_ADDRESS})${ADDRESS_DETAIL}`,
  "gi",
);

export function extractKoreanAddresses(
  text: string | null | undefined,
): string[] {
  if (!text) return [];

  const seen = new Set<string>();
  for (const match of text.matchAll(ADDRESS_RE)) {
    const address = match[0].replace(/\s+/g, " ").trim();
    if (address) seen.add(address);
  }
  return [...seen];
}

export function extractKoreanAddress(
  text: string | null | undefined,
): string | null {
  return extractKoreanAddresses(text)[0] ?? null;
}
