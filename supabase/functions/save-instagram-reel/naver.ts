// 네이버 지역검색(Local Search) API 로 장소를 검색·매칭한다.
// 공식 API 는 대표 이미지를 주지 않으므로 이미지는 별도(thumbnail.ts)에서 베스트에포트로 처리한다.

export interface NaverPlace {
  naverPlaceId: string;
  name: string;
  category: string | null;
  roadAddress: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  link: string | null;
  telephone: string | null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

// 최신 지역검색은 mapx=경도*1e7, mapy=위도*1e7 로 준다.
// 한국 범위를 벗어나면(좌표 체계가 다르면) 좌표는 보류한다. (지도는 Plan 06)
function toWgs84(mapx: unknown, mapy: unknown): { lat: number | null; lng: number | null } {
  const x = Number(mapx), y = Number(mapy);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { lat: null, lng: null };
  const lng = x / 1e7, lat = y / 1e7;
  if (lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132) return { lat, lng };
  return { lat: null, lng: null };
}

function extractPlaceId(link: string | undefined | null): string | null {
  if (!link) return null;
  const m = link.match(/place\/(\d+)/) ?? link.match(/(\d{7,})/);
  return m ? m[1] : null;
}

export async function searchNaverPlace(
  query: string,
  clientId: string,
  clientSecret: string,
): Promise<NaverPlace | null> {
  const url = `https://openapi.naver.com/v1/search/local.json?query=${
    encodeURIComponent(query)
  }&display=5&sort=random`;
  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const item = data?.items?.[0];
  if (!item) return null;

  const name = stripTags(item.title ?? "");
  const roadAddress = item.roadAddress || null;
  const address = item.address || null;
  const { lat, lng } = toWgs84(item.mapx, item.mapy);
  const naverPlaceId = extractPlaceId(item.link) ??
    `${name}|${roadAddress ?? address ?? ""}`;

  return {
    naverPlaceId,
    name,
    category: item.category || null,
    roadAddress,
    address,
    latitude: lat,
    longitude: lng,
    link: item.link || null,
    telephone: item.telephone || null,
  };
}
