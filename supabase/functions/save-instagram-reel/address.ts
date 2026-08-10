// 게시글 본문/캡션에서 한국 도로명 주소와 층·동·호 상세주소를 추출한다.

const SIDO =
  "서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|충청북도|충북|충청남도|충남|전북특별자치도|전라북도|전북|전라남도|전남|경상북도|경북|경상남도|경남|제주(?:특별자치도)?";

const ROAD_ADDRESS =
  `(?:${SIDO})\\s*[가-힣]{1,10}(?:시|군|구)\\s*[가-힣0-9]{1,20}(?:로|길)\\s*\\d+(?:-\\d+)?`;
const ADDRESS_DETAIL =
  `(?:\\s+(?:(?:지하\\s*)?\\d+\\s*층|B\\d+\\s*층|\\d+\\s*동|\\d+\\s*호))*`;
const ADDRESS_RE = new RegExp(`${ROAD_ADDRESS}${ADDRESS_DETAIL}`, "i");

export function extractKoreanAddress(
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  const m = text.match(ADDRESS_RE);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}
