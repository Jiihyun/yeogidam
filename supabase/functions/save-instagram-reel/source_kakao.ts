// 원본 KakaoPlaceSearcher의 첫 페이지, 유효 장소 파싱 규칙.
import { type KakaoPlace, KakaoPlaceSearchError } from "./kakao.ts";
import { mediaHttp } from "./media_http.ts";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseSourceKakaoPlaces(payload: unknown): KakaoPlace[] {
  const documents = (payload as { documents?: unknown } | null)?.documents;
  if (!Array.isArray(documents)) {
    throw new Error("source_kakao_response_invalid");
  }
  const places = new Map<string, KakaoPlace>();
  for (const value of documents) {
    if (!value || typeof value !== "object") continue;
    const document = value as Record<string, unknown>;
    const id = text(document.id);
    const name = text(document.place_name);
    const address = text(document.address_name);
    const latitude = text(document.y) === null ? NaN : Number(document.y);
    const longitude = text(document.x) === null ? NaN : Number(document.x);
    if (
      !id || !name || !address || !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180
    ) continue;
    let placeUrl = text(document.place_url);
    if (placeUrl) {
      try {
        if (!["http:", "https:"].includes(new URL(placeUrl).protocol)) {
          placeUrl = null;
        }
      } catch {
        placeUrl = null;
      }
    }
    if (!places.has(id)) {
      places.set(id, {
        kakaoPlaceId: id,
        name,
        address,
        roadAddress: text(document.road_address_name),
        category: text(document.category_name),
        telephone: text(document.phone),
        latitude,
        longitude,
        placeUrl,
      });
    }
  }
  if (documents.length && !places.size) {
    throw new Error("source_kakao_places_invalid");
  }
  return [...places.values()];
}

export async function searchSourceKakaoPlaces(
  query: string,
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<KakaoPlace[]> {
  const params = new URLSearchParams({ query, size: "15", page: "1" });
  return await mediaHttp(
    request,
    `https://dapi.kakao.com/v2/local/search/keyword.json?${params}`,
    {
      headers: { Authorization: `KakaoAK ${apiKey}` },
    },
    5_000,
    async (response) => {
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel();
        throw new KakaoPlaceSearchError(
          status === 401 || status === 403
            ? "AUTH"
            : status === 429
            ? "RATE_LIMIT"
            : status >= 500
            ? "SERVER"
            : "HTTP",
          status,
          status === 429 || status >= 500,
        );
      }
      return parseSourceKakaoPlaces(await response.json());
    },
  );
}
