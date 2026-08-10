// 비정형 캡션에서 장소명/지역명을 추출한다 (AI 처리, 2순위).
// 구조화된 JSON 으로 응답받는다.

export interface PlaceGuess {
  placeName: string | null;
  region: string | null;
}

export function parseGeminiPlaceGuess(data: unknown): PlaceGuess | null {
  try {
    const response = data as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
    };
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") return null;

    const parsed = JSON.parse(text) as {
      placeName?: unknown;
      region?: unknown;
    };
    const placeName = typeof parsed.placeName === "string"
      ? parsed.placeName.trim() || null
      : null;
    const region = typeof parsed.region === "string"
      ? parsed.region.trim() || null
      : null;
    return placeName || region ? { placeName, region } : null;
  } catch {
    return null;
  }
}

export async function extractPlaceWithGemini(
  caption: string,
  apiKey: string,
): Promise<PlaceGuess | null> {
  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash-lite";
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const prompt =
    `다음 인스타그램 캡션에서 실제 방문 가능한 장소(카페/식당/가게/명소 등) 하나의 이름과 지역명을 추출해줘.\n` +
    `캡션:\n"""${caption}"""\n` +
    `규칙: 상호명을 placeName 에, 동/구/지역명을 region 에 넣어라. 장소를 특정할 수 없으면 둘 다 null.`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          placeName: { type: "string", nullable: true },
          region: { type: "string", nullable: true },
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
      return null;
    }
    const data = await res.json();
    const guess = parseGeminiPlaceGuess(data);
    console.info(JSON.stringify({
      event: "gemini_place_extraction_completed",
      model,
      placeName: guess?.placeName ?? null,
      region: guess?.region ?? null,
    }));
    return guess;
  } catch (error) {
    console.error(JSON.stringify({
      event: "gemini_place_extraction_failed",
      model,
      status: null,
      message: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}
