// 원본 KakaoPlaceSearcher의 첫 페이지, 유효 장소 파싱 규칙에 2026-Yeogidam feat/#322의 음식점 한정과 주소 반경 검색을 더했다.
import { type KakaoPlace, KakaoPlaceSearchError } from "./kakao.ts";
import { mediaHttp } from "./media_http.ts";

const BASE = "https://dapi.kakao.com/v2/local/search";
// 여기담은 먹고 마시는 가게만 모은다. 카카오 분류가 "음식점"으로 시작하지 않는 결과(관광지, 공원, 편의점 등)는 받지 않는다.
const FOOD_CATEGORY_PREFIX = "음식점";
// 주소 좌표를 기준으로 같은 이름의 장소를 찾는 반경. 같은 도시 안의 다른 지점(골든셋에서 4.8km 밖 지점이 붙은 일이 있었다)은
// 거르고 같은 동네 안에서는 넉넉한 값이다.
const NEARBY_RADIUS_METERS = 3_000;
// 주소 뒤에 붙은 층, 호수, 건물명 때문에 주소 검색이 비면 끝 낱말을 하나씩 떼고 다시 찾는 최대 횟수
const ADDRESS_TRIM_ATTEMPTS = 3;

export interface Coordinate {
  latitude: number;
  longitude: number;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseSourceKakaoPlaces(payload: unknown): KakaoPlace[] {
  const documents = (payload as { documents?: unknown } | null)?.documents;
  if (!Array.isArray(documents)) {
    throw new Error("source_kakao_response_invalid");
  }
  const places = new Map<string, KakaoPlace>();
  let foodDocuments = 0;
  for (const value of documents) {
    if (!value || typeof value !== "object") continue;
    const document = value as Record<string, unknown>;
    if (!text(document.category_name)?.startsWith(FOOD_CATEGORY_PREFIX)) {
      continue;
    }
    foodDocuments += 1;
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
  // 음식점 결과가 왔는데 하나도 못 읽었다면 응답 모양이 바뀐 것이다. 음식점이 아예 없는 것은 정상이다.
  if (foodDocuments && !places.size) {
    throw new Error("source_kakao_places_invalid");
  }
  return [...places.values()];
}

function firstCoordinate(payload: unknown): Coordinate | null {
  const documents = (payload as { documents?: unknown } | null)?.documents;
  if (!Array.isArray(documents)) return null;
  for (const value of documents) {
    const document = (value ?? {}) as Record<string, unknown>;
    const latitude = Number(text(document.y) ?? NaN);
    const longitude = Number(text(document.x) ?? NaN);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { latitude, longitude };
    }
  }
  return null;
}

async function kakaoJson(
  url: string,
  apiKey: string,
  request: typeof fetch,
): Promise<unknown> {
  return await mediaHttp(
    request,
    url,
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
      return await response.json();
    },
  );
}

// anchor가 있으면 그 좌표 반경 안으로 결과를 좁혀 같은 이름의 다른 도시 지점이 먼저 오는 일을 막는다.
// 정렬은 카카오 기본값(정확도)을 둔다. 거리순으로 바꾸면 같은 건물의 다른 가게가 앞에 오는 일이 있었다.
export async function searchSourceKakaoPlaces(
  query: string,
  apiKey: string,
  request: typeof fetch = fetch,
  anchor?: Coordinate,
): Promise<KakaoPlace[]> {
  const params = new URLSearchParams({ query, size: "15", page: "1" });
  if (anchor) {
    params.set("x", String(anchor.longitude));
    params.set("y", String(anchor.latitude));
    params.set("radius", String(NEARBY_RADIUS_METERS));
  }
  return parseSourceKakaoPlaces(
    await kakaoJson(`${BASE}/keyword.json?${params}`, apiKey, request),
  );
}

// 주소를 좌표로 바꾼다. 층, 호수, 건물명 때문에 결과가 비면 끝 낱말을 떼고 다시 찾고, 끝내 없으면 null이다.
export async function geocodeSourceAddress(
  address: string,
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<Coordinate | null> {
  let query = address.trim();
  for (let attempt = 0; attempt <= ADDRESS_TRIM_ATTEMPTS && query; attempt++) {
    const params = new URLSearchParams({ query, size: "1" });
    const coordinate = firstCoordinate(
      await kakaoJson(`${BASE}/address.json?${params}`, apiKey, request),
    );
    if (coordinate) return coordinate;
    const lastSpace = query.lastIndexOf(" ");
    query = lastSpace < 0 ? "" : query.slice(0, lastSpace).trim();
  }
  return null;
}
