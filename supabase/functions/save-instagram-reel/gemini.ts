// 비정형 캡션 전체에서 방문 가능한 장소들을 구조화해 추출한다.
// 반환 문자열은 캡션 원문을 그대로 인용하도록 프롬프트하고, 호출자가 다시 검증한다.

export type AddressType = "ROAD" | "JIBUN" | "PARTIAL" | "NONE";

export interface PlaceGuess {
  placeName: string;
  address: string | null;
  addressType: AddressType;
  region: string | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function addressType(value: unknown): AddressType {
  return value === "ROAD" || value === "JIBUN" || value === "PARTIAL"
    ? value
    : "NONE";
}

export function parseGeminiPlaceGuesses(data: unknown): PlaceGuess[] {
  try {
    const response = data as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
    };
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") return [];

    const parsed = JSON.parse(text) as { places?: unknown };
    if (!Array.isArray(parsed.places)) return [];

    const guesses: PlaceGuess[] = [];
    for (const item of parsed.places.slice(0, 10)) {
      if (!item || typeof item !== "object") continue;
      const raw = item as Record<string, unknown>;
      const placeName = optionalString(raw.placeName);
      if (!placeName) continue;
      guesses.push({
        placeName,
        address: optionalString(raw.address),
        addressType: addressType(raw.addressType),
        region: optionalString(raw.region),
      });
    }
    return guesses;
  } catch {
    return [];
  }
}

export async function extractPlacesWithGemini(
  caption: string,
  apiKey: string,
): Promise<PlaceGuess[]> {
  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash-lite";
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const prompt =
    `다음 인스타그램 캡션에서 실제 방문 가능한 장소를 모두 추출해줘.\n` +
    `캡션:\n"""${caption}"""\n` +
    `규칙:\n` +
    `- 카페, 식당, 가게, 명소처럼 사용자가 저장할 장소마다 places 배열 원소 하나를 만든다.\n` +
    `- 한 게시물에 장소나 주소가 여러 개면 각각 별도 원소로 반환한다.\n` +
    `- 같은 장소의 도로명·지번 주소가 함께 나온 경우에는 한 원소만 만든다.\n` +
    `- placeName, address, region은 추론하거나 보정하지 말고 캡션에 실제 적힌 문자열을 그대로 복사한다.\n` +
    `- address에는 층·동·호를 포함한 가장 상세한 주소를 넣는다.\n` +
    `- addressType은 도로명 주소 ROAD, 지번 주소 JIBUN, 불완전 주소 PARTIAL, 주소 없음 NONE이다.\n` +
    `- 지점·주소·지역을 특정할 수 없는 일반 브랜드 홍보는 장소로 반환하지 않는다.\n` +
    `- 실제 장소가 없으면 places는 빈 배열이다.`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        required: ["places"],
        properties: {
          places: {
            type: "array",
            maxItems: 10,
            items: {
              type: "object",
              required: ["placeName", "address", "addressType", "region"],
              properties: {
                placeName: { type: "string" },
                address: { type: "string", nullable: true },
                addressType: {
                  type: "string",
                  enum: ["ROAD", "JIBUN", "PARTIAL", "NONE"],
                },
                region: { type: "string", nullable: true },
              },
            },
          },
        },
      },
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errorBody = (await res.text()).slice(0, 500);
      console.error(JSON.stringify({
        event: "gemini_place_extraction_failed",
        model,
        status: res.status,
        message: errorBody,
      }));
      return [];
    }
    const guesses = parseGeminiPlaceGuesses(await res.json());
    console.info(JSON.stringify({
      event: "gemini_place_extraction_completed",
      model,
      placeCount: guesses.length,
      places: guesses.map(({ placeName, address, addressType, region }) => ({
        placeName,
        address,
        addressType,
        region,
      })),
    }));
    return guesses;
  } catch (error) {
    console.error(JSON.stringify({
      event: "gemini_place_extraction_failed",
      model,
      status: null,
      message: error instanceof Error ? error.message : String(error),
    }));
    return [];
  }
}
