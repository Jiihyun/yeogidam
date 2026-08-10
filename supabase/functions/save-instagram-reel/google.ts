// Google Places API 로 장소 사진을 찾는다.
// MVP 실험용으로 첫 사진을 받아 Supabase Storage 에 재호스팅하는 파이프라인에서 사용한다.

export interface GooglePlacePhoto {
  placeId: string;
  photoUri: string;
  attribution: string | null;
}

interface SearchCandidate {
  id?: string;
  photos?: Array<{
    name?: string;
    authorAttributions?: Array<{
      displayName?: string;
      uri?: string;
    }>;
  }>;
}

function attributionText(candidate: SearchCandidate): string | null {
  const items = candidate.photos?.[0]?.authorAttributions ?? [];
  if (items.length === 0) return null;
  return items
    .map((item) => item.displayName || item.uri)
    .filter(Boolean)
    .join(", ") || null;
}

export async function findGooglePlacePhoto(
  query: string,
  apiKey: string,
): Promise<GooglePlacePhoto | null> {
  try {
    const searchRes = await fetch(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask":
            "places.id,places.photos.name,places.photos.authorAttributions",
        },
        body: JSON.stringify({
          textQuery: query,
          languageCode: "ko",
          regionCode: "KR",
          maxResultCount: 1,
        }),
      },
    );
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const candidate = searchData?.places?.[0] as SearchCandidate | undefined;
    const placeId = candidate?.id;
    const photoName = candidate?.photos?.[0]?.name;
    if (!placeId || !photoName) return null;

    const mediaUrl = new URL(
      `https://places.googleapis.com/v1/${photoName}/media`,
    );
    mediaUrl.searchParams.set("maxWidthPx", "800");
    mediaUrl.searchParams.set("maxHeightPx", "800");
    mediaUrl.searchParams.set("skipHttpRedirect", "true");
    mediaUrl.searchParams.set("key", apiKey);

    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok) return null;
    const mediaData = await mediaRes.json();
    const photoUri = mediaData?.photoUri;
    if (!photoUri) return null;

    return {
      placeId,
      photoUri,
      attribution: attributionText(candidate),
    };
  } catch {
    return null;
  }
}
