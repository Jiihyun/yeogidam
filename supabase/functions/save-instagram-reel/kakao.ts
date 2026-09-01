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

export interface KakaoCoordinate {
  latitude: number;
  longitude: number;
}

export interface KakaoAddressCoordinate extends KakaoCoordinate {
  roadAddress: string | null;
  address: string | null;
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

function logSearchFailure(
  query: string,
  error: KakaoPlaceSearchError,
  event = "kakao_place_search_failed",
): void {
  console.error(JSON.stringify({
    event,
    query,
    kind: error.kind,
    status: error.status,
    retryable: error.retryable,
  }));
}

async function fetchKakaoJson(
  url: string,
  restApiKey: string,
  query: string,
  failureEvent: string,
  request: typeof fetch,
): Promise<{ payload: unknown; status: number }> {
  let response: Response;
  try {
    response = await request(url, {
      headers: { Authorization: `KakaoAK ${restApiKey}` },
    });
  } catch (cause) {
    const error = new KakaoPlaceSearchError("NETWORK", null, true, cause);
    logSearchFailure(query, error, failureEvent);
    throw error;
  }

  if (!response.ok || response.status !== 200) {
    const error = httpFailure(response.status);
    logSearchFailure(query, error, failureEvent);
    throw error;
  }

  try {
    return { payload: await response.json(), status: response.status };
  } catch (cause) {
    const error = new KakaoPlaceSearchError(
      "INVALID_RESPONSE",
      response.status,
      true,
      cause,
    );
    logSearchFailure(query, error, failureEvent);
    throw error;
  }
}

function responseDocuments(
  payload: unknown,
  status: number,
  query: string,
  failureEvent: string,
): unknown[] {
  if (
    payload && typeof payload === "object" &&
    Array.isArray((payload as { documents?: unknown }).documents)
  ) {
    return (payload as { documents: unknown[] }).documents;
  }
  const error = new KakaoPlaceSearchError(
    "INVALID_RESPONSE",
    status,
    true,
  );
  logSearchFailure(query, error, failureEvent);
  throw error;
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

export function parseKakaoAddressCoordinates(
  data: unknown,
): KakaoAddressCoordinate[] {
  const response = data as { documents?: unknown };
  if (!Array.isArray(response?.documents)) return [];

  return response.documents.flatMap((raw): KakaoAddressCoordinate[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const latitude = coordinate(item.y, 33, 39);
    const longitude = coordinate(item.x, 124, 132);
    const nestedAddress = (value: unknown): string | null =>
      value && typeof value === "object"
        ? optionalString((value as Record<string, unknown>).address_name)
        : null;
    const addressType = optionalString(item.address_type);
    const topLevelAddress = optionalString(item.address_name);
    const roadAddress = nestedAddress(item.road_address) ??
      (addressType === "ROAD_ADDR" ? topLevelAddress : null);
    const address = nestedAddress(item.address) ??
      (addressType === "REGION_ADDR" ? topLevelAddress : null);
    return latitude === null || longitude === null ||
        (!roadAddress && !address)
      ? []
      : [{ latitude, longitude, roadAddress, address }];
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
  const { payload, status } = await fetchKakaoJson(
    url,
    restApiKey,
    query,
    "kakao_place_search_failed",
    request,
  );
  const documents = responseDocuments(
    payload,
    status,
    query,
    "kakao_place_search_failed",
  );
  const places = parseKakaoPlaces(payload);
  if (places.length !== documents.length) {
    const error = new KakaoPlaceSearchError(
      "INVALID_RESPONSE",
      status,
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

const DEFAULT_ADDRESS_NEARBY_RADIUS_METERS = 300;
const MAX_ADDRESS_NEARBY_RADIUS_METERS = 500;

/** 주소검색 좌표를 중심으로 상호명을 거리순 재검색한다. */
export async function searchKakaoPlacesNearAddress(
  query: string,
  center: KakaoCoordinate,
  restApiKey: string,
  request: typeof fetch = fetch,
  radiusMeters = DEFAULT_ADDRESS_NEARBY_RADIUS_METERS,
): Promise<KakaoPlace[]> {
  const boundedRadius = Number.isFinite(radiusMeters)
    ? Math.min(
      MAX_ADDRESS_NEARBY_RADIUS_METERS,
      Math.max(0, Math.trunc(radiusMeters)),
    )
    : DEFAULT_ADDRESS_NEARBY_RADIUS_METERS;
  const params = new URLSearchParams({
    query,
    x: String(center.longitude),
    y: String(center.latitude),
    radius: String(boundedRadius),
    size: "15",
    sort: "distance",
  });
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?${params}`;
  const { payload, status } = await fetchKakaoJson(
    url,
    restApiKey,
    query,
    "kakao_place_near_address_search_failed",
    request,
  );
  const documents = responseDocuments(
    payload,
    status,
    query,
    "kakao_place_near_address_search_failed",
  );
  const places = parseKakaoPlaces(payload);
  if (places.length !== documents.length) {
    const error = new KakaoPlaceSearchError(
      "INVALID_RESPONSE",
      status,
      true,
    );
    logSearchFailure(
      query,
      error,
      "kakao_place_near_address_search_failed",
    );
    throw error;
  }
  console.info(JSON.stringify({
    event: "kakao_place_search_completed",
    query,
    mode: "NEAR_ADDRESS",
    radiusMeters: boundedRadius,
    itemCount: places.length,
  }));
  return places;
}

/** 검증된 도로명·지번 주소를 WGS84 좌표 하나로 변환한다. */
export async function searchKakaoAddressCoordinates(
  address: string,
  restApiKey: string,
  request: typeof fetch = fetch,
): Promise<KakaoAddressCoordinate[]> {
  // 층·동·호는 장소 후보의 exact-address 검증에는 유지하지만, 주소검색
  // 좌표에는 건물 단위 주소만 보내 검색 누락을 줄인다.
  const query = address.normalize("NFKC").replace(
    /(?:\s+(?:(?:지하\s*)?\d+\s*층|B\d+\s*층|\d+(?:\s*,\s*\d+)*\s*F|\d+\s*동|\d+\s*호))+$/iu,
    "",
  ).trim();
  const params = new URLSearchParams({ query, analyze_type: "exact" });
  const url = `https://dapi.kakao.com/v2/local/search/address.json?${params}`;
  const { payload, status } = await fetchKakaoJson(
    url,
    restApiKey,
    query,
    "kakao_address_search_failed",
    request,
  );
  const documents = responseDocuments(
    payload,
    status,
    query,
    "kakao_address_search_failed",
  );
  const coordinates = parseKakaoAddressCoordinates(payload);
  if (coordinates.length !== documents.length) {
    const error = new KakaoPlaceSearchError(
      "INVALID_RESPONSE",
      status,
      true,
    );
    logSearchFailure(query, error, "kakao_address_search_failed");
    throw error;
  }
  console.info(JSON.stringify({
    event: "kakao_address_search_completed",
    resultCount: coordinates.length,
  }));
  return coordinates;
}
