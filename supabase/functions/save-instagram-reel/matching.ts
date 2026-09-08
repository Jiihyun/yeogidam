import type { PlaceGuess } from "./ai/types.ts";
import type { KakaoPlace } from "./kakao.ts";

export function searchKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR")
    .replace(/\s+/g, " ").trim();
}

/** 검색 비용을 제한하고 같은 질의를 중복 호출하지 않는다. 의미 검증은 하지 않는다. */
export function uniqueSearchQueries(values: string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const query = value.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!query || query.length > 80) continue;
    const key = searchKey(query);
    if (!unique.has(key)) unique.set(key, query);
  }
  return [...unique.values()];
}

/** 원문과 AI 보정 상호를 함께 검색한다. 오타 사전이나 글자 수 규칙을 두지 않는다. */
export function placeSearchNames(guess: PlaceGuess): string[] {
  return uniqueSearchQueries([
    guess.placeName,
    ...(guess.searchNames ?? []).slice(0, 3),
  ]);
}

export function buildKakaoQueries(guess: PlaceGuess): string[] {
  const names = placeSearchNames(guess);
  return uniqueSearchQueries([
    ...names,
    ...(guess.region ? names.map((name) => name + " " + guess.region) : []),
  ]);
}

export function deduplicateKakaoPlaces(candidates: KakaoPlace[]): KakaoPlace[] {
  const unique = new Map<string, KakaoPlace>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.kakaoPlaceId)) {
      unique.set(candidate.kakaoPlaceId, candidate);
    }
  }
  return [...unique.values()];
}

/** AI가 실제로 전달받은 Kakao ID만 수용하며 상호·주소를 다시 판정하지 않는다. */
export function selectedKakaoPlace(
  candidates: KakaoPlace[],
  candidateId: string | null,
): KakaoPlace | null {
  return candidates.find((place) => place.kakaoPlaceId === candidateId) ?? null;
}
