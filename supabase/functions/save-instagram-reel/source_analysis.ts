// 2026-Yeogidam MediaExtractionPipeline / KakaoPlaceSearcher의 분석 규칙.
import type { PlaceGuess } from "./ai/types.ts";
import type { KakaoPlace } from "./kakao.ts";
import type { PlaceMatchFailure } from "./match_failure.ts";

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

export function buildSourceSearchQueries(hint: SourcePlaceHint): string[] {
  const name = (hint.nameSearchHint ?? hint.nameInCaption).trim();
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
  search(query: string): Promise<KakaoPlace[]>;
  log?(event: string, details: Record<string, unknown>): void;
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
  if (input.authorUsername === "with_sol_mate") {
    hints = await dependencies.extractMedia(input.caption, input.instagramUrl);
  } else {
    hints = await dependencies.extractCaption(input.caption);
    if (hints.length === 0) {
      hints = await dependencies.extractMedia(
        input.caption,
        input.instagramUrl,
      );
    }
  }
  dependencies.log?.("source_place_hints_extracted", { hints });
  if (!hints.length) {
    return { ...result, failureReason: "GEMINI_PLACE_NOT_FOUND" };
  }

  const seen = new Set<string>();
  for (const [guessIndex, hint] of hints.entries()) {
    const guess = storageGuess(hint);
    let selected: KakaoPlace | undefined;
    for (const query of buildSourceSearchQueries(hint)) {
      const places = await dependencies.search(query);
      dependencies.log?.("source_kakao_search", {
        guessIndex,
        query,
        candidateCount: places.length,
      });
      if (!places.length) continue;
      selected = places[0];
      break;
    }
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
  if (!result.matches.length) result.failureReason = "KAKAO_PLACE_NOT_FOUND";
  return result;
}
