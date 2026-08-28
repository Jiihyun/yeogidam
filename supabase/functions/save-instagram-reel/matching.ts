import type { PlaceGuess } from "./ai/types.ts";
import type { KakaoPlace } from "./kakao.ts";

function compact(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}-]+/gu, "");
}

function compactPlaceName(value: string): string {
  return compact(value).replaceAll("-", "");
}

/** 같은 장소 항목 주변 문맥만 잘라 다른 장소의 지역 단서가 섞이지 않게 한다. */
export function captionContextsForPlaceName(
  caption: string,
  placeName: string,
  otherPlaceNames: string[] = [],
): string[] {
  const normalizedName = placeName.normalize("NFKC").trim().toLocaleLowerCase(
    "ko-KR",
  );
  if (!normalizedName) return [];
  const segments = caption.normalize("NFKC").split(
    /(?:[\r\n|/•▶▷▪◾📍📌]+|[,;:：!?。！？…]+|\s+[–—-]\s+|(?<![A-Za-z0-9])\.(?![A-Za-z0-9]))/,
  )
    .map((segment) => segment.trim()).filter(Boolean);
  const normalizedOthers = otherPlaceNames
    .map((name) => name.normalize("NFKC").trim().toLocaleLowerCase("ko-KR"))
    .filter((name) => name && name !== normalizedName);
  const contexts: string[] = [];
  for (const segment of segments) {
    const normalizedSegment = segment.toLocaleLowerCase("ko-KR");
    const index = normalizedSegment.indexOf(normalizedName);
    if (index < 0) continue;
    const nameEnd = index + normalizedName.length;
    let start = Math.max(0, index - 100);
    let end = Math.min(segment.length, nameEnd + 100);
    for (const otherName of normalizedOthers) {
      let otherIndex = normalizedSegment.indexOf(otherName);
      while (otherIndex >= 0) {
        const otherEnd = otherIndex + otherName.length;
        if (otherEnd <= index) {
          start = Math.max(start, Math.floor((otherEnd + index) / 2));
        } else if (otherIndex >= nameEnd) {
          end = Math.min(end, Math.ceil((nameEnd + otherIndex) / 2) + 1);
        }
        otherIndex = normalizedSegment.indexOf(otherName, otherIndex + 1);
      }
    }
    contexts.push(segment.slice(start, end));
    if (contexts.length === 3) break;
  }
  return contexts;
}

function editDistance(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

const HANGUL_INITIALS = [
  "g",
  "kk",
  "n",
  "d",
  "tt",
  "r",
  "m",
  "b",
  "pp",
  "s",
  "ss",
  "",
  "j",
  "jj",
  "ch",
  "k",
  "t",
  "p",
  "h",
];
const HANGUL_VOWELS = [
  "a",
  "ae",
  "ya",
  "yae",
  "eo",
  "e",
  "yeo",
  "ye",
  "o",
  "wa",
  "wae",
  "oe",
  "yo",
  "u",
  "wo",
  "we",
  "wi",
  "yu",
  "eu",
  "ui",
  "i",
];
const HANGUL_FINALS = [
  "",
  "k",
  "k",
  "ks",
  "n",
  "n",
  "nh",
  "t",
  "l",
  "lk",
  "lm",
  "lb",
  "ls",
  "lt",
  "lp",
  "lh",
  "m",
  "p",
  "ps",
  "t",
  "t",
  "ng",
  "t",
  "t",
  "k",
  "t",
  "p",
  "h",
];

function romanizeHangul(value: string): string {
  let result = "";
  for (const character of value.normalize("NFKC")) {
    const code = character.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) {
      if (/[A-Za-z0-9]/.test(character)) result += character.toLowerCase();
      continue;
    }
    const initial = Math.floor(code / 588);
    const vowel = Math.floor((code % 588) / 28);
    const final = code % 28;
    result += HANGUL_INITIALS[initial] + HANGUL_VOWELS[vowel] +
      HANGUL_FINALS[final];
  }
  return result;
}

function canonicalLatin(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "")
    .replace(/^woo/, "u").replace(/oo/g, "u").replace(/ee/g, "i")
    .replace(/z/g, "j");
}

function canonicalTransliteration(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function handleNameCompatible(handle: string, placeName: string): boolean {
  const match = handle.match(/^@([A-Za-z0-9]+)(?:[._-].*)?$/);
  if (!match) return false;
  const handleName = canonicalLatin(match[1]);
  const romanized = canonicalLatin(romanizeHangul(placeName));
  if (!handleName || !romanized) return false;
  return handleName === romanized;
}

function transliteratedNamesCompatible(left: string, right: string): boolean {
  const leftHasHangul = /[가-힣]/.test(left);
  const rightHasHangul = /[가-힣]/.test(right);
  const leftHasLatin = /[A-Za-z]/.test(left);
  const rightHasLatin = /[A-Za-z]/.test(right);
  if (leftHasHangul === rightHasHangul) return false;
  if (!(leftHasLatin || rightHasLatin)) return false;

  const hangul = leftHasHangul ? left : right;
  const latin = leftHasHangul ? right : left;
  if (/[^A-Za-z0-9\s._-]/.test(latin)) return false;
  const romanized = canonicalTransliteration(romanizeHangul(hangul)).replace(
    /eu$/,
    "",
  );
  return romanized.length >= 2 &&
    romanized === canonicalTransliteration(latin);
}

function namesCompatibleWithoutTypo(left: string, right: string): boolean {
  const a = compactPlaceName(left);
  const b = compactPlaceName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (transliteratedNamesCompatible(left, right)) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (longer.startsWith(shorter)) {
    const suffix = longer.slice(shorter.length);
    if (
      /^(?:본점|직영점|\d+호점|[\p{L}\p{N}]{1,10}점)$/u.test(suffix)
    ) return true;
  }
  return false;
}

function namesHaveSingleCharacterTypo(left: string, right: string): boolean {
  const a = compactPlaceName(left);
  const b = compactPlaceName(right);
  const leftLength = Array.from(a).length;
  const rightLength = Array.from(b).length;
  return leftLength === rightLength && leftLength >= 3 &&
    editDistance(a, b) === 1;
}

function administrativeLocationStem(value: string): string {
  return compact(value).replace(
    /(?:특별자치도|특별자치시|특별시|광역시|시|군|구|동|읍|면|리)$/u,
    "",
  );
}

/**
 * Kakao가 `상호 군자`처럼 행정동을 이름 뒤에 붙이는 경우를 다룬다.
 * 상세주소가 실제로 일치할 때만 호출하며, 접미사도 후보 주소의 행정구역과
 * 일치해야 하므로 임의의 체인 지점명이나 다른 업종을 이름 유사도로 통과시키지 않는다.
 */
function nameMatchesCandidateWithLocationSuffix(
  sourceName: string,
  candidate: KakaoPlace,
): boolean {
  const tokens = candidate.name.normalize("NFKC").trim().split(/\s+/u)
    .filter(Boolean);
  if (tokens.length < 2) return false;

  const baseName = tokens.slice(0, -1).join(" ");
  if (
    !namesCompatibleWithoutTypo(sourceName, baseName) &&
    !namesHaveSingleCharacterTypo(sourceName, baseName)
  ) return false;

  const suffix = administrativeLocationStem(
    compact(tokens.at(-1) ?? "").replace(/점$/u, ""),
  );
  if (Array.from(suffix).length < 2) return false;
  return hardRegionTokens(candidateLocation(candidate)).some((token) =>
    administrativeLocationStem(token) === suffix
  );
}

/** 띄어쓰기·구두점·한 글자 오타와 지점 접미사 정도만 같은 이름으로 본다. */
export function placeNamesCompatible(left: string, right: string): boolean {
  return namesCompatibleWithoutTypo(left, right) ||
    namesHaveSingleCharacterTypo(left, right);
}

function appearsInCaption(
  value: string,
  caption: string,
  normalize: (input: string) => string = compact,
): boolean {
  const needle = normalize(value);
  return needle.length > 0 && normalize(caption).includes(needle);
}

function placeNameGroundedInCaption(
  placeName: string,
  caption: string,
): boolean {
  const normalizedName = placeName.normalize("NFKC").trim()
    .toLocaleLowerCase("ko-KR");
  const normalizedCaption = caption.normalize("NFKC").toLocaleLowerCase(
    "ko-KR",
  );
  const characters = Array.from(normalizedName).filter((character) =>
    /[\p{L}\p{N}]/u.test(character)
  );
  if (characters.length === 0) return false;
  const pattern = new RegExp(characters.join("[\\s._·-]*"), "gu");
  for (const match of normalizedCaption.matchAll(pattern)) {
    const index = match.index;
    const before = index === 0 ? "" : normalizedCaption[index - 1];
    const after = normalizedCaption.slice(index + match[0].length);
    const beforeGrounded = !before || !/[\p{L}\p{N}]/u.test(before);
    const suffix = after.match(
      /^(?:에서|으로|은|는|이|가|을|를|와|과|도|만|의|부터|까지|에|로|맛집|카페|방문|후기)/u,
    )?.[0] ?? null;
    const suffixRemainder = suffix ? after.slice(suffix.length) : "";
    const afterGrounded = !after || /^[^\p{L}\p{N}]/u.test(after) ||
      Boolean(
        suffix &&
          (!suffixRemainder || /^[^\p{L}\p{N}]/u.test(suffixRemainder)),
      );
    if (beforeGrounded && afterGrounded) return true;
  }
  return false;
}

function occurrenceIndices(value: string, needle: string): number[] {
  const indices: number[] = [];
  let index = value.indexOf(needle);
  while (index >= 0) {
    indices.push(index);
    index = value.indexOf(needle, index + 1);
  }
  return indices;
}

function spanDistance(
  leftStart: number,
  leftLength: number,
  rightStart: number,
  rightLength: number,
): number {
  const leftEnd = leftStart + leftLength;
  const rightEnd = rightStart + rightLength;
  if (leftEnd <= rightStart) return rightStart - leftEnd;
  if (rightEnd <= leftStart) return leftStart - rightEnd;
  return 0;
}

function lineLooksLocationOnly(line: string): boolean {
  const tokens = line.normalize("NFKC")
    .replace(
      /(?:주소|위치|도로명|지번|지역)(?:은|는|이|가)?\s*[:：]?/g,
      " ",
    )
    .split(/[^가-힣A-Za-z0-9.-]+/).filter(Boolean);
  return tokens.length > 0 &&
    tokens.every((token) =>
      hardRegionTokens(token).length > 0 ||
      /^[가-힣][가-힣0-9.·-]*(?:대로|로|길|번길)$/.test(token) ||
      /^(?:산)?\d+(?:-\d+)?(?:번지|층|호)?$/.test(token) ||
      /^[A-Za-z]\d*(?:동|관)$/.test(token)
    );
}

function withoutTrailingPlaceName(line: string, placeName: string): string {
  const trimmed = line.trimEnd();
  if (!trimmed.endsWith(placeName)) return line;
  const start = trimmed.length - placeName.length;
  const before = start === 0 ? "" : trimmed[start - 1];
  return before && /[\p{L}\p{N}]/u.test(before)
    ? line
    : trimmed.slice(0, start);
}

const LOCATION_BRIDGE_WORDS = new Set([
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "와",
  "과",
  "의",
  "에",
  "에서",
  "로",
  "으로",
  "있는",
  "위치한",
  "근처",
  "맛집",
  "맛집추천",
  "카페",
  "카페추천",
  "신상",
  "신상카페",
  "신상맛집",
  "핫플",
  "술집",
  "디저트",
  "여행",
  "데이트",
  "주소",
  "주소는",
  "주소가",
  "위치",
  "위치는",
  "위치가",
  "도로명",
  "도로명은",
  "지번",
  "지번은",
  "지역",
  "지역은",
]);

function locationBridgeOnly(bridge: string): boolean {
  const tokens = bridge.normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/gu).filter(Boolean);
  if (tokens.length === 0) return !/[^\s#@]/u.test(bridge);
  return tokens.every((token) => LOCATION_BRIDGE_WORDS.has(token));
}

function fieldOccurrenceIsBounded(
  caption: string,
  index: number,
  fieldLength: number,
  regionOnly: boolean,
): boolean {
  const before = index === 0 ? "" : caption[index - 1];
  if (before && /[\p{L}\p{N}]/u.test(before)) return false;
  const after = caption.slice(index + fieldLength);
  if (!after || /^[^\p{L}\p{N}]/u.test(after)) return true;
  const allowedSuffix = regionOnly
    ? /^(?:에서|으로|은|는|이|가|을|를|와|과|의|에|로|근처|맛집(?:추천)?|카페(?:추천)?|신상(?:카페|맛집)?|핫플|술집|디저트|여행|데이트)(?=$|[^\p{L}\p{N}])/u
    : /^(?:에서|으로|은|는|이|가|을|를|와|과|의|에|로)(?=$|[^\p{L}\p{N}])/u;
  return allowedSuffix.test(after);
}

function bridgeCrossesAnotherItem(bridge: string): boolean {
  if (bridge.includes("\n")) return false;
  if (
    /(?:주소|위치|도로명|지번|지역)(?:은|는|이|가)?\s*[:：]/.test(
      bridge,
    )
  ) return false;
  return /[,;:.：!?。！？…·|/•▶▷▪◾📍📌–—]/u.test(bridge) ||
    /\p{Extended_Pictographic}/u.test(bridge) ||
    /\s-\s/u.test(bridge);
}

function hasNonLocationContinuation(
  caption: string,
  fieldEnd: number,
): boolean {
  const after = caption.slice(fieldEnd, fieldEnd + 40);
  return /^(?:에서|으로부터|의)?\s*(?:공수|태어|출신|배송|가져|생산|재배|수입|사\s*온|구매)/u
    .test(after);
}

function fieldGroundedToPlace(
  caption: string,
  placeName: string,
  field: string,
  allPlaceNames: string[],
): boolean {
  const normalizedPlace = placeName.normalize("NFKC").trim()
    .toLocaleLowerCase("ko-KR");
  const normalizedField = field.normalize("NFKC").trim().toLocaleLowerCase(
    "ko-KR",
  );
  if (!normalizedPlace || !normalizedField) return false;
  const contexts = captionContextsForPlaceName(
    caption,
    placeName,
    allPlaceNames,
  );
  if (contexts.length === 0) return false;

  const normalizedCaption = caption.normalize("NFKC").toLocaleLowerCase(
    "ko-KR",
  );
  const placeIndices = occurrenceIndices(normalizedCaption, normalizedPlace);
  const regionOnly = roadToken(field) === null &&
    comparableBuildingNumber(field) === null &&
    hardRegionTokens(field).length > 0;
  const fieldIndices = occurrenceIndices(normalizedCaption, normalizedField)
    .filter((fieldIndex) =>
      fieldOccurrenceIsBounded(
        normalizedCaption,
        fieldIndex,
        normalizedField.length,
        regionOnly,
      )
    );
  const otherPlaces = allPlaceNames.map((name) =>
    name.normalize("NFKC").trim().toLocaleLowerCase("ko-KR")
  ).filter((name) => name && name !== normalizedPlace);

  for (const fieldIndex of fieldIndices) {
    const nearestPlace = placeIndices.map((placeIndex) => ({
      placeIndex,
      distance: spanDistance(
        placeIndex,
        normalizedPlace.length,
        fieldIndex,
        normalizedField.length,
      ),
    })).filter(({ distance }) => distance > 0)
      .sort((left, right) => left.distance - right.distance)[0];
    if (!nearestPlace || nearestPlace.distance > 240) continue;

    const nearestPlaceEnd = nearestPlace.placeIndex + normalizedPlace.length;
    const fieldEnd = fieldIndex + normalizedField.length;
    const nearestBridge = fieldIndex >= nearestPlaceEnd
      ? normalizedCaption.slice(nearestPlaceEnd, fieldIndex)
      : normalizedCaption.slice(fieldEnd, nearestPlace.placeIndex);
    const nearestSharesLine = !nearestBridge.includes("\n");

    const nearerOtherExists = otherPlaces.some((otherName) =>
      occurrenceIndices(normalizedCaption, otherName).some((otherIndex) => {
        const otherDistance = spanDistance(
          otherIndex,
          otherName.length,
          fieldIndex,
          normalizedField.length,
        );
        if (otherDistance < nearestPlace.distance) return true;
        if (otherDistance > nearestPlace.distance) return false;
        const otherEnd = otherIndex + otherName.length;
        const otherBridge = fieldIndex >= otherEnd
          ? normalizedCaption.slice(otherEnd, fieldIndex)
          : normalizedCaption.slice(fieldEnd, otherIndex);
        const otherSharesLine = !otherBridge.includes("\n");
        return !(nearestSharesLine && !otherSharesLine);
      })
    );
    if (nearerOtherExists) continue;

    const placeEnd = nearestPlaceEnd;
    const bridge = nearestBridge;
    if (bridgeCrossesAnotherItem(bridge)) continue;
    if (bridge.includes("\n")) {
      const lineStart = normalizedCaption.lastIndexOf("\n", fieldIndex) + 1;
      const nextBreak = normalizedCaption.indexOf("\n", fieldEnd);
      const lineEnd = nextBreak < 0 ? normalizedCaption.length : nextBreak;
      const fieldLine = withoutTrailingPlaceName(
        normalizedCaption.slice(lineStart, lineEnd),
        normalizedPlace,
      );
      const hasExplicitLabel =
        /(?:주소|위치|도로명|지번|지역)(?:은|는|이|가)?\s*[:：]?/.test(
          fieldLine,
        );
      const hasDetailedAddress = roadToken(fieldLine) !== null &&
        comparableBuildingNumber(fieldLine) !== null;
      if (
        !lineLooksLocationOnly(fieldLine) ||
        (!hasExplicitLabel && !hasDetailedAddress)
      ) {
        continue;
      }
    }
    // A list marker at the start of the next line belongs to that line, not to
    // a separate place item. The next-line branch above has already required
    // the whole line to be a detailed address (or explicitly labelled), so it
    // is safe to ignore only these presentation markers here.
    const locationBridge = bridge.includes("\n") && fieldIndex >= placeEnd
      ? bridge.replace(/[•▶▷▪◾📍📌]/gu, " ")
      : bridge;
    if (!locationBridgeOnly(locationBridge)) continue;
    if (
      fieldIndex >= placeEnd &&
      hasNonLocationContinuation(normalizedCaption, fieldEnd)
    ) continue;
    return true;
  }
  return false;
}

export function sanitizePlaceGuesses(
  guesses: PlaceGuess[],
  caption: string,
): PlaceGuess[] {
  const seen = new Set<string>();
  const sanitized: PlaceGuess[] = [];
  const allPlaceNames = guesses.map((guess) => guess.placeName);

  for (const guess of guesses) {
    if (!placeNameGroundedInCaption(guess.placeName, caption)) continue;

    const address = guess.address &&
        compact(guess.address) !== compactPlaceName(guess.placeName) &&
        fieldGroundedToPlace(
          caption,
          guess.placeName,
          guess.address,
          allPlaceNames,
        )
      ? guess.address.trim()
      : null;
    const region = guess.region &&
        compact(guess.region) !== compactPlaceName(guess.placeName) &&
        (fieldGroundedToPlace(
          caption,
          guess.placeName,
          guess.region,
          allPlaceNames,
        ) ||
          Boolean(address && compact(address).includes(compact(guess.region))))
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

const REGION_LATIN_ALIASES: Record<string, string[]> = {
  서울: ["seoul"],
  부산: ["busan", "pusan"],
  대구: ["daegu", "taegu"],
  인천: ["incheon"],
  광주: ["gwangju", "kwangju"],
  대전: ["daejeon", "taejon"],
  울산: ["ulsan"],
  세종: ["sejong"],
  경기: ["gyeonggi", "kyonggi"],
  강원: ["gangwon", "kangwon"],
  제주: ["jeju", "cheju"],
};

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

function hasHardLocationEvidence(guess: PlaceGuess): boolean {
  return Boolean(
    roadToken(guess.address ?? "") ||
      hardRegionTokens(guess.address).length > 0 ||
      placeRegionTokens(guess).length > 0,
  );
}

function placeRegionTokens(guess: PlaceGuess): string[] {
  const placeName = compactPlaceName(guess.placeName);
  return hardRegionTokens(guess.region).filter((token) => token !== placeName);
}

function adjacentHandlesForPlace(caption: string, placeName: string): string[] {
  const normalizedName = placeName.normalize("NFKC").toLocaleLowerCase(
    "ko-KR",
  );
  const lines = caption.normalize("NFKC").split(/\r?\n/);
  const handles = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (!line.toLocaleLowerCase("ko-KR").includes(normalizedName)) continue;
    for (const adjacent of [lines[index - 1], lines[index + 1]]) {
      const handle = adjacent?.trim().match(
        /^(@[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)\b/,
      )?.[1];
      if (handle) handles.add(handle);
    }
  }
  return [...handles];
}

function captionRegionHints(
  guess: PlaceGuess,
  caption: string,
  otherPlaceNames: string[] = [],
): string[] {
  const contexts = captionContextsForPlaceName(
    caption,
    guess.placeName,
    otherPlaceNames,
  );
  if (contexts.length === 0) return [];
  const context = contexts.join(" ");
  const hints = new Set<string>();
  const handles = [
    ...(context.match(/@[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*/g) ?? []),
    ...adjacentHandlesForPlace(caption, guess.placeName),
  ];
  for (const handle of handles) {
    if (
      compact(handle) !== compact(guess.placeName) &&
      !handleNameCompatible(handle, guess.placeName)
    ) continue;
    const parts = handle.slice(1).toLocaleLowerCase("en-US").split(/[._-]+/);
    for (const [region, aliases] of Object.entries(REGION_LATIN_ALIASES)) {
      if (aliases.some((alias) => parts.includes(alias))) {
        hints.add(compact(region));
      }
    }
  }

  for (const region of METRO_ALIASES) {
    if (
      fieldGroundedToPlace(caption, guess.placeName, region, otherPlaceNames)
    ) {
      hints.add(compact(region));
    }
  }
  for (const token of hardRegionTokens(context)) {
    if (
      !fieldGroundedToPlace(caption, guess.placeName, token, otherPlaceNames)
    ) {
      continue;
    }
    for (const alias of regionAliases(token)) {
      if (METRO_ALIASES.has(alias)) hints.add(alias);
    }
  }
  return [...hints];
}

export function withCaptionRegionHints(
  guess: PlaceGuess,
  caption: string,
  otherPlaceNames: string[] = [],
): PlaceGuess {
  const regions = [
    ...new Set([
      ...placeRegionTokens(guess),
      ...captionRegionHints(guess, caption, otherPlaceNames),
    ]),
  ];
  return regions.length === 0 ? guess : { ...guess, region: regions.join(" ") };
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
    서울시: "서울",
    부산시: "부산",
    대구시: "대구",
    인천시: "인천",
    광주시: "광주",
    대전시: "대전",
    울산시: "울산",
    세종시: "세종",
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

type CandidateValidationReason = "NAME_MISMATCH" | "ADDRESS_CONFLICT";

export type CandidateValidation =
  | { status: "ACCEPTED" }
  | { status: "REJECTED"; reason: CandidateValidationReason };

/**
 * AI가 고른 후보라도 이름이 무관하거나 캡션의 명시적 주소·행정구역과
 * 충돌하면 저장하지 않는다. 위치 근거가 없는 이름 일치는 허용한다.
 */
export function validateKakaoCandidate(
  guess: PlaceGuess,
  candidate: KakaoPlace,
  searchAliases: string[] = [],
): CandidateValidation {
  const names = [guess.placeName, ...searchAliases];
  const hardLocationEvidence = hasHardLocationEvidence(guess);
  const candidateAddress = guess.address
    ? roadToken(guess.address) !== null
      ? candidate.roadAddress
      : candidate.address ?? candidate.roadAddress
    : null;
  const detailedAddressMatches = Boolean(
    guess.address && candidateAddress && hasDetailedAddressEvidence(guess) &&
      addressMatches(
        guess.address,
        candidateAddress,
        placeRegionTokens(guess).join(" ") || null,
      ),
  );
  if (candidateOmitsSpecifiedBranch(guess, candidate)) {
    return { status: "REJECTED", reason: "NAME_MISMATCH" };
  }
  if (
    !names.some((name) =>
      namesCompatibleWithoutTypo(name, candidate.name) ||
      (hardLocationEvidence &&
        namesHaveSingleCharacterTypo(name, candidate.name)) ||
      handleNameCompatible(name, candidate.name) ||
      (detailedAddressMatches &&
        nameMatchesCandidateWithLocationSuffix(name, candidate))
    )
  ) {
    return { status: "REJECTED", reason: "NAME_MISMATCH" };
  }

  if (!hardLocationEvidence) return { status: "ACCEPTED" };

  if (guess.address) {
    if (
      !candidateAddress ||
      !addressMatches(
        guess.address,
        candidateAddress,
        placeRegionTokens(guess).join(" ") || null,
      )
    ) {
      return { status: "REJECTED", reason: "ADDRESS_CONFLICT" };
    }
  } else {
    const location = candidateLocation(candidate);
    if (
      placeRegionTokens(guess).some((token) => !hasRegionToken(location, token))
    ) {
      return { status: "REJECTED", reason: "ADDRESS_CONFLICT" };
    }
  }

  return { status: "ACCEPTED" };
}

function queryTokens(value: string): string[] {
  return value.normalize("NFKC").split(/[^\p{L}\p{N}]+/gu).filter(Boolean);
}

interface ParsedRetryQuery {
  name: string;
  locationTokens: string[];
}

function parseRetryQuery(
  guess: PlaceGuess,
  query: string,
): ParsedRetryQuery | null {
  const tokens = queryTokens(query);
  const compatible = (name: string) =>
    placeNamesCompatible(guess.placeName, name) ||
    handleNameCompatible(guess.placeName, name);
  for (let length = tokens.length; length >= 1; length -= 1) {
    const name = tokens.slice(0, length).join(" ");
    if (compatible(name)) {
      return { name, locationTokens: tokens.slice(length) };
    }
  }
  for (let start = 1; start < tokens.length; start += 1) {
    const name = tokens.slice(start).join(" ");
    if (compatible(name)) {
      return { name, locationTokens: tokens.slice(0, start) };
    }
  }
  return null;
}

function addedBranchSuffix(
  sourceName: string,
  targetName: string,
): string | null {
  const source = compactPlaceName(sourceName);
  const target = compactPlaceName(targetName);
  if (!source || !target.startsWith(source) || target === source) return null;
  const suffix = target.slice(source.length);
  return /^(?:본점|직영점|\d+호점|[\p{L}\p{N}]{1,10}점)$/u.test(suffix)
    ? suffix
    : null;
}

function branchSuffixGroundedInContext(
  sourceName: string,
  suffix: string,
  context: string,
): boolean {
  const normalizedContext = context.normalize("NFKC").toLocaleLowerCase(
    "ko-KR",
  );
  const normalizedSource = sourceName.normalize("NFKC").trim()
    .toLocaleLowerCase("ko-KR");
  const normalizedSuffix = suffix.normalize("NFKC").toLocaleLowerCase(
    "ko-KR",
  );
  let sourceIndex = normalizedContext.indexOf(normalizedSource);
  while (sourceIndex >= 0) {
    let suffixIndex = sourceIndex + normalizedSource.length;
    while (
      suffixIndex < normalizedContext.length &&
      /[\s·_-]/.test(normalizedContext[suffixIndex])
    ) suffixIndex += 1;
    if (!normalizedContext.startsWith(normalizedSuffix, suffixIndex)) {
      sourceIndex = normalizedContext.indexOf(
        normalizedSource,
        sourceIndex + 1,
      );
      continue;
    }
    const after = normalizedContext.slice(
      suffixIndex + normalizedSuffix.length,
    );
    if (
      after.length === 0 || /^[^\p{L}\p{N}]/u.test(after) ||
      /^(?:에서|으로|은|는|이|가|을|를|와|과|도|만|의|부터|까지)(?=$|[^\p{L}\p{N}])/u
        .test(after)
    ) return true;
    sourceIndex = normalizedContext.indexOf(normalizedSource, sourceIndex + 1);
  }
  return false;
}

function sameRegionToken(left: string, right: string): boolean {
  const rightAliases = new Set(regionAliases(right));
  return regionAliases(left).some((alias) => rightAliases.has(alias));
}

function matchingHandleSupportsRegion(
  guess: PlaceGuess,
  retryName: string,
  regionToken: string,
  context: string,
): boolean {
  const aliases = REGION_LATIN_ALIASES[compact(regionToken)] ?? [];
  if (aliases.length === 0) return false;
  const handles = context.match(/@[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*/g) ?? [];
  return handles.some((handle) => {
    if (
      !handleNameCompatible(handle, guess.placeName) &&
      !handleNameCompatible(handle, retryName)
    ) return false;
    const parts = handle.slice(1).toLocaleLowerCase("en-US").split(/[._-]+/);
    return aliases.some((alias) => parts.includes(alias));
  });
}

function retryLocationGrounded(
  guess: PlaceGuess,
  retryName: string,
  regionToken: string,
  localContext: string,
): boolean {
  const sourceRegions = [
    ...hardRegionTokens(guess.address),
    ...placeRegionTokens(guess),
  ];
  if (sourceRegions.some((token) => sameRegionToken(token, regionToken))) {
    return true;
  }
  if (
    matchingHandleSupportsRegion(
      guess,
      retryName,
      regionToken,
      localContext,
    )
  ) return true;

  // `우직 부산`, `#우직 #부산맛집`처럼 상호와 지역이 바로 붙은 근거만
  // 캡션 fallback으로 인정한다. 다른 문장의 지역을 빌리지 않는다.
  const context = compactPlaceName(localContext);
  const region = compactPlaceName(regionToken);
  const names = [guess.placeName, retryName].map(compactPlaceName).filter(
    Boolean,
  );
  return names.some((name) =>
    context.includes(`${name}${region}`) || context.includes(`${region}${name}`)
  );
}

function retryLocationGroundedInDetailedAddress(
  guess: PlaceGuess,
  locationToken: string,
): boolean {
  if (!hasDetailedAddressEvidence(guess)) return false;
  const expected = compact(locationToken);
  if (Array.from(expected).length < 2) return false;

  const road = roadToken(guess.address ?? "");
  const roadStem = road?.replace(/(?:대로|번길|로|길)$/u, "") ?? null;
  if (roadStem === expected) return true;
  return hardRegionTokens(guess.address).some((token) =>
    administrativeLocationStem(token) === expected
  );
}

/**
 * Gemini 재검색어는 원 상호와 관련되고, 추가 토큰이 캡션에 있거나 한 글자
 * 수준의 표기 보정일 때만 허용한다. 캡션에 없는 도시·지점 발명은 버린다.
 */
export function groundedRetryQueries(
  guess: PlaceGuess,
  caption: string,
  queries: string[],
  otherPlaceNames: string[] = [],
): string[] {
  const contexts = captionContextsForPlaceName(
    caption,
    guess.placeName,
    otherPlaceNames,
  );
  const localContext = contexts.join(" ");
  const unique = new Map<string, string>();
  for (const raw of queries) {
    const query = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (!query || query.length > 80) continue;
    const parsed = parseRetryQuery(guess, query);
    if (!parsed) continue;
    const retryName = parsed.name;
    const directNameGrounded = placeNamesCompatible(guess.placeName, retryName);
    const handleGrounded = handleNameCompatible(guess.placeName, retryName);
    const nameGrounded = directNameGrounded || handleGrounded;
    if (!nameGrounded) continue;
    const originalLength = Array.from(compactPlaceName(guess.placeName)).length;
    const retryLength = Array.from(compactPlaceName(retryName)).length;
    if (
      !handleGrounded && retryLength < originalLength &&
      originalLength > 0 && retryLength / originalLength < 0.5
    ) continue;
    const branchSuffix = directNameGrounded
      ? addedBranchSuffix(guess.placeName, retryName)
      : null;
    if (
      branchSuffix &&
      !branchSuffixGroundedInContext(
        guess.placeName,
        branchSuffix,
        localContext,
      )
    ) continue;
    const fullQueryGrounded = appearsInCaption(
      query,
      localContext,
      compactPlaceName,
    );
    if (
      parsed.locationTokens.some((token) => {
        if (hardRegionTokens(token).length === 0) {
          return !retryLocationGroundedInDetailedAddress(guess, token);
        }
        return !fullQueryGrounded &&
          !retryLocationGrounded(guess, retryName, token, localContext);
      })
    ) continue;
    const canonicalQuery = [retryName, ...parsed.locationTokens].join(" ");
    const key = compactPlaceName(canonicalQuery);
    if (!unique.has(key)) unique.set(key, canonicalQuery);
    if (unique.size === 3) break;
  }
  return [...unique.values()];
}

function retrySearchNames(guess: PlaceGuess, queries: string[]): string[] {
  return queries.map((query) => parseRetryQuery(guess, query)?.name ?? "")
    .filter(Boolean);
}

function addsUnspecifiedBranch(
  guess: PlaceGuess,
  candidate: KakaoPlace,
): boolean {
  const suffix = addedBranchSuffix(guess.placeName, candidate.name);
  if (!suffix) return false;
  if (hasDetailedAddressEvidence(guess)) return false;

  const branchToken = suffix.match(/^([\p{L}\p{N}]{1,10})점$/u)?.[1] ?? null;
  if (!branchToken || branchToken === "본" || branchToken === "직영") {
    return true;
  }
  const locationTokens = [
    ...hardRegionTokens(guess.address),
    ...placeRegionTokens(guess),
  ];
  const candidateAddress = candidateLocation(candidate);
  if (
    locationTokens.some((token) =>
      !METRO_ALIASES.has(regionAliases(token).at(-1) ?? token) &&
      hasRegionToken(candidateAddress, token)
    )
  ) return false;
  return !locationTokens.some((token) => sameRegionToken(token, branchToken));
}

function candidateOmitsSpecifiedBranch(
  guess: PlaceGuess,
  candidate: KakaoPlace,
): boolean {
  const suffix = addedBranchSuffix(candidate.name, guess.placeName);
  if (!suffix) return false;
  if (hasDetailedAddressEvidence(guess)) return false;

  const branchToken = suffix.match(/^([\p{L}\p{N}]{1,10})점$/u)?.[1] ?? null;
  if (!branchToken || branchToken === "본" || branchToken === "직영") {
    return true;
  }
  return !hasRegionToken(candidateLocation(candidate), branchToken);
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

  const regionTokens = placeRegionTokens(guess);
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
 * - 1개: 이름이 관련 있고 명시적 주소·지역과 충돌하지 않을 때만 자동 확정
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
    return !addsUnspecifiedBranch(guess, uniqueCandidates[0]) &&
        validateKakaoCandidate(guess, uniqueCandidates[0]).status === "ACCEPTED"
      ? { type: "AUTO_MATCH", place: uniqueCandidates[0] }
      : { type: "NEEDS_AI_REVIEW", candidates: uniqueCandidates };
  }

  const locationMatches = locationMatchedKakaoPlaces(guess, uniqueCandidates);
  if (
    locationMatches.length === 1 &&
    !addsUnspecifiedBranch(guess, locationMatches[0]) &&
    validateKakaoCandidate(guess, locationMatches[0]).status === "ACCEPTED"
  ) {
    return { type: "AUTO_MATCH", place: locationMatches[0] };
  }

  return {
    type: "NEEDS_AI_REVIEW",
    candidates: uniqueCandidates.slice(0, MAX_AI_REVIEW_CANDIDATES),
  };
}

export type AiCandidateResolution =
  | { status: "ACCEPTED"; place: KakaoPlace }
  | {
    status: "REJECTED";
    reason:
      | "AI_SELECTED_UNKNOWN_CANDIDATE"
      | "NAME_MISMATCH"
      | "ADDRESS_CONFLICT"
      | "INSUFFICIENT_CONTEXT";
  };

/**
 * 2차 Gemini의 의미 판단을 코드 규칙으로 다시 뒤집지 않는다.
 * Gemini가 실제로 전달받은 Kakao 후보 ID를 선택했는지만 확인한다.
 */
export function resolveAiSelectedKakaoPlace(
  guess: PlaceGuess,
  candidates: KakaoPlace[],
  candidateId: string,
  captionContext: string | null = null,
): AiCandidateResolution {
  const candidate = deduplicateKakaoPlaces(candidates).find((place) =>
    place.kakaoPlaceId === candidateId
  );
  if (!candidate) {
    return { status: "REJECTED", reason: "AI_SELECTED_UNKNOWN_CANDIDATE" };
  }
  if (addsUnspecifiedBranch(guess, candidate)) {
    const suffix = addedBranchSuffix(guess.placeName, candidate.name);
    if (
      !suffix || !captionContext ||
      !branchSuffixGroundedInContext(
        guess.placeName,
        suffix,
        captionContext,
      )
    ) {
      return { status: "REJECTED", reason: "INSUFFICIENT_CONTEXT" };
    }
  }
  const validation = validateKakaoCandidate(guess, candidate);
  return validation.status === "ACCEPTED"
    ? { status: "ACCEPTED", place: candidate }
    : validation;
}

export type RetryCandidateResolution =
  | { status: "ACCEPTED"; place: KakaoPlace }
  | {
    status: "REJECTED";
    reason:
      | "NO_KAKAO_CANDIDATE_AFTER_EXPANSION"
      | "AMBIGUOUS_SAME_NAME"
      | "NAME_MISMATCH"
      | "ADDRESS_CONFLICT";
  };

/** RETRY 결과는 위치·이름 규칙으로 하나만 남을 때 확정하며 AI를 재호출하지 않는다. */
export function resolveRetriedKakaoPlace(
  guess: PlaceGuess,
  retryQueries: string[],
  candidates: KakaoPlace[],
): RetryCandidateResolution {
  const uniqueCandidates = deduplicateKakaoPlaces(candidates);
  if (uniqueCandidates.length === 0) {
    return {
      status: "REJECTED",
      reason: "NO_KAKAO_CANDIDATE_AFTER_EXPANSION",
    };
  }

  const parsedQueries = retryQueries.map((query) =>
    parseRetryQuery(guess, query)
  )
    .filter((parsed): parsed is ParsedRetryQuery => parsed !== null);
  const queryRegions = parsedQueries.flatMap((parsed) =>
    parsed.locationTokens.flatMap((token) => hardRegionTokens(token))
  );
  const searchNames = retrySearchNames(guess, retryQueries);
  const retryGuess: PlaceGuess = {
    ...guess,
    region: [
      ...new Set([
        ...placeRegionTokens(guess),
        ...queryRegions,
      ]),
    ].join(" ") || guess.region,
  };
  const validations = uniqueCandidates.map((candidate) => {
    const explicitBranchAlias = searchNames.some((name) =>
      compactPlaceName(name) === compactPlaceName(candidate.name)
    );
    return {
      candidate,
      validation: addsUnspecifiedBranch(retryGuess, candidate) &&
          !explicitBranchAlias
        ? { status: "REJECTED" as const, reason: "NAME_MISMATCH" as const }
        : validateKakaoCandidate(retryGuess, candidate, searchNames),
    };
  });
  const valid = validations.filter(({ validation }) =>
    validation.status === "ACCEPTED"
  ).map(({ candidate }) => candidate);

  if (valid.length === 0) {
    const addressConflict = validations.some(({ validation }) =>
      validation.status === "REJECTED" &&
      validation.reason === "ADDRESS_CONFLICT"
    );
    return {
      status: "REJECTED",
      reason: addressConflict ? "ADDRESS_CONFLICT" : "NAME_MISMATCH",
    };
  }

  if (hasHardLocationEvidence(retryGuess)) {
    const locationMatches = locationMatchedKakaoPlaces(retryGuess, valid);
    if (locationMatches.length === 1) {
      return { status: "ACCEPTED", place: locationMatches[0] };
    }
    if (locationMatches.length === 0) {
      return { status: "REJECTED", reason: "ADDRESS_CONFLICT" };
    }
  }

  return valid.length === 1
    ? { status: "ACCEPTED", place: valid[0] }
    : { status: "REJECTED", reason: "AMBIGUOUS_SAME_NAME" };
}
