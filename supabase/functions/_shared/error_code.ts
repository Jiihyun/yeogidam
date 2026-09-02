export type ErrorCodeDefinition = {
  code: string;
  message: string;
  httpStatus: number | null;
  retryable: boolean;
};

/**
 * 서버와 React Native가 함께 사용하는 오류 계약의 단일 기준입니다.
 *
 * httpStatus가 null인 항목은 네트워크 단절이나 OAuth 취소처럼 HTTP 응답이
 * 만들어지지 않는 클라이언트 이벤트입니다.
 */
export const ErrorCode = {
  METHOD_NOT_ALLOWED: {
    code: "COMMON405_001",
    message: "지원하지 않는 요청 방식이에요.",
    httpStatus: 405,
    retryable: false,
  },
  AUTH_REQUIRED: {
    code: "AUTH401_001",
    message: "로그인이 필요해요.",
    httpStatus: 401,
    retryable: true,
  },
  AUTH_SESSION_EXPIRED: {
    code: "AUTH401_002",
    message: "로그인이 만료됐어요. 다시 로그인해주세요.",
    httpStatus: 401,
    retryable: true,
  },
  AUTH_FORBIDDEN: {
    code: "AUTH403_001",
    message: "이 작업을 수행할 권한이 없어요.",
    httpStatus: 403,
    retryable: false,
  },
  OAUTH_CALLBACK_FAILED: {
    code: "AUTH400_001",
    message: "로그인을 완료하지 못했어요. 다시 시도해주세요.",
    httpStatus: 400,
    retryable: true,
  },
  OAUTH_PROVIDER_UNAVAILABLE: {
    code: "AUTH502_001",
    message: "로그인 제공자 연결이 원활하지 않아요.",
    httpStatus: 502,
    retryable: true,
  },
  OAUTH_CANCELED: {
    code: "AUTH000_001",
    message: "로그인이 취소됐어요.",
    httpStatus: null,
    retryable: false,
  },
  INVALID_REQUEST_BODY: {
    code: "COMMON400_001",
    message: "요청 내용을 확인해주세요.",
    httpStatus: 400,
    retryable: false,
  },
  INVALID_QUERY_PARAMETER: {
    code: "COMMON400_002",
    message: "요청 파라미터를 확인해주세요.",
    httpStatus: 400,
    retryable: false,
  },
  INVALID_INSTAGRAM_URL: {
    code: "REEL400_001",
    message: "Instagram 게시물 주소를 확인해주세요.",
    httpStatus: 400,
    retryable: false,
  },
  RESOURCE_NOT_FOUND: {
    code: "COMMON404_001",
    message: "요청한 정보를 찾지 못했어요.",
    httpStatus: 404,
    retryable: false,
  },
  CONFLICT: {
    code: "COMMON409_001",
    message: "이미 처리된 요청이에요. 화면을 새로고침해주세요.",
    httpStatus: 409,
    retryable: false,
  },
  RATE_LIMITED: {
    code: "COMMON429_001",
    message: "요청이 너무 많아요. 잠시 후 다시 시도해주세요.",
    httpStatus: 429,
    retryable: true,
  },
  DATABASE_ERROR: {
    code: "DATA500_001",
    message: "데이터를 처리하지 못했어요. 잠시 후 다시 시도해주세요.",
    httpStatus: 500,
    retryable: true,
  },
  INTERNAL_ERROR: {
    code: "COMMON500_001",
    message: "처리 중 문제가 생겼어요.",
    httpStatus: 500,
    retryable: true,
  },
  IG_FETCH_FAILED: {
    code: "REEL424_001",
    message: "릴스 정보를 가져오지 못했어요.",
    httpStatus: 424,
    retryable: true,
  },
  IG_CAPTION_NOT_FOUND: {
    code: "REEL422_001",
    message: "릴스 캡션을 읽지 못했어요.",
    httpStatus: 422,
    retryable: false,
  },
  PROVIDER_CONFIG_MISSING: {
    code: "REEL503_001",
    message: "장소 분석 설정이 준비되지 않았어요.",
    httpStatus: 503,
    retryable: false,
  },
  GEMINI_PLACE_NOT_FOUND: {
    code: "REEL422_002",
    message: "캡션에서 장소 후보를 찾지 못했어요.",
    httpStatus: 422,
    retryable: false,
  },
  KAKAO_PLACE_NOT_FOUND: {
    code: "REEL422_003",
    message: "지도에서 일치하는 장소를 찾지 못했어요.",
    httpStatus: 422,
    retryable: false,
  },
  PLACE_NOT_FOUND: {
    code: "REEL422_004",
    message: "장소를 찾지 못했어요.",
    httpStatus: 422,
    retryable: false,
  },
  UNKNOWN: {
    code: "REEL500_001",
    message: "처리 중 문제가 생겼어요.",
    httpStatus: 500,
    retryable: true,
  },
  ACCOUNT_DELETION_REAUTH_REQUIRED: {
    code: "USER401_001",
    message: "계정 보호를 위해 다시 로그인해주세요.",
    httpStatus: 401,
    retryable: true,
  },
  ACCOUNT_DELETION_PROVIDER_UNLINK_FAILED: {
    code: "USER502_001",
    message: "연결된 로그인 계정을 해제하지 못했어요.",
    httpStatus: 502,
    retryable: true,
  },
  ACCOUNT_DELETION_FAILED: {
    code: "USER500_001",
    message: "계정을 삭제하지 못했어요. 고객지원에 문의해주세요.",
    httpStatus: 500,
    retryable: false,
  },
  APP_UPDATE_POLICY_UNAVAILABLE: {
    code: "UPDATE503_001",
    message: "업데이트 정보를 확인하지 못했어요. 잠시 후 다시 시도해주세요.",
    httpStatus: 503,
    retryable: true,
  },
  NETWORK_UNAVAILABLE: {
    code: "CLIENT000_001",
    message: "인터넷 연결을 확인해주세요.",
    httpStatus: null,
    retryable: true,
  },
  REQUEST_TIMEOUT: {
    code: "CLIENT000_002",
    message: "응답이 늦어지고 있어요. 잠시 후 다시 시도해주세요.",
    httpStatus: null,
    retryable: true,
  },
  RESPONSE_DECODE_FAILED: {
    code: "CLIENT000_003",
    message: "응답을 처리하지 못했어요.",
    httpStatus: null,
    retryable: false,
  },
} as const satisfies Record<string, ErrorCodeDefinition>;

export type ErrorCodeName = keyof typeof ErrorCode;
export type PublicErrorCode = (typeof ErrorCode)[ErrorCodeName]["code"];

export type ApiErrorResponse = {
  status: number;
  errorCode: PublicErrorCode;
  message: string;
  retryable: boolean;
  requestId: string;
  details?: Record<string, unknown>;
};

type ErrorResponseOptions = {
  details?: Record<string, unknown>;
  headers?: HeadersInit;
};

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function errorResponse(
  name: ErrorCodeName,
  requestId: string,
  options: ErrorResponseOptions = {},
): Response {
  const definition = ErrorCode[name];
  const httpStatus = definition.httpStatus ?? 500;
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  headers.set("X-Request-Id", requestId);

  const body: ApiErrorResponse = {
    status: httpStatus,
    errorCode: definition.code,
    message: definition.message,
    retryable: definition.retryable,
    requestId,
    ...(options.details ? { details: options.details } : {}),
  };

  return new Response(JSON.stringify(body), { status: httpStatus, headers });
}
