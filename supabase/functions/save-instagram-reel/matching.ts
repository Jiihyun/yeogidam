import type { PlaceGuess } from "./gemini.ts";
import type { KakaoPlace } from "./kakao.ts";

function compact(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}-]+/gu, "");
}

function compactPlaceName(value: string): string {
  return compact(value).replaceAll("-", "");
}

function appearsInCaption(
  value: string,
  caption: string,
  normalize: (input: string) => string = compact,
): boolean {
  const needle = normalize(value);
  return needle.length > 0 && normalize(caption).includes(needle);
}

export function sanitizePlaceGuesses(
  guesses: PlaceGuess[],
  caption: string,
): PlaceGuess[] {
  const seen = new Set<string>();
  const sanitized: PlaceGuess[] = [];

  for (const guess of guesses) {
    if (
      !appearsInCaption(guess.placeName, caption, compactPlaceName)
    ) continue;

    const address = guess.address && appearsInCaption(guess.address, caption)
      ? guess.address.trim()
      : null;
    const region = guess.region && appearsInCaption(guess.region, caption)
      ? guess.region.trim()
      : null;

    const item: PlaceGuess = {
      placeName: guess.placeName.trim(),
      address,
      addressType: address ? guess.addressType : "NONE",
      region,
    };
    const key = [
      compactPlaceName(item.placeName),
      compact(item.address ?? ""),
      compact(item.region ?? ""),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    sanitized.push(item);
  }
  return sanitized;
}

/**
 * Kakao의 장소 키워드 검색은 장소명을 중심으로 호출한다. 주소와 지역은
 * 검색어에 섞지 않고, 복수 후보를 좁힐 때만 위치 근거로 사용한다.
 */
export function buildKakaoQueries(guess: PlaceGuess): string[] {
  const placeName = guess.placeName.trim();
  return placeName ? [placeName] : [];
}

const METRO_ALIASES = new Set([
  "서울",
  "부산",
  "대구",
  "인천",
  "광주",
  "대전",
  "울산",
  "세종",
  "경기",
  "강원",
  "충북",
  "충남",
  "전북",
  "전남",
  "경북",
  "경남",
  "제주",
]);

const PROVINCE_NAMES = new Set([
  "경기도",
  "강원도",
  "충청북도",
  "충청남도",
  "전라북도",
  "전라남도",
  "경상북도",
  "경상남도",
  "제주도",
]);

function hardRegionTokens(value: string | null): string[] {
  if (!value) return [];
  const tokens = value.normalize("NFKC").split(/[^가-힣0-9]+/)
    .filter(Boolean);
  return [
    ...new Set(
      tokens.filter((token) =>
        METRO_ALIASES.has(token) ||
        PROVINCE_NAMES.has(token) ||
        /^[가-힣]{1,}(?:특별시|광역시|특별자치시|특별자치도|시|군|구|동|읍|면|리)$/
          .test(token)
      ).map(compact),
    ),
  ];
}

function regionAliases(token: string): string[] {
  const normalized = compact(token);
  const fullToShort: Record<string, string> = {
    서울특별시: "서울",
    부산광역시: "부산",
    대구광역시: "대구",
    인천광역시: "인천",
    광주광역시: "광주",
    대전광역시: "대전",
    울산광역시: "울산",
    세종특별자치시: "세종",
    경기도: "경기",
    강원특별자치도: "강원",
    강원도: "강원",
    충청북도: "충북",
    충청남도: "충남",
    전북특별자치도: "전북",
    전라북도: "전북",
    전라남도: "전남",
    경상북도: "경북",
    경상남도: "경남",
    제주특별자치도: "제주",
    제주도: "제주",
  };
  return [...new Set([normalized, fullToShort[normalized]].filter(Boolean))];
}

function hasRegionToken(location: string, token: string): boolean {
  const expectedAliases = new Set(regionAliases(token));
  return hardRegionTokens(location).some((locationToken) =>
    regionAliases(locationToken).some((alias) => expectedAliases.has(alias))
  );
}

function roadToken(value: string): string | null {
  const token = value.normalize("NFKC").match(
    /(?:^|\s)([가-힣][가-힣0-9.·-]*(?:대로|로|길))(?=\s*(?:산\s*)?\d|\s|$|,|\))/,
  )?.[1];
  return token ? compact(token) : null;
}

function comparableBuildingNumber(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.normalize("NFKC");
  const scoped = normalized.match(
    /(?:대로|로|길|동|읍|면|리)\s*(?:산\s*)?(\d+(?:-\d+)?)(?=\s|$|번지|,|\))/,
  );
  if (scoped?.[1]) return scoped[1];
  return normalized.match(
    /(?:^|\s)(?:산\s*)?(\d+(?:-\d+)?)(?=\s|$|번지|,|\))/,
  )?.[1] ?? null;
}

function candidateLocation(place: KakaoPlace): string {
  return [place.roadAddress, place.address].filter(Boolean).join(" ");
}

function addressMatches(
  source: string,
  candidate: string,
  supplementalRegion: string | null,
): boolean {
  const regionTokens = [
    ...new Set([
      ...hardRegionTokens(source),
      ...hardRegionTokens(supplementalRegion),
    ]),
  ];
  if (regionTokens.some((token) => !hasRegionToken(candidate, token))) {
    return false;
  }

  const sourceRoad = roadToken(source);
  const candidateRoad = roadToken(candidate);
  if (sourceRoad && sourceRoad !== candidateRoad) return false;

  const sourceNumber = comparableBuildingNumber(source);
  const candidateNumber = comparableBuildingNumber(candidate);
  if (sourceNumber && sourceNumber !== candidateNumber) return false;

  // 건물번호는 전국 여러 주소에서 반복되므로 단독 양성 근거로 쓰지 않는다.
  return regionTokens.length > 0 || sourceRoad !== null;
}

/**
 * Instagram 프로필 표시 이름 보정에서 쓰는 상세주소 자격 판정이다.
 * Kakao 검색 fallback과는 무관하다.
 */
export function hasDetailedAddressEvidence(guess: PlaceGuess): boolean {
  if (!guess.address || !comparableBuildingNumber(guess.address)) return false;
  return roadToken(guess.address) !== null ||
    hardRegionTokens(guess.address).some((token) =>
      /(?:동|읍|면|리)$/.test(token)
    );
}

export function deduplicateKakaoPlaces(
  candidates: KakaoPlace[],
): KakaoPlace[] {
  const unique = new Map<string, KakaoPlace>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.kakaoPlaceId)) {
      unique.set(candidate.kakaoPlaceId, candidate);
    }
  }
  return [...unique.values()];
}

/**
 * 복수 Kakao 후보가 있을 때만 캡션의 주소·지역으로 후보를 좁힌다.
 * 파싱 가능한 위치 근거가 없거나 일치 후보가 없으면 빈 배열을 반환해
 * 호출자가 원본 후보 전체를 2차 Gemini에 전달하도록 한다.
 */
export function locationMatchedKakaoPlaces(
  guess: PlaceGuess,
  candidates: KakaoPlace[],
): KakaoPlace[] {
  const uniqueCandidates = deduplicateKakaoPlaces(candidates);

  if (guess.address) {
    const sourceHasRoad = roadToken(guess.address) !== null;
    return uniqueCandidates.filter((candidate) => {
      const candidateAddress = sourceHasRoad
        ? candidate.roadAddress
        : candidate.address ?? candidate.roadAddress;
      return Boolean(
        candidateAddress &&
          addressMatches(guess.address!, candidateAddress, guess.region),
      );
    });
  }

  const regionTokens = hardRegionTokens(guess.region);
  if (regionTokens.length === 0) return [];
  return uniqueCandidates.filter((candidate) => {
    const location = candidateLocation(candidate);
    return regionTokens.every((token) => hasRegionToken(location, token));
  });
}

const MAX_AI_REVIEW_CANDIDATES = 15;

export type KakaoCandidateDecision =
  | { type: "NO_CANDIDATE" }
  | { type: "AUTO_MATCH"; place: KakaoPlace }
  | { type: "NEEDS_AI_REVIEW"; candidates: KakaoPlace[] };

/**
 * 중복 제거한 Kakao 원본 후보 수를 우선한다.
 *
 * - 0개: 장소를 찾지 못함
 * - 1개: 이름·주소 추가 검증 없이 자동 확정
 * - 2개 이상: 위치 근거로 정확히 하나만 특정되면 자동 확정
 * - 그 외: Kakao 정확도순 원본 후보 전체를 2차 Gemini에 전달
 */
export function classifyKakaoCandidates(
  guess: PlaceGuess,
  candidates: KakaoPlace[],
): KakaoCandidateDecision {
  const uniqueCandidates = deduplicateKakaoPlaces(candidates);
  if (uniqueCandidates.length === 0) return { type: "NO_CANDIDATE" };
  if (uniqueCandidates.length === 1) {
    return { type: "AUTO_MATCH", place: uniqueCandidates[0] };
  }

  const locationMatches = locationMatchedKakaoPlaces(guess, uniqueCandidates);
  if (locationMatches.length === 1) {
    return { type: "AUTO_MATCH", place: locationMatches[0] };
  }

  return {
    type: "NEEDS_AI_REVIEW",
    candidates: uniqueCandidates.slice(0, MAX_AI_REVIEW_CANDIDATES),
  };
}

export type AiCandidateResolution =
  | { status: "ACCEPTED"; place: KakaoPlace }
  | { status: "REJECTED"; reason: "AI_SELECTED_UNKNOWN_CANDIDATE" };

/**
 * 2차 Gemini의 의미 판단을 코드 규칙으로 다시 뒤집지 않는다.
 * Gemini가 실제로 전달받은 Kakao 후보 ID를 선택했는지만 확인한다.
 */
export function resolveAiSelectedKakaoPlace(
  candidates: KakaoPlace[],
  candidateId: string,
): AiCandidateResolution {
  const candidate = deduplicateKakaoPlaces(candidates).find((place) =>
    place.kakaoPlaceId === candidateId
  );
  return candidate
    ? { status: "ACCEPTED", place: candidate }
    : { status: "REJECTED", reason: "AI_SELECTED_UNKNOWN_CANDIDATE" };
}
