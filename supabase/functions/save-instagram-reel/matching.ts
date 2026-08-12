import type { PlaceGuess } from "./gemini.ts";
import type { KakaoPlace } from "./kakao.ts";

function compact(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}-]+/gu, "");
}

function appearsInCaption(value: string, caption: string): boolean {
  const needle = compact(value);
  return needle.length > 0 && compact(caption).includes(needle);
}

export function sanitizePlaceGuesses(
  guesses: PlaceGuess[],
  caption: string,
): PlaceGuess[] {
  const seen = new Set<string>();
  const sanitized: PlaceGuess[] = [];

  for (const guess of guesses) {
    if (!appearsInCaption(guess.placeName, caption)) continue;

    const address = guess.address && appearsInCaption(guess.address, caption)
      ? guess.address.trim()
      : null;
    const region = guess.region && appearsInCaption(guess.region, caption)
      ? guess.region.trim()
      : null;

    // 전국 상호명 단독 검색은 임의 지점을 만들 수 있으므로 위치 근거가 필수다.
    if (!address && !region) continue;

    const item: PlaceGuess = {
      placeName: guess.placeName.trim(),
      address,
      addressType: address ? guess.addressType : "NONE",
      region,
    };
    const key = [item.placeName, item.address, item.region].map((value) =>
      compact(value ?? "")
    ).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    sanitized.push(item);
  }
  return sanitized;
}

export function buildKakaoQueries(guess: PlaceGuess): string[] {
  const queries: string[] = [];
  if (guess.placeName && guess.address) {
    queries.push(`${guess.placeName} ${guess.address}`);
  }
  if (guess.region && guess.placeName) {
    queries.push(`${guess.region} ${guess.placeName}`);
  } else if (guess.address && guess.placeName) {
    const addressRegion = searchRegionFromAddress(guess.address);
    if (addressRegion) queries.push(`${addressRegion} ${guess.placeName}`);
  }
  if (guess.address) queries.push(guess.address);

  return [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
}

// 1차 검색이 실제로 후보를 하나도 돌려주지 않았을 때만 실행하는 제한된 확장 검색이다.
// 같은 요청 안에서 이 목록은 최대 한 번만 소비하며, 다시 1차 검색으로 돌아가지 않는다.
export function buildKakaoFallbackQueries(guess: PlaceGuess): string[] {
  return canUseNameOnlyKakaoFallback(guess) ? [guess.placeName.trim()] : [];
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

function searchRegionFromAddress(value: string): string | null {
  const tokens = value.normalize("NFKC").split(/[^가-힣0-9]+/)
    .filter(Boolean);
  const nonMetroTokens = tokens.filter((token) => !METRO_ALIASES.has(token));
  return nonMetroTokens.find((token) => /^[가-힣]+(?:시|군|구)$/.test(token)) ??
    nonMetroTokens.find((token) => /^[가-힣]+(?:읍|면|동|리)$/.test(token)) ??
    null;
}

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
          .test(
            token,
          )
      ).map(compact),
    ),
  ];
}

function buildingNumber(value: string): string | null {
  const match = value.normalize("NFKC").match(
    /(?:^|\s)(?:산\s*)?(\d+(?:-\d+)?)(?=\s|$|번지|,|\))/,
  );
  return match?.[1] ?? null;
}

function hasBuildingNumber(value: string, expected: string): boolean {
  const matches = value.normalize("NFKC").matchAll(
    /(?:^|\s)(?:산\s*)?(\d+(?:-\d+)?)(?=\s|$|번지|,|\))/g,
  );
  return [...matches].some((match) => match[1] === expected);
}

function candidateLocation(place: KakaoPlace): string {
  return [place.roadAddress, place.address].filter(Boolean).join(" ");
}

function addressMatches(source: string, candidate: string): boolean {
  const tokens = hardRegionTokens(source);
  if (tokens.some((token) => !hasRegionToken(candidate, token))) return false;

  const sourceRoad = roadToken(source);
  if (sourceRoad) {
    const candidateRoad = roadToken(candidate);
    if (!candidateRoad || !roadMatchesOrHasTransposedDigits(source, candidate)) {
      return false;
    }
  }

  const number = buildingNumber(source);
  if (number && !hasBuildingNumber(candidate, number)) return false;

  return tokens.length > 0 || number !== null;
}

function exactNameMatches(expected: string, actual: string): boolean {
  const expectedName = compact(expected);
  const actualName = compact(actual);
  if (!expectedName || !actualName) return false;
  if (actualName === expectedName) return true;

  // Kakao가 원문 상호 뒤에 지점명을 덧붙이는 경우만 허용한다.
  if (actualName.startsWith(expectedName)) {
    const suffix = actualName.slice(expectedName.length);
    return /(?:점|본점|지점|호점|관|센터)$/.test(suffix);
  }
  return false;
}

function differsByOneCharacter(left: string, right: string): boolean {
  if (left === right || Math.abs(left.length - right.length) > 1) return false;

  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }

  if (leftIndex < left.length || rightIndex < right.length) edits += 1;
  return edits === 1;
}

function likelyNameTypo(expected: string, actual: string): boolean {
  const expectedName = compact(expected);
  const actualName = compact(actual);
  return expectedName.length >= 4 && actualName.length >= 4 &&
    differsByOneCharacter(expectedName, actualName);
}

function roadToken(value: string): string | null {
  const token = value.normalize("NFKC").split(/\s+/).find((part) =>
    /^[가-힣][가-힣0-9.·-]*(?:대로|로|길)$/.test(part)
  );
  return token ? compact(token) : null;
}

function isAdjacentTransposition(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  const differences: number[] = [];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) differences.push(index);
  }
  if (differences.length !== 2 || differences[1] !== differences[0] + 1) {
    return false;
  }
  const [first, second] = differences;
  return left[first] === right[second] && left[second] === right[first];
}

function roadMatchesOrHasTransposedDigits(
  source: string,
  candidate: string,
): boolean {
  const sourceRoad = roadToken(source);
  const candidateRoad = roadToken(candidate);
  if (!sourceRoad || !candidateRoad) return false;
  if (sourceRoad === candidateRoad) return true;

  const sourceShape = sourceRoad.replace(/\d/g, "#");
  const candidateShape = candidateRoad.replace(/\d/g, "#");
  if (sourceShape !== candidateShape) return false;

  const sourceDigits = sourceRoad.replace(/\D/g, "");
  const candidateDigits = candidateRoad.replace(/\D/g, "");
  return sourceDigits.length > 1 &&
    isAdjacentTransposition(sourceDigits, candidateDigits);
}

function hasStrongAddressEvidence(source: string, candidate: string): boolean {
  if (!addressMatches(source, candidate)) return false;

  const number = buildingNumber(source);
  if (!number || !hasBuildingNumber(candidate, number)) return false;

  const sourceRoad = roadToken(source);
  if (sourceRoad) return roadMatchesOrHasTransposedDigits(source, candidate);

  // 지번 주소는 동/읍/면/리와 번지가 모두 맞을 때만 한 글자 상호명 보정을 허용한다.
  return hardRegionTokens(source).some((token) =>
    /(?:동|읍|면|리)$/.test(token)
  );
}

export function canUseNameOnlyKakaoFallback(guess: PlaceGuess): boolean {
  if (!guess.address || !buildingNumber(guess.address)) return false;

  return roadToken(guess.address) !== null ||
    hardRegionTokens(guess.address).some((token) =>
      /(?:동|읍|면|리)$/.test(token)
    );
}

export interface VerifyKakaoOptions {
  requireStrongAddressEvidence?: boolean;
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

export function verifiedKakaoPlaces(
  guess: PlaceGuess,
  candidates: KakaoPlace[],
  options: VerifyKakaoOptions = {},
): KakaoPlace[] {
  const unique = new Map<string, KakaoPlace>();

  for (const candidate of candidates) {
    const exactName = exactNameMatches(guess.placeName, candidate.name);
    const typoName = !exactName && likelyNameTypo(
      guess.placeName,
      candidate.name,
    );
    if (!exactName && !typoName) continue;
    const location = candidateLocation(candidate);
    const addressForComparison = guess.address && roadToken(guess.address)
      ? candidate.roadAddress
      : candidate.address ?? candidate.roadAddress;

    if (guess.address) {
      if (
        !addressForComparison ||
        !addressMatches(guess.address, addressForComparison)
      ) continue;
      if (
        (typoName || options.requireStrongAddressEvidence) &&
        !hasStrongAddressEvidence(guess.address, addressForComparison)
      ) {
        continue;
      }
    } else {
      if (typoName) continue;
      const regionTokens = hardRegionTokens(guess.region);
      if (
        regionTokens.length > 0 &&
        regionTokens.some((token) => !hasRegionToken(location, token))
      ) continue;
    }

    unique.set(candidate.kakaoPlaceId, candidate);
  }

  return [...unique.values()];
}

const MAX_AI_REVIEW_CANDIDATES = 10;

export type KakaoCandidateDecision =
  | { type: "NO_CANDIDATE" }
  | { type: "AUTO_MATCH"; place: KakaoPlace }
  | {
    type: "NEEDS_AI_REVIEW";
    reason: "NO_VERIFIED_CANDIDATE" | "MULTIPLE_VERIFIED_CANDIDATES";
    candidates: KakaoPlace[];
  };

/**
 * Kakao 원본 후보와 결정론적 검증 결과를 상태로 바꾼다.
 *
 * - 원본 후보 0개: 검색 확장 대상으로 보낸다(2차 AI에는 보낼 후보가 없다).
 * - 검증 후보 1개: 코드가 바로 확정한다.
 * - 나머지: 유한한 후보 목록만 2차 AI에 넘긴다.
 */
export function classifyKakaoCandidates(
  guess: PlaceGuess,
  candidates: KakaoPlace[],
  options: VerifyKakaoOptions = {},
): KakaoCandidateDecision {
  const uniqueCandidates = deduplicateKakaoPlaces(candidates);
  if (uniqueCandidates.length === 0) return { type: "NO_CANDIDATE" };

  const verified = verifiedKakaoPlaces(guess, uniqueCandidates, options);
  if (verified.length === 1) {
    return { type: "AUTO_MATCH", place: verified[0] };
  }

  // 검증된 후보를 앞에 두고, 나머지는 이름이 가까운 순서로 배치한다.
  // 후보 수를 제한해 두 번째 AI 호출의 입력 크기와 비용도 상한을 둔다.
  let reviewCandidates: KakaoPlace[];
  if (verified.length > 1) {
    // 이미 코드 검증을 통과한 후보가 복수라면 그 후보끼리만 지점을 판별한다.
    reviewCandidates = verified.slice(0, MAX_AI_REVIEW_CANDIDATES);
  } else {
    const nameRelated = uniqueCandidates.filter((candidate) =>
      exactNameMatches(guess.placeName, candidate.name) ||
      likelyNameTypo(guess.placeName, candidate.name)
    );
    const nameRelatedIds = new Set(
      nameRelated.map((place) => place.kakaoPlaceId),
    );
    const remaining = uniqueCandidates.filter((candidate) =>
      !nameRelatedIds.has(candidate.kakaoPlaceId)
    );
    reviewCandidates = [...nameRelated, ...remaining].slice(
      0,
      MAX_AI_REVIEW_CANDIDATES,
    );
  }

  return {
    type: "NEEDS_AI_REVIEW",
    reason: verified.length === 0
      ? "NO_VERIFIED_CANDIDATE"
      : "MULTIPLE_VERIFIED_CANDIDATES",
    candidates: reviewCandidates,
  };
}

type AiCandidateRejectionReason =
  | "AI_SELECTED_UNKNOWN_CANDIDATE"
  | "REGION_CONFLICT"
  | "ROAD_CONFLICT"
  | "BUILDING_NUMBER_CONFLICT"
  | "UNRESOLVED_MULTI_REGION"
  | "NAME_MISMATCH"
  | "INSUFFICIENT_ADDRESS_EVIDENCE";

export type AiCandidateResolution =
  | { status: "ACCEPTED"; place: KakaoPlace }
  | { status: "REJECTED"; reason: AiCandidateRejectionReason };

export interface AiCandidateResolutionOptions {
  requireStrongAddressEvidence?: boolean;
}

function addressPrefixThroughBuildingNumber(value: string): string {
  const normalized = value.normalize("NFKC");
  const match = normalized.match(
    /(?:^|\s)(?:산\s*)?\d+(?:-\d+)?(?=\s|$|번지|,|\))/,
  );
  return match?.index === undefined
    ? normalized
    : normalized.slice(0, match.index + match[0].length);
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

type RegionLevel =
  | "PROVINCE"
  | "CITY"
  | "DISTRICT"
  | "COUNTY"
  | "NEIGHBORHOOD"
  | "TOWNSHIP"
  | "VILLAGE";

function regionLevel(token: string): RegionLevel | null {
  const canonical = regionAliases(token).at(-1) ?? compact(token);
  if (METRO_ALIASES.has(canonical)) return "PROVINCE";
  if (/(?:특별시|광역시|특별자치시|특별자치도|도)$/.test(token)) {
    return "PROVINCE";
  }
  if (/시$/.test(token)) return "CITY";
  if (/구$/.test(token)) return "DISTRICT";
  if (/군$/.test(token)) return "COUNTY";
  if (/동$/.test(token)) return "NEIGHBORHOOD";
  if (/읍$/.test(token)) return "TOWNSHIP";
  if (/면$/.test(token)) return "TOWNSHIP";
  if (/리$/.test(token)) return "VILLAGE";
  return null;
}

function hasHardRegionConflict(
  sourceTokens: string[],
  candidateLocation: string,
): boolean {
  const candidateTokens = hardRegionTokens(candidateLocation);
  return sourceTokens.some((sourceToken) => {
    if (hasRegionToken(candidateLocation, sourceToken)) return false;
    const level = regionLevel(sourceToken);
    if (!level) return false;

    // 후보 주소에 같은 행정 단계가 명시되어 있을 때만 불일치로 본다.
    // 후보가 해당 단계를 생략했다면 UNKNOWN으로 두어 AI 판단을 다시 막지 않는다.
    return candidateTokens.some((candidateToken) =>
      regionLevel(candidateToken) === level
    );
  });
}

function finalGuardRegionTokens(guess: PlaceGuess): string[] {
  const explicitRegion = hardRegionTokens(guess.region);
  // AI가 상세 주소 끝에 상호명까지 복사했더라도 `연하동` 같은 상호를
  // 행정동으로 해석하지 않도록 상호 원문을 먼저 걷어낸다.
  const addressWithoutPlaceName = guess.address?.replaceAll(
    guess.placeName,
    " ",
  ) ?? null;
  const addressPrefix = addressWithoutPlaceName
    ? addressPrefixThroughBuildingNumber(addressWithoutPlaceName)
    : null;
  return [...new Set([...explicitRegion, ...hardRegionTokens(addressPrefix)])];
}

function provinceIdentity(token: string): string | null {
  const aliases = regionAliases(token);
  const knownAlias = aliases.find((alias) => METRO_ALIASES.has(alias));
  if (knownAlias) return knownAlias;
  return regionLevel(token) === "PROVINCE" ? compact(token) : null;
}

function sourceProvinceIdentities(guess: PlaceGuess): string[] {
  const tokens = finalGuardRegionTokens(guess);
  return [...new Set(
    tokens.map(provinceIdentity).filter(
      (value): value is string => value !== null,
    ),
  )];
}

function candidateProvinceIdentity(candidate: KakaoPlace): string | null {
  const location = candidateLocation(candidate);
  for (const token of hardRegionTokens(location)) {
    const identity = provinceIdentity(token);
    if (identity) return identity;
  }
  return null;
}

function comparableBuildingNumber(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.normalize("NFKC");
  const scoped = normalized.match(
    /(?:대로|로|길|동|읍|면|리)\s*(?:산\s*)?(\d+(?:-\d+)?)(?=\s|$|번지|,|\))/,
  );
  return scoped?.[1] ?? buildingNumber(normalized);
}

function matchingAddressEvidence(
  guess: PlaceGuess,
  candidate: KakaoPlace,
): boolean {
  if (!guess.address) return false;

  const sourceRoad = roadToken(guess.address);
  const candidateRoadAddress = candidate.roadAddress;
  if (sourceRoad && candidateRoadAddress) {
    const candidateRoad = roadToken(candidateRoadAddress);
    const sourceNumber = comparableBuildingNumber(guess.address);
    const candidateNumber = comparableBuildingNumber(candidateRoadAddress);
    return Boolean(
      candidateRoad && roadMatchesOrHasTransposedDigits(
        guess.address,
        candidateRoadAddress,
      ) && sourceNumber && candidateNumber && sourceNumber === candidateNumber,
    );
  }

  const sourceNumber = comparableBuildingNumber(guess.address);
  const candidateNumber = comparableBuildingNumber(candidate.address);
  if (!sourceNumber || !candidateNumber || sourceNumber !== candidateNumber) {
    return false;
  }
  const sourceLocalities = hardRegionTokens(
    addressPrefixThroughBuildingNumber(guess.address),
  ).filter((token) => /(?:동|읍|면|리)$/.test(token));
  const candidateAddress = candidate.address;
  if (!candidateAddress) return false;
  return sourceLocalities.length > 0 && sourceLocalities.every((token) =>
    hasRegionToken(candidateAddress, token)
  );
}

function hasPlausibleNameRelation(expected: string, actual: string): boolean {
  if (
    exactNameMatches(expected, actual) || likelyNameTypo(expected, actual)
  ) return true;

  const expectedName = compact(expected);
  const actualName = compact(actual);
  return expectedName.length >= 2 && actualName.length >= 2 &&
    (expectedName.includes(actualName) || actualName.includes(expectedName));
}

function hasUnresolvedMultiRegion(
  guess: PlaceGuess,
  candidates: KakaoPlace[],
): boolean {
  if (sourceProvinceIdentities(guess).length > 0) return false;

  const sourceAddress = guess.address;
  const sourceLocalities = sourceAddress
    ? hardRegionTokens(addressPrefixThroughBuildingNumber(sourceAddress))
      .filter((token) => /(?:동|읍|면|리)$/.test(token))
    : [];
  const hasDetailedAddress = Boolean(
    sourceAddress && comparableBuildingNumber(sourceAddress) &&
      (roadToken(sourceAddress) || sourceLocalities.length > 0),
  );

  const plausibleCandidates = candidates.filter((candidate) => {
    const nameEvidence = hasPlausibleNameRelation(
      guess.placeName,
      candidate.name,
    );
    return nameEvidence &&
      (!hasDetailedAddress || matchingAddressEvidence(guess, candidate));
  });
  const provinces = new Set(
    plausibleCandidates.map(candidateProvinceIdentity).filter(
      (value): value is string => value !== null,
    ),
  );
  return provinces.size > 1;
}

/**
 * 2차 AI는 Kakao가 실제 반환한 ID만 고를 수 있다. 그 뒤에도 명시적인
 * 지역·도로명·건물번호 모순은 코드가 거부한다. 파싱하지 못한 값(UNKNOWN)은
 * 모순으로 취급하지 않지만, 이름 또는 상세 주소의 양성 근거는 하나 필요하다.
 */
export function resolveAiSelectedKakaoPlace(
  guess: PlaceGuess,
  candidates: KakaoPlace[],
  candidateId: string,
  options: AiCandidateResolutionOptions = {},
): AiCandidateResolution {
  const candidate = deduplicateKakaoPlaces(candidates).find((place) =>
    place.kakaoPlaceId === candidateId
  );
  if (!candidate) {
    return {
      status: "REJECTED",
      reason: "AI_SELECTED_UNKNOWN_CANDIDATE",
    };
  }

  if (hasUnresolvedMultiRegion(guess, candidates)) {
    return { status: "REJECTED", reason: "UNRESOLVED_MULTI_REGION" };
  }

  const location = candidateLocation(candidate);
  const regionTokens = finalGuardRegionTokens(guess);
  if (hasHardRegionConflict(regionTokens, location)) {
    return { status: "REJECTED", reason: "REGION_CONFLICT" };
  }

  if (guess.address) {
    const sourceRoad = roadToken(guess.address);
    const candidateRoadAddress = candidate.roadAddress;
    const candidateRoad = candidateRoadAddress
      ? roadToken(candidateRoadAddress)
      : null;
    if (
      sourceRoad && candidateRoad && candidateRoadAddress &&
      !roadMatchesOrHasTransposedDigits(guess.address, candidateRoadAddress)
    ) {
      return { status: "REJECTED", reason: "ROAD_CONFLICT" };
    }

    const sourceNumber = comparableBuildingNumber(guess.address);
    const candidateAddress = sourceRoad
      ? candidate.roadAddress
      : candidate.address;
    const candidateNumber = comparableBuildingNumber(candidateAddress);
    if (
      sourceNumber && candidateNumber && sourceNumber !== candidateNumber
    ) {
      return {
        status: "REJECTED",
        reason: "BUILDING_NUMBER_CONFLICT",
      };
    }
  }

  const addressEvidence = matchingAddressEvidence(guess, candidate);
  if (options.requireStrongAddressEvidence && !addressEvidence) {
    return {
      status: "REJECTED",
      reason: "INSUFFICIENT_ADDRESS_EVIDENCE",
    };
  }

  const nameEvidence = hasPlausibleNameRelation(
    guess.placeName,
    candidate.name,
  );
  if (!nameEvidence) {
    return { status: "REJECTED", reason: "NAME_MISMATCH" };
  }

  return { status: "ACCEPTED", place: candidate };
}
