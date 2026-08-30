import Foundation

enum YeogidamAPIError: LocalizedError {
    case missingSession
    case invalidResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .missingSession:
            return "로그인이 필요해요."
        case .invalidResponse:
            return "응답을 읽지 못했어요."
        case .server(let message):
            return message
        }
    }
}

struct YeogidamAPI {
    let accessToken: String

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        return decoder
    }()

    func saveInstagramReel(_ instagramURL: String) async throws -> SaveInstagramReelResponse {
        var request = URLRequest(url: YeogidamConfig.saveInstagramReelFunctionURL)
        request.httpMethod = "POST"
        applyAuthHeaders(to: &request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "instagramUrl": instagramURL,
            "source": "url_input",
        ])

        let data = try await data(for: request, acceptedStatusCodes: 200..<300)
        return try decoder.decode(SaveInstagramReelResponse.self, from: data)
    }

    #if LOCAL_BUILD
    func fetchWaitingQueue() async throws -> [QueueReelRow] {
        var components = restComponents(path: "reels")
        components.queryItems = [
            URLQueryItem(
                name: "select",
                value: "id,instagram_title,instagram_description,instagram_author_username,instagram_thumbnail_url,reel_places!inner(id,position,review_status,reviewed_at,place:places(id,name,category,source_address,road_address,address,latitude,longitude,kakao_place_url,thumbnail_url,photo_attribution))"
            ),
            URLQueryItem(name: "processing_status", value: "eq.COMPLETED"),
            URLQueryItem(name: "save_mode", value: "eq.REVIEW_QUEUE"),
            URLQueryItem(name: "reel_places.review_status", value: "eq.PENDING"),
            URLQueryItem(name: "order", value: "created_at.desc"),
            URLQueryItem(name: "reel_places.order", value: "position.asc"),
        ]
        let reels: [QueueReelRow] = try await get(components)
        return reels.filter { !$0.pendingPlaces.isEmpty }
    }

    func fetchProcessingQueueReelIDs() async throws -> [UUID] {
        var components = restComponents(path: "reels")
        components.queryItems = [
            URLQueryItem(name: "select", value: "id"),
            URLQueryItem(name: "save_mode", value: "eq.REVIEW_QUEUE"),
            URLQueryItem(name: "processing_status", value: "in.(PENDING,PROCESSING)"),
        ]
        let reels: [QueueProcessingRow] = try await get(components)
        return reels.map(\.id)
    }

    func fetchQueueReelStates(ids: [UUID]) async throws -> [QueueReelStateRow] {
        guard !ids.isEmpty else { return [] }

        var components = restComponents(path: "reels")
        components.queryItems = [
            URLQueryItem(
                name: "select",
                value: "id,processing_status,failure_reason,save_mode"
            ),
            URLQueryItem(
                name: "id",
                value: "in.(\(ids.map(\.uuidString).joined(separator: ",")))"
            ),
        ]
        return try await get(components)
    }

    func resolveQueueItems(ids: [UUID], action: QueueAction) async throws {
        guard !ids.isEmpty else { return }

        let url = YeogidamConfig.supabaseURL
            .appendingPathComponent("rest/v1/rpc/resolve_queue_items")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        applyAuthHeaders(to: &request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "p_reel_place_ids": ids.map(\.uuidString),
            "p_action": action.rawValue,
        ])
        _ = try await data(
            for: request,
            acceptedStatusCodes: 200..<300,
            mapsQueueErrors: true
        )
    }
    #endif

    func fetchSnapshot() async throws -> SavedPlacesSnapshot {
        async let savedPlaces: [SavedPlaceRow] = fetchSavedPlaces()
        async let activeReels: [ReelRow] = fetchActiveReels()
        return try await SavedPlacesSnapshot(savedPlaces: savedPlaces, activeReels: activeReels)
    }

    func deleteSavedPlace(id: UUID) async throws {
        var components = restComponents(path: "saved_places")
        components.queryItems = [
            URLQueryItem(name: "id", value: "eq.\(id.uuidString)"),
        ]
        guard let url = components.url else { throw YeogidamAPIError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        applyAuthHeaders(to: &request)
        _ = try await data(for: request, acceptedStatusCodes: 200..<300)
    }

    func fetchRelatedReels(placeID: UUID) async throws -> [RelatedReelRow] {
        var components = restComponents(path: "reels")
        components.queryItems = [
            URLQueryItem(
                name: "select",
                value: "id,instagram_url,instagram_thumbnail_url,created_at,reel_places!inner(place_id)"
            ),
            URLQueryItem(name: "processing_status", value: "eq.COMPLETED"),
            URLQueryItem(name: "reel_places.place_id", value: "eq.\(placeID.uuidString)"),
            URLQueryItem(name: "order", value: "created_at.desc"),
        ]
        return try await get(components)
    }

    private func fetchSavedPlaces() async throws -> [SavedPlaceRow] {
        var components = restComponents(path: "saved_places")
        components.queryItems = [
            URLQueryItem(
                name: "select",
                value: "id,thumbnail_url,created_at,place:places(id,name,category,source_address,road_address,address,latitude,longitude,kakao_place_url,thumbnail_url,photo_attribution)"
            ),
            URLQueryItem(name: "order", value: "created_at.desc"),
        ]
        return try await get(components)
    }

    private func fetchActiveReels() async throws -> [ReelRow] {
        var components = restComponents(path: "reels")
        components.queryItems = [
            URLQueryItem(
                name: "select",
                value: "id,instagram_url,processing_status,failure_reason,instagram_thumbnail_url,created_at"
            ),
            URLQueryItem(name: "processing_status", value: "in.(PENDING,PROCESSING,FAILED)"),
            URLQueryItem(name: "order", value: "created_at.desc"),
        ]
        return try await get(components)
    }

    private func get<T: Decodable>(_ components: URLComponents) async throws -> T {
        guard let url = components.url else { throw YeogidamAPIError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        applyAuthHeaders(to: &request)
        let data = try await data(for: request, acceptedStatusCodes: 200..<300)
        return try decoder.decode(T.self, from: data)
    }

    private func restComponents(path: String) -> URLComponents {
        let url = YeogidamConfig.supabaseURL.appendingPathComponent("rest/v1").appendingPathComponent(path)
        return URLComponents(url: url, resolvingAgainstBaseURL: false)!
    }

    private func applyAuthHeaders(to request: inout URLRequest) {
        request.setValue(YeogidamConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    }

    private func data(
        for request: URLRequest,
        acceptedStatusCodes: Range<Int>,
        mapsQueueErrors: Bool = false
    ) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw YeogidamAPIError.invalidResponse }
        guard acceptedStatusCodes.contains(http.statusCode) else {
            #if LOCAL_BUILD
            if mapsQueueErrors {
                let message = (try? decoder.decode(APIErrorResponse.self, from: data).message)
                    ?? "요청이 실패했어요."
                throw YeogidamAPIError.server(queueMessage(for: message))
            }
            #endif
            let message = String(data: data, encoding: .utf8) ?? "요청이 실패했어요."
            throw YeogidamAPIError.server(message)
        }
        return data
    }

    #if LOCAL_BUILD
    private func queueMessage(for message: String) -> String {
        switch message {
        case "queue_items_not_available", "queue_items_changed_during_request":
            return "이미 처리된 장소가 있어요. 새로고침 후 다시 선택해주세요."
        case "queue_selection_required":
            return "저장하거나 삭제할 장소를 선택해주세요."
        case "queue_selection_contains_duplicates_or_nulls":
            return "선택한 장소 목록이 올바르지 않아요. 새로고침 후 다시 선택해주세요."
        case "invalid_queue_action":
            return "지원하지 않는 대기함 작업이에요."
        case "authentication_required":
            return "로그인이 필요해요."
        default:
            return message
        }
    }
    #endif
}

#if LOCAL_BUILD
private struct QueueProcessingRow: Decodable {
    let id: UUID
}

private struct APIErrorResponse: Decodable {
    let message: String
}
#endif
