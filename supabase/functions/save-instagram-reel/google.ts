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
    if (!searchRes.ok) {
      console.warn(JSON.stringify({
        event: "google_places_photo_failed",
        stage: "search_text",
        reason: "http_error",
        query,
        status: searchRes.status,
      }));
      return null;
    }

    const searchData = await searchRes.json();
    const candidate = searchData?.places?.[0] as SearchCandidate | undefined;
    if (!candidate) {
      console.info(JSON.stringify({
        event: "google_places_photo_failed",
        stage: "search_text",
        reason: "no_place_candidate",
        query,
      }));
      return null;
    }

    const placeId = candidate?.id;
    const photoName = candidate?.photos?.[0]?.name;
    if (!placeId) {
      console.info(JSON.stringify({
        event: "google_places_photo_failed",
        stage: "search_text",
        reason: "missing_place_id",
        query,
      }));
      return null;
    }
    if (!photoName) {
      console.info(JSON.stringify({
        event: "google_places_photo_failed",
        stage: "search_text",
        reason: "missing_photo",
        query,
        googlePlaceId: placeId,
      }));
      return null;
    }

    const mediaUrl = new URL(
      `https://places.googleapis.com/v1/${photoName}/media`,
    );
    mediaUrl.searchParams.set("maxWidthPx", "800");
    mediaUrl.searchParams.set("maxHeightPx", "800");
    mediaUrl.searchParams.set("skipHttpRedirect", "true");
    mediaUrl.searchParams.set("key", apiKey);

    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok) {
      console.warn(JSON.stringify({
        event: "google_places_photo_failed",
        stage: "photo_media",
        reason: "http_error",
        query,
        googlePlaceId: placeId,
        status: mediaRes.status,
      }));
      return null;
    }
    const mediaData = await mediaRes.json();
    const photoUri = mediaData?.photoUri;
    if (!photoUri) {
      console.info(JSON.stringify({
        event: "google_places_photo_failed",
        stage: "photo_media",
        reason: "missing_photo_uri",
        query,
        googlePlaceId: placeId,
      }));
      return null;
    }

    return {
      placeId,
      photoUri,
      attribution: attributionText(candidate),
    };
  } catch (error) {
    console.warn(JSON.stringify({
      event: "google_places_photo_failed",
      stage: "unexpected",
      reason: "exception",
      query,
      message: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}
