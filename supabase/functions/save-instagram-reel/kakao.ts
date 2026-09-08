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
  distanceMeters?: number;
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
      ...(optionalString(item.distance) &&
          Number.isFinite(Number(item.distance))
        ? { distanceMeters: Number(item.distance) }
        : {}),
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
      (addressType === "ROAD_ADDR" || addressType === "ROAD"
        ? topLevelAddress
        : null);
    const address = nestedAddress(item.address) ??
      (addressType === "REGION_ADDR" || addressType === "REGION"
        ? topLevelAddress
        : null);
    return latitude === null || longitude === null ||
        (!roadAddress && !address)
      ? []
      : [{ latitude, longitude, roadAddress, address }];
  });
}

export function buildKakaoMapURL(kakaoPlaceId: string): string {
  return `https://map.kakao.com/link/map/${encodeURIComponent(kakaoPlaceId)}`;
}

export interface KakaoPlacePage {
  places: KakaoPlace[];
  isEnd: boolean;
}

export interface KakaoSearchOptions {
  page?: number;
  center?: KakaoCoordinate;
  radiusMeters?: number;
}

/** 같은 검색의 다음 페이지와 주소 중심 검색을 공통으로 처리한다. */
export async function searchKakaoPlacePage(
  query: string,
  restApiKey: string,
  options: KakaoSearchOptions = {},
  request: typeof fetch = fetch,
): Promise<KakaoPlacePage> {
  const params = new URLSearchParams({
    query,
    size: "15",
    page: String(Math.min(45, Math.max(1, Math.trunc(options.page ?? 1)))),
    sort: options.center ? "distance" : "accuracy",
  });
  if (options.center) {
    const radius = options.radiusMeters ?? 500;
    params.set("x", String(options.center.longitude));
    params.set("y", String(options.center.latitude));
    params.set(
      "radius",
      String(
        Number.isFinite(radius)
          ? Math.min(20000, Math.max(0, Math.trunc(radius)))
          : 500,
      ),
    );
  }
  const failureEvent = options.center
    ? "kakao_place_near_address_search_failed"
    : "kakao_place_search_failed";
  const { payload, status } = await fetchKakaoJson(
    "https://dapi.kakao.com/v2/local/search/keyword.json?" + params,
    restApiKey,
    query,
    failureEvent,
    request,
  );
  const documents = responseDocuments(payload, status, query, failureEvent);
  const places = parseKakaoPlaces(payload);
  if (places.length !== documents.length) {
    const error = new KakaoPlaceSearchError("INVALID_RESPONSE", status, true);
    logSearchFailure(query, error, failureEvent);
    throw error;
  }
  const isEnd =
    (payload as { meta?: { is_end?: boolean } }).meta?.is_end !== false;
  console.info(JSON.stringify({
    event: "kakao_place_search_completed",
    query,
    mode: options.center ? "NEAR_ADDRESS" : "KEYWORD",
    page: Number(params.get("page")),
    radiusMeters: options.center ? Number(params.get("radius")) : null,
    itemCount: places.length,
    isEnd,
  }));
  return { places, isEnd };
}

export async function searchKakaoPlaces(
  query: string,
  restApiKey: string,
  request: typeof fetch = fetch,
): Promise<KakaoPlace[]> {
  return (await searchKakaoPlacePage(query, restApiKey, {}, request)).places;
}

export async function searchKakaoPlacesNearAddress(
  query: string,
  center: KakaoCoordinate,
  restApiKey: string,
  request: typeof fetch = fetch,
  radiusMeters = 500,
): Promise<KakaoPlace[]> {
  return (await searchKakaoPlacePage(
    query,
    restApiKey,
    { center, radiusMeters },
    request,
  )).places;
}

/** 도로명·지번 주소를 WGS84 좌표 후보로 변환한다. */
export async function searchKakaoAddressCoordinates(
  address: string,
  restApiKey: string,
  request: typeof fetch = fetch,
): Promise<KakaoAddressCoordinate[]> {
  // 원문 주소는 보존하고 주소검색에는 건물 단위 표현을 사용한다.
  const query = address.normalize("NFKC").replace(
    /(?:\s+(?:(?:지하\s*)?\d+\s*층|B\d+\s*층|\d+(?:\s*,\s*\d+)*\s*F|\d+\s*동|\d+\s*호))+$/iu,
    "",
  ).trim();
  const params = new URLSearchParams({ query, analyze_type: "similar" });
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
