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
  }
  if (guess.address) queries.push(guess.address);

  return [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
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

function hardRegionTokens(value: string | null): string[] {
  if (!value) return [];
  const tokens = value.normalize("NFKC").split(/[^가-힣0-9]+/)
    .filter(Boolean);
  return [
    ...new Set(
      tokens.filter((token) =>
        METRO_ALIASES.has(token) ||
        /^[가-힣]{1,}(?:특별시|광역시|특별자치시|특별자치도|도|시|군|구|동|읍|면|리)$/
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
  const candidateCompact = compact(candidate);
  const tokens = hardRegionTokens(source);
  if (tokens.some((token) => !candidateCompact.includes(token))) return false;

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

export function verifiedKakaoPlaces(
  guess: PlaceGuess,
  candidates: KakaoPlace[],
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

    if (guess.address) {
      if (!addressMatches(guess.address, location)) continue;
      if (typoName && !hasStrongAddressEvidence(guess.address, location)) {
        continue;
      }
    } else {
      if (typoName) continue;
      const regionTokens = hardRegionTokens(guess.region);
      const locationCompact = compact(location);
      if (
        regionTokens.length > 0 &&
        regionTokens.some((token) => !locationCompact.includes(token))
      ) continue;
    }

    unique.set(candidate.kakaoPlaceId, candidate);
  }

  return [...unique.values()];
}
