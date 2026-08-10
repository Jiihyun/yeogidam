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
        var request = URLRequest(url: YeogidamConfig.supabaseURL.appendingPathComponent("functions/v1/save-instagram-reel"))
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

    private func data(for request: URLRequest, acceptedStatusCodes: Range<Int>) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw YeogidamAPIError.invalidResponse }
        guard acceptedStatusCodes.contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "요청이 실패했어요."
            throw YeogidamAPIError.server(message)
        }
        return data
    }
}
