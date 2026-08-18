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

export type KakaoPlaceSearchFailureKind =
  | "AUTH"
  | "RATE_LIMIT"
  | "SERVER"
  | "HTTP"
  | "NETWORK"
  | "INVALID_RESPONSE";

export class KakaoPlaceSearchError extends Error {
  constructor(
    public readonly kind: KakaoPlaceSearchFailureKind,
    public readonly status: number | null,
    public readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(
      `kakao place search failed: ${kind}${
        status === null ? "" : ` (${status})`
      }`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "KakaoPlaceSearchError";
  }
}

function httpFailure(status: number): KakaoPlaceSearchError {
  if (status === 401 || status === 403) {
    return new KakaoPlaceSearchError("AUTH", status, false);
  }
  if (status === 429) {
    return new KakaoPlaceSearchError("RATE_LIMIT", status, true);
  }
  if (status >= 500) {
    return new KakaoPlaceSearchError("SERVER", status, true);
  }
  return new KakaoPlaceSearchError("HTTP", status, status === 408);
}

function logSearchFailure(query: string, error: KakaoPlaceSearchError): void {
  console.error(JSON.stringify({
    event: "kakao_place_search_failed",
    query,
    kind: error.kind,
    status: error.status,
    retryable: error.retryable,
  }));
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
  request: typeof fetch = fetch,
): Promise<KakaoPlace[]> {
  const params = new URLSearchParams({
    query,
    size: "15",
    sort: "accuracy",
  });
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?${params}`;
  let response: Response;
  try {
    response = await request(url, {
      headers: { Authorization: `KakaoAK ${restApiKey}` },
    });
  } catch (cause) {
    const error = new KakaoPlaceSearchError("NETWORK", null, true, cause);
    logSearchFailure(query, error);
    throw error;
  }

  if (!response.ok || response.status !== 200) {
    const error = httpFailure(response.status);
    logSearchFailure(query, error);
    throw error;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    const error = new KakaoPlaceSearchError(
      "INVALID_RESPONSE",
      response.status,
      true,
      cause,
    );
    logSearchFailure(query, error);
    throw error;
  }
  if (
    !payload || typeof payload !== "object" ||
    !Array.isArray((payload as { documents?: unknown }).documents)
  ) {
    const error = new KakaoPlaceSearchError(
      "INVALID_RESPONSE",
      response.status,
      true,
    );
    logSearchFailure(query, error);
    throw error;
  }

  const documents = (payload as { documents: unknown[] }).documents;
  const places = parseKakaoPlaces(payload);
  if (places.length !== documents.length) {
    const error = new KakaoPlaceSearchError(
      "INVALID_RESPONSE",
      response.status,
      true,
    );
    logSearchFailure(query, error);
    throw error;
  }
  console.info(JSON.stringify({
    event: "kakao_place_search_completed",
    query,
    itemCount: places.length,
  }));
  return places;
}
