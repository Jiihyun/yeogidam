import Foundation

enum ProcessingStatus: String, Decodable {
    case pending = "PENDING"
    case processing = "PROCESSING"
    case completed = "COMPLETED"
    case failed = "FAILED"
}

enum FailureReason: String, Decodable {
    case instagramFetchFailed = "IG_FETCH_FAILED"
    case placeNotFound = "PLACE_NOT_FOUND"
    case unknown = "UNKNOWN"

    var displayText: String {
        switch self {
        case .instagramFetchFailed:
            return "릴스 정보를 가져오지 못했어요"
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
    let naverLink: String?
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
        case naverLink = "naver_link"
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

struct SavedPlacesSnapshot {
    let savedPlaces: [SavedPlaceRow]
    let activeReels: [ReelRow]
}

struct SaveInstagramReelResponse: Decodable {
    let reelId: UUID
    let status: String?
}
