// 2026-Yeogidam MediaExtractionPipeline / KakaoPlaceSearcher의 분석 규칙.
import type { PlaceGuess } from "./ai/types.ts";
import type { KakaoPlace } from "./kakao.ts";
import type { PlaceMatchFailure } from "./match_failure.ts";
import type { Coordinate } from "./source_kakao.ts";

export type LocationBasis = "CAPTION" | "INFERRED" | "VIDEO" | "IMAGE";

export interface SourceLocationHint {
  type: "ADDRESS" | "REGION";
  value: string;
  basis: LocationBasis;
}

export interface SourcePlaceHint {
  nameInCaption: string;
  nameSearchHint: string | null;
  accountHints: string[];
  locationHints: SourceLocationHint[];
  categoryHint: string | null;
}

const ADDRESS_BASES: LocationBasis[] = [
  "CAPTION",
  "VIDEO",
  "IMAGE",
  "INFERRED",
];
const REGION_BASES: LocationBasis[] = ["VIDEO", "IMAGE", "INFERRED", "CAPTION"];
// 캡션에 적힌 주소만 사실로 보고 그 근처만 믿는다. 영상, 이미지에서 읽은 주소와 추론 주소는 잘못 읽었을 수 있어서
// (골든셋 C005에서 영상 속 동네를 다른 구의 같은 이름 동으로 읽었다) 근처를 먼저 찾되 없으면 지역과 이름으로 다시 찾는다.
const SOFT_ADDRESS_BASES: LocationBasis[] = ["VIDEO", "IMAGE", "INFERRED"];

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(
    /[\p{Z}\p{P}\p{S}\s]/gu,
    "",
  );
}

function regionFromAddress(address: string): string | null {
  const local = [
    ...address.matchAll(/(?<!\S)([가-힣0-9]+(?:읍|면|동))(?=\s|$)/g),
  ];
  if (local.length) return local.at(-1)![1];
  const administrative = [
    ...address.matchAll(/(?<!\S)([가-힣]+(?:구|군|시))(?=\s|$)/g),
  ]
    .map((match) => match[1]);
  const district = administrative.filter((region) => /[구군]$/.test(region)).at(
    -1,
  );
  return district ??
    administrative.filter((region) => region.endsWith("시")).at(-1) ?? null;
}

function searchRegion(hint: SourcePlaceHint): string | null {
  for (const basis of ADDRESS_BASES) {
    for (const location of hint.locationHints) {
      if (location.type !== "ADDRESS" || location.basis !== basis) continue;
      const region = regionFromAddress(location.value);
      if (region) return region;
    }
  }
  for (const basis of REGION_BASES) {
    const location = hint.locationHints.find((item) =>
      item.type === "REGION" && item.basis === basis && item.value.trim()
    );
    if (location) return location.value;
  }
  return null;
}

function searchName(hint: SourcePlaceHint): string {
  return (hint.nameSearchHint ?? hint.nameInCaption).trim();
}

export function buildSourceSearchQueries(hint: SourcePlaceHint): string[] {
  const name = searchName(hint);
  const region = searchRegion(hint);
  if (!region || normalize(name).includes(normalize(region))) return [name];
  return [...new Set([`${name} ${region}`, name])];
}

// 내부 단서만 기존 저장 형식으로 변환한다. 캡션 문자열 검사로 미디어 단서를 지우지 않는다.
function storageGuess(hint: SourcePlaceHint): PlaceGuess {
  const address =
    ADDRESS_BASES.flatMap((basis) =>
      hint.locationHints.filter((item) =>
        item.type === "ADDRESS" && item.basis === basis
      )
    ).at(0)?.value ?? null;
  return {
    placeName: hint.nameInCaption,
    address,
    addressType: address ? "PARTIAL" : "NONE",
    region: searchRegion(hint),
  };
}

export interface SourceAnalysisDependencies {
  extractCaption(caption: string): Promise<SourcePlaceHint[]>;
  extractMedia(
    caption: string,
    instagramUrl: string,
  ): Promise<SourcePlaceHint[]>;
  search(query: string, anchor?: Coordinate): Promise<KakaoPlace[]>;
  // 없으면 주소 반경 검색을 건너뛰고 지역과 이름으로만 찾는다.
  geocode?(address: string): Promise<Coordinate | null>;
  log?(event: string, details: Record<string, unknown>): void;
}

async function anchorFor(
  hint: SourcePlaceHint,
  bases: LocationBasis[],
  dependencies: SourceAnalysisDependencies,
): Promise<Coordinate | null> {
  if (!dependencies.geocode) return null;
  for (const basis of bases) {
    for (const location of hint.locationHints) {
      if (location.type !== "ADDRESS" || location.basis !== basis) continue;
      const coordinate = await dependencies.geocode(location.value);
      if (coordinate) return coordinate;
    }
  }
  return null;
}

async function firstSearchResult(
  query: string,
  guessIndex: number,
  dependencies: SourceAnalysisDependencies,
  anchor?: Coordinate,
): Promise<KakaoPlace | undefined> {
  const places = await dependencies.search(query, anchor);
  dependencies.log?.("source_kakao_search", {
    guessIndex,
    query,
    ...(anchor ? { nearby: true } : {}),
    candidateCount: places.length,
  });
  return places[0];
}

// Gemini가 보정한 이름에 업종을 덧붙여 근처 검색이 비는 일이 있어서(골든셋 C016 "확불장군 참숯닭갈비")
// 캡션에 적힌 이름도 한 번 더 찾는다.
async function searchNearby(
  hint: SourcePlaceHint,
  guessIndex: number,
  dependencies: SourceAnalysisDependencies,
  anchor: Coordinate,
): Promise<KakaoPlace | undefined> {
  const names = [hint.nameSearchHint, hint.nameInCaption]
    .map((name) => name?.trim() ?? "")
    .filter(Boolean);
  for (const name of new Set(names)) {
    const found = await firstSearchResult(
      name,
      guessIndex,
      dependencies,
      anchor,
    );
    if (found) return found;
  }
  return undefined;
}

async function selectSourcePlace(
  hint: SourcePlaceHint,
  guessIndex: number,
  dependencies: SourceAnalysisDependencies,
): Promise<KakaoPlace | undefined> {
  const captionAnchor = await anchorFor(hint, ["CAPTION"], dependencies);
  if (captionAnchor) {
    // 근처에 없는 가게를 지역이나 이름만으로 다시 찾으면 다른 지점이 붙으므로 여기서 끝낸다.
    return await searchNearby(hint, guessIndex, dependencies, captionAnchor);
  }
  const softAnchor = await anchorFor(hint, SOFT_ADDRESS_BASES, dependencies);
  if (softAnchor) {
    const nearby = await searchNearby(
      hint,
      guessIndex,
      dependencies,
      softAnchor,
    );
    if (nearby) return nearby;
  }
  for (const query of buildSourceSearchQueries(hint)) {
    const found = await firstSearchResult(query, guessIndex, dependencies);
    if (found) return found;
  }
  return undefined;
}

export interface SourceAnalysisResult {
  matches: { guessIndex: number; guess: PlaceGuess; place: KakaoPlace }[];
  failures: PlaceMatchFailure[];
  failureReason:
    | "IG_CAPTION_NOT_FOUND"
    | "GEMINI_PLACE_NOT_FOUND"
    | "KAKAO_PLACE_NOT_FOUND"
    | null;
}

export async function analyzeInstagramPlaces(
  input: {
    instagramUrl: string;
    caption: string | null;
    authorUsername: string | null;
  },
  dependencies: SourceAnalysisDependencies,
): Promise<SourceAnalysisResult> {
  const result: SourceAnalysisResult = {
    matches: [],
    failures: [],
    failureReason: null,
  };
  if (!input.caption?.trim()) {
    return { ...result, failureReason: "IG_CAPTION_NOT_FOUND" };
  }
  let hints: SourcePlaceHint[];
  let mediaRead = false;
  if (input.authorUsername === "with_sol_mate") {
    hints = await dependencies.extractMedia(input.caption, input.instagramUrl);
    mediaRead = true;
  } else {
    hints = await dependencies.extractCaption(input.caption);
    if (hints.length === 0) {
      hints = await dependencies.extractMedia(
        input.caption,
        input.instagramUrl,
      );
      mediaRead = true;
    }
  }
  dependencies.log?.("source_place_hints_extracted", { hints });
  if (!hints.length) {
    return { ...result, failureReason: "GEMINI_PLACE_NOT_FOUND" };
  }

  const seen = new Set<string>();
  await matchHints(hints, 0, dependencies, result, seen);
  // 캡션 단서를 카카오에서 하나도 못 찾으면 영상과 사진을 한 번 더 본다(2026-Yeogidam 1단계와 같은 조건).
  // 보조 단계라서 실패해도 카카오에서 못 찾은 결과로 끝내고, 실패 기록 번호는 앞 단서 뒤로 이어 붙인다.
  if (!result.matches.length && !mediaRead) {
    let mediaHints: SourcePlaceHint[] = [];
    try {
      mediaHints = await dependencies.extractMedia(
        input.caption,
        input.instagramUrl,
      );
    } catch (error) {
      dependencies.log?.("source_media_after_kakao_miss_failed", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
    if (mediaHints.length) {
      dependencies.log?.("source_place_hints_extracted", {
        hints: mediaHints,
        afterKakaoMiss: true,
      });
      await matchHints(mediaHints, hints.length, dependencies, result, seen);
    }
  }
  if (!result.matches.length) result.failureReason = "KAKAO_PLACE_NOT_FOUND";
  return result;
}

async function matchHints(
  hints: SourcePlaceHint[],
  firstGuessIndex: number,
  dependencies: SourceAnalysisDependencies,
  result: SourceAnalysisResult,
  seen: Set<string>,
): Promise<void> {
  for (const [offset, hint] of hints.entries()) {
    const guessIndex = firstGuessIndex + offset;
    const guess = storageGuess(hint);
    const selected = await selectSourcePlace(hint, guessIndex, dependencies);
    if (!selected) {
      result.failures.push({
        guessIndex,
        guess,
        stage: "KAKAO_SEARCH",
        reason: "NO_KAKAO_CANDIDATE",
        candidates: [],
      });
      continue;
    }
    if (seen.has(selected.kakaoPlaceId)) continue;
    seen.add(selected.kakaoPlaceId);
    result.matches.push({ guessIndex, guess, place: selected });
  }
}
