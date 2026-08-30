import Foundation

enum ProcessingStatus: String, Decodable {
    case pending = "PENDING"
    case processing = "PROCESSING"
    case completed = "COMPLETED"
    case failed = "FAILED"
}

enum FailureReason: String, Decodable {
    case instagramFetchFailed = "IG_FETCH_FAILED"
    case instagramCaptionNotFound = "IG_CAPTION_NOT_FOUND"
    case providerConfigMissing = "PROVIDER_CONFIG_MISSING"
    case geminiPlaceNotFound = "GEMINI_PLACE_NOT_FOUND"
    case kakaoPlaceNotFound = "KAKAO_PLACE_NOT_FOUND"
    case placeNotFound = "PLACE_NOT_FOUND"
    case unknown = "UNKNOWN"

    var displayText: String {
        switch self {
        case .instagramFetchFailed:
            return "릴스 정보를 가져오지 못했어요"
        case .instagramCaptionNotFound:
            return "릴스 캡션을 읽지 못했어요"
        case .providerConfigMissing:
            return "장소 분석 설정이 누락됐어요"
        case .geminiPlaceNotFound:
            return "캡션에서 장소 후보를 찾지 못했어요"
        case .kakaoPlaceNotFound:
            return "지도에서 일치하는 장소를 찾지 못했어요"
        case .placeNotFound:
            return "장소를 찾지 못했어요"
        case .unknown:
            return "처리 중 문제가 생겼어요"
        }
    }
}

struct SavedPlaceRow: Identifiable, Decodable {
    let id: UUID
    let thumbnailURL: String?
    let createdAt: String
    let place: PlaceRow

    enum CodingKeys: String, CodingKey {
        case id
        case thumbnailURL = "thumbnail_url"
        case createdAt = "created_at"
        case place
    }
}

struct PlaceRow: Identifiable, Decodable {
    let id: UUID
    let name: String
    let category: String?
    let sourceAddress: String?
    let roadAddress: String?
    let address: String?
    let latitude: Double?
    let longitude: Double?
    let kakaoPlaceURL: String?
    let thumbnailURL: String?
    let photoAttribution: String?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case category
        case sourceAddress = "source_address"
        case roadAddress = "road_address"
        case address
        case latitude
        case longitude
        case kakaoPlaceURL = "kakao_place_url"
        case thumbnailURL = "thumbnail_url"
        case photoAttribution = "photo_attribution"
    }
}

struct ReelRow: Identifiable, Decodable {
    let id: UUID
    let instagramURL: String
    let processingStatus: ProcessingStatus
    let failureReason: FailureReason?
    let instagramThumbnailURL: String?
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case instagramURL = "instagram_url"
        case processingStatus = "processing_status"
        case failureReason = "failure_reason"
        case instagramThumbnailURL = "instagram_thumbnail_url"
        case createdAt = "created_at"
    }
}

struct RelatedReelRow: Identifiable, Decodable {
    let id: UUID
    let instagramURL: String
    let instagramThumbnailURL: String?
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case instagramURL = "instagram_url"
        case instagramThumbnailURL = "instagram_thumbnail_url"
        case createdAt = "created_at"
    }
}

struct SavedPlacesSnapshot {
    let savedPlaces: [SavedPlaceRow]
    let activeReels: [ReelRow]
}

struct SaveInstagramReelResponse: Decodable {
    let reelId: UUID
    let status: String?
    #if LOCAL_BUILD
    let saveMode: ReelSaveMode?
    #endif
}

#if LOCAL_BUILD
enum ReelSaveMode: String, Decodable {
    case autoSave = "AUTO_SAVE"
    case reviewQueue = "REVIEW_QUEUE"
}

enum QueueReviewStatus: String, Decodable {
    case pending = "PENDING"
    case saved = "SAVED"
    case discarded = "DISCARDED"
}

enum QueueAction: String {
    case save = "SAVE"
    case discard = "DISCARD"

    func confirmationTitle(count: Int) -> String {
        switch self {
        case .save:
            return "\(count)개의 장소를 저장할까요?"
        case .discard:
            return "선택한 \(count)개의 장소를 삭제할까요?"
        }
    }
}

struct QueueReelPlaceRow: Identifiable, Decodable {
    let id: UUID
    let position: Int
    let reviewStatus: QueueReviewStatus
    let reviewedAt: String?
    let place: PlaceRow

    enum CodingKeys: String, CodingKey {
        case id
        case position
        case reviewStatus = "review_status"
        case reviewedAt = "reviewed_at"
        case place
    }
}

struct QueueReelRow: Identifiable, Decodable {
    let id: UUID
    let instagramTitle: String?
    let instagramDescription: String?
    let instagramAuthorUsername: String?
    let instagramThumbnailURL: String?
    let reelPlaces: [QueueReelPlaceRow]

    enum CodingKeys: String, CodingKey {
        case id
        case instagramTitle = "instagram_title"
        case instagramDescription = "instagram_description"
        case instagramAuthorUsername = "instagram_author_username"
        case instagramThumbnailURL = "instagram_thumbnail_url"
        case reelPlaces = "reel_places"
    }

    var caption: String {
        instagramDescription?.queueNonEmpty
            ?? instagramTitle?.queueNonEmpty
            ?? "캡션 없음"
    }

    var author: String {
        guard let username = instagramAuthorUsername?.queueNonEmpty else {
            return "작성자 정보 없음"
        }
        return username.hasPrefix("@") ? username : "@\(username)"
    }

    var pendingPlaces: [QueueReelPlaceRow] {
        reelPlaces
            .filter { $0.reviewStatus == .pending }
            .sorted { $0.position < $1.position }
    }
}

struct QueueReelStateRow: Identifiable, Decodable {
    let id: UUID
    let processingStatus: ProcessingStatus
    let failureReason: FailureReason?
    let saveMode: ReelSaveMode

    enum CodingKeys: String, CodingKey {
        case id
        case processingStatus = "processing_status"
        case failureReason = "failure_reason"
        case saveMode = "save_mode"
    }
}

struct HistoryReelRow: Identifiable, Decodable {
    let id: UUID
    let instagramURL: String
    let instagramTitle: String?
    let instagramDescription: String?
    let instagramAuthorUsername: String?
    let instagramThumbnailURL: String?
    let processingStatus: ProcessingStatus
    let failureReason: FailureReason?
    let saveMode: ReelSaveMode
    let createdAt: String
    /// History list requests omit this relationship. Detail requests include it,
    /// including an empty array when analysis completed without a matched place.
    let reelPlaces: [QueueReelPlaceRow]?

    enum CodingKeys: String, CodingKey {
        case id
        case instagramURL = "instagram_url"
        case instagramTitle = "instagram_title"
        case instagramDescription = "instagram_description"
        case instagramAuthorUsername = "instagram_author_username"
        case instagramThumbnailURL = "instagram_thumbnail_url"
        case processingStatus = "processing_status"
        case failureReason = "failure_reason"
        case saveMode = "save_mode"
        case createdAt = "created_at"
        case reelPlaces = "reel_places"
    }

    var historyTitle: String {
        if let title = instagramTitle?.queueNonEmpty {
            return title
        }

        if let firstLine = instagramDescription?
            .split(whereSeparator: { $0.isNewline })
            .lazy
            .map({ String($0).trimmingCharacters(in: .whitespacesAndNewlines) })
            .first(where: { !$0.isEmpty }) {
            return firstLine
        }

        return "Instagram 릴스"
    }

    var author: String {
        guard let username = instagramAuthorUsername?.queueNonEmpty else {
            return "작성자 정보 없음"
        }
        return username.hasPrefix("@") ? username : "@\(username)"
    }

    var orderedPlaces: [QueueReelPlaceRow] {
        (reelPlaces ?? []).sorted { $0.position < $1.position }
    }

    var createdDate: Date? {
        LocalHistoryDateParser.date(from: createdAt)
    }

    var historyCursor: HistoryCursor {
        HistoryCursor(createdAt: createdAt, id: id)
    }
}

struct HistoryCursor: Equatable {
    let createdAt: String
    let id: UUID
}

struct HistoryPage {
    let reels: [HistoryReelRow]
    let nextCursor: HistoryCursor?
}

extension PlaceRow {
    var queueDisplayAddress: String {
        sourceAddress?.queueNonEmpty
            ?? roadAddress?.queueNonEmpty
            ?? address?.queueNonEmpty
            ?? "주소 정보 없음"
    }

    var queueDisplayCategory: String {
        category?.queueNonEmpty ?? "카테고리 미분류"
    }
}

private extension String {
    var queueNonEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

private enum LocalHistoryDateParser {
    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let formatter = ISO8601DateFormatter()

    static func date(from value: String) -> Date? {
        fractionalFormatter.date(from: value) ?? formatter.date(from: value)
    }
}
#endif
