// 2026-Yeogidam의 분석 규칙을 이식하기 위한 실행 가능한 명세.
import {
  analyzeInstagramPlaces,
  buildSourceSearchQueries,
  type SourcePlaceHint,
} from "./source_analysis.ts";
import type { KakaoPlace } from "./kakao.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function hint(
  name: string,
  overrides: Partial<SourcePlaceHint> = {},
): SourcePlaceHint {
  return {
    nameInCaption: name,
    nameSearchHint: null,
    accountHints: [],
    locationHints: [],
    categoryHint: null,
    ...overrides,
  };
}

function place(id: string, name = "카카오 정식 명칭"): KakaoPlace {
  return {
    kakaoPlaceId: id,
    name,
    category: "음식점",
    roadAddress: "서울 성동구 왕십리로 10",
    address: "서울 성동구 성수동1가 1",
    latitude: 37.5,
    longitude: 127,
    placeUrl: `https://place.map.kakao.com/${id}`,
    telephone: null,
  };
}

const input = {
  instagramUrl: "https://www.instagram.com/reel/ABC/",
  caption: "오늘 방문한 곳",
  authorUsername: "ordinary_author",
};

Deno.test("캡션이 비어 있으면 이미지나 영상이 있어도 분석을 시작하지 않는다", async () => {
  for (const caption of ["", "   "]) {
    const result = await analyzeInstagramPlaces({ ...input, caption }, {
      extractCaption: async () => {
        throw new Error("호출하면 안 됩니다");
      },
      extractMedia: async () => {
        throw new Error("호출하면 안 됩니다");
      },
      search: async () => {
        throw new Error("호출하면 안 됩니다");
      },
    });
    equal(result.failureReason, "IG_CAPTION_NOT_FOUND");
    equal(result.matches, []);
  }
});

Deno.test("일반 작성자의 캡션에서 장소를 찾으면 미디어 분석을 호출하지 않는다", async () => {
  const calls: string[] = [];
  const result = await analyzeInstagramPlaces(input, {
    extractCaption: async (caption: string) => {
      equal(caption, input.caption);
      calls.push("caption");
      return [hint("카페")];
    },
    extractMedia: async () => {
      throw new Error("미디어 분석을 호출하면 안 됩니다");
    },
    search: async (query: string) => {
      calls.push(query);
      return [place("100")];
    },
  });
  equal(calls, ["caption", "카페"]);
  equal(result.matches.map((match) => match.place), [place("100")]);
});

Deno.test("캡션 추출 결과가 비어 있으면 캡션과 원본 URL로 미디어를 분석한다", async () => {
  const calls: string[] = [];
  const result = await analyzeInstagramPlaces(input, {
    extractCaption: async () => {
      calls.push("caption");
      return [];
    },
    extractMedia: async (caption: string, url: string) => {
      equal([caption, url], [input.caption, input.instagramUrl]);
      calls.push("media");
      return [hint("영상 속 카페", {
        locationHints: [{
          type: "ADDRESS",
          value: "서울 성동구 왕십리로 10",
          basis: "VIDEO",
        }],
      })];
    },
    search: async (query: string) => {
      calls.push(query);
      return [place("100")];
    },
  });
  equal(calls, ["caption", "media", "영상 속 카페 성동구"]);
  equal(result.matches.length, 1);
});

Deno.test("with_sol_mate 작성자는 캡션 분석 없이 처음부터 통합 미디어 분석을 한다", async () => {
  let mediaCalls = 0;
  await analyzeInstagramPlaces({ ...input, authorUsername: "with_sol_mate" }, {
    extractCaption: async () => {
      throw new Error("캡션 단독 분석을 호출하면 안 됩니다");
    },
    extractMedia: async () => {
      mediaCalls++;
      return [hint("카페")];
    },
    search: async () => [place("100")],
  });
  equal(mediaCalls, 1);
});

Deno.test("캡션 추출 오류는 빈 결과로 바꾸거나 미디어 분석으로 숨기지 않는다", async () => {
  const failure = new Error("Gemini unavailable");
  let caught: unknown;
  try {
    await analyzeInstagramPlaces(input, {
      extractCaption: async () => {
        throw failure;
      },
      extractMedia: async () => {
        throw new Error("호출하면 안 됩니다");
      },
      search: async () => [],
    });
  } catch (error) {
    caught = error;
  }
  equal(caught === failure, true);
});

Deno.test("캡션과 미디어 모두 장소가 없으면 기존 장소 추출 실패 코드로 연결한다", async () => {
  const result = await analyzeInstagramPlaces(input, {
    extractCaption: async () => [],
    extractMedia: async () => [],
    search: async () => {
      throw new Error("카카오 검색을 호출하면 안 됩니다");
    },
  });
  equal(result.failureReason, "GEMINI_PLACE_NOT_FOUND");
  equal(result.matches, []);
});

Deno.test("보정명을 우선하고 상세 주소에서 구를 뽑아 검색한다", () => {
  equal(
    buildSourceSearchQueries(hint("송화산시도삭멘", {
      nameSearchHint: "송화산시도삭면",
      locationHints: [
        { type: "REGION", value: "건대", basis: "VIDEO" },
        {
          type: "ADDRESS",
          value: "서울 광진구 뚝섬로27길 48 2층",
          basis: "CAPTION",
        },
      ],
    })),
    ["송화산시도삭면 광진구", "송화산시도삭면"],
  );
});

Deno.test("주소의 읍면동은 구군시보다 우선하고 캡션 주소는 다른 출처의 주소보다 우선한다", () => {
  equal(
    buildSourceSearchQueries(hint("카페", {
      locationHints: [
        { type: "ADDRESS", value: "부산 부산진구 전포동 1", basis: "VIDEO" },
        { type: "ADDRESS", value: "서울 마포구 연남동 1", basis: "CAPTION" },
      ],
    })),
    ["카페 연남동", "카페"],
  );
});

for (const basis of ["VIDEO", "IMAGE", "INFERRED", "CAPTION"] as const) {
  Deno.test(`주소가 없으면 지역 출처 우선순위에 따라 ${basis} 단서를 사용한다`, () => {
    const order = ["VIDEO", "IMAGE", "INFERRED", "CAPTION"] as const;
    const remaining = order.slice(order.indexOf(basis));
    equal(
      buildSourceSearchQueries(hint("카페", {
        locationHints: [...remaining].reverse().map((source) => ({
          type: "REGION" as const,
          value: `${source}지역`,
          basis: source,
        })),
      })),
      [`카페 ${basis}지역`, "카페"],
    );
  });
}

Deno.test("검색명에 지역이 이미 포함되어 있으면 같은 지역을 다시 붙이지 않는다", () => {
  equal(
    buildSourceSearchQueries(hint("파이프그라운드 서울숲점", {
      locationHints: [{ type: "REGION", value: "서울숲", basis: "INFERRED" }],
    })),
    ["파이프그라운드 서울숲점"],
  );
});

Deno.test("지역 검색 결과가 없을 때만 이름만으로 재검색하고 첫 유효 장소를 선택한다", async () => {
  const calls: string[] = [];
  const result = await analyzeInstagramPlaces(input, {
    extractCaption: async () => [hint("올드빅", {
      locationHints: [{ type: "REGION", value: "성수", basis: "CAPTION" }],
    })],
    extractMedia: async () => [],
    search: async (query: string) => {
      calls.push(query);
      return query === "올드빅 성수" ? [] : [place("100"), place("200")];
    },
  });
  equal(calls, ["올드빅 성수", "올드빅"]);
  equal(result.matches.map((match) => match.place.kakaoPlaceId), ["100"]);
});

Deno.test("복수 후보의 첫 결과는 이름이나 주소를 재검증하거나 2차 AI에 넘기지 않는다", async () => {
  const calls: string[] = [];
  const result = await analyzeInstagramPlaces(input, {
    extractCaption: async () => [hint("파이프그라운드 서울숲점", {
      locationHints: [{ type: "REGION", value: "서울숲", basis: "INFERRED" }],
    })],
    extractMedia: async () => [],
    search: async (query: string) => {
      calls.push(query);
      return [
        place("100", "파이프그라운드 한남"),
        place("200", "파이프그라운드 서울숲"),
      ];
    },
  });
  equal(calls, ["파이프그라운드 서울숲점"]);
  equal(result.matches.map((match) => match.place.kakaoPlaceId), ["100"]);
});

Deno.test("일부 장소가 검색되지 않아도 나머지를 입력 순서대로 반환하고 카카오 ID 중복을 제거한다", async () => {
  const result = await analyzeInstagramPlaces(input, {
    extractCaption: async () => [
      hint("첫 장소"),
      hint("없는 장소"),
      hint("별칭"),
      hint("마지막 장소"),
    ],
    extractMedia: async () => [],
    search: async (query: string) =>
      query === "없는 장소"
        ? []
        : [place(query === "마지막 장소" ? "200" : "100")],
  });
  equal(result.matches.map((match) => match.place.kakaoPlaceId), [
    "100",
    "200",
  ]);
  equal(result.failureReason, null);
});

Deno.test("모든 장소의 카카오 검색 결과가 비어 있으면 기존 매칭 실패 코드로 연결한다", async () => {
  const result = await analyzeInstagramPlaces(input, {
    extractCaption: async () => [hint("없는 장소")],
    extractMedia: async () => [],
    search: async () => [],
  });
  equal(result.failureReason, "KAKAO_PLACE_NOT_FOUND");
});

Deno.test("카카오 공급자 오류는 검색 결과 없음이나 부분 성공으로 바꾸지 않는다", async () => {
  const failure = new Error("Kakao 429");
  let caught: unknown;
  try {
    await analyzeInstagramPlaces(input, {
      extractCaption: async () => [hint("성공 장소"), hint("오류 장소")],
      extractMedia: async () => [],
      search: async (query: string) => {
        if (query === "오류 장소") throw failure;
        return [place("100")];
      },
    });
  } catch (error) {
    caught = error;
  }
  equal(caught === failure, true);
});
