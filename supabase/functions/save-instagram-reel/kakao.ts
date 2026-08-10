// Kakao Local API의 키워드 장소 검색을 정규화한다.
// 응답의 id는 같은 건물 내 매장도 구분하는 Kakao 장소 ID다.

export interface KakaoPlace {
  kakaoPlaceId: string;
  name: string;
  category: string | null;
  roadAddress: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  placeUrl: string | null;
  telephone: string | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function coordinate(
  value: unknown,
  min: number,
  max: number,
): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

export function parseKakaoPlaces(data: unknown): KakaoPlace[] {
  const response = data as { documents?: unknown };
  if (!Array.isArray(response?.documents)) return [];

  return response.documents.flatMap((raw): KakaoPlace[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const kakaoPlaceId = optionalString(item.id);
    const name = optionalString(item.place_name);
    if (!kakaoPlaceId || !name) return [];

    return [{
      kakaoPlaceId,
      name,
      category: optionalString(item.category_name),
      roadAddress: optionalString(item.road_address_name),
      address: optionalString(item.address_name),
      latitude: coordinate(item.y, 33, 39),
      longitude: coordinate(item.x, 124, 132),
      placeUrl: optionalString(item.place_url),
      telephone: optionalString(item.phone),
    }];
  });
}

export function buildKakaoMapURL(kakaoPlaceId: string): string {
  return `https://map.kakao.com/link/map/${encodeURIComponent(kakaoPlaceId)}`;
}

export async function searchKakaoPlaces(
  query: string,
  restApiKey: string,
): Promise<KakaoPlace[]> {
  const params = new URLSearchParams({
    query,
    size: "15",
    sort: "accuracy",
  });
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?${params}`;
  const response = await fetch(url, {
    headers: { Authorization: `KakaoAK ${restApiKey}` },
  });

  if (!response.ok) {
    console.error(JSON.stringify({
      event: "kakao_place_search_failed",
      query,
      status: response.status,
    }));
    return [];
  }

  const places = parseKakaoPlaces(await response.json());
  console.info(JSON.stringify({
    event: "kakao_place_search_completed",
    query,
    itemCount: places.length,
  }));
  return places;
}
