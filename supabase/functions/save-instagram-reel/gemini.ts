// 비정형 캡션에서 장소명/지역명을 추출한다 (AI 처리, 2순위).
// 구조화된 JSON 으로 응답받는다.

export interface PlaceGuess {
  placeName: string | null;
  region: string | null;
}

export async function extractPlaceWithGemini(
  caption: string,
  apiKey: string,
): Promise<PlaceGuess | null> {
  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.0-flash";
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
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text);
    return {
      placeName: parsed.placeName ?? null,
      region: parsed.region ?? null,
    };
  } catch {
    return null;
  }
}
