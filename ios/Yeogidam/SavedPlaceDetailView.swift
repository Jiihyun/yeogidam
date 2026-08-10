import SwiftUI

struct SavedPlaceDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appState: AppState

    let savedPlace: SavedPlaceRow

    @State private var selectedTab: PlaceDetailTab = .posts
    @State private var relatedReels: [RelatedReelRow] = []
    @State private var isLoadingReels = false
    @State private var reelsErrorMessage: String?

    private var thumbnailURL: URL? {
        URL(string: savedPlace.thumbnailURL ?? savedPlace.place.thumbnailURL ?? "")
    }

    private var displayAddress: String {
        savedPlace.place.sourceAddress
            ?? savedPlace.place.roadAddress
            ?? savedPlace.place.address
            ?? "주소 정보 없음"
    }

    private var kakaoMapURL: URL? {
        if let rawLink = savedPlace.place.kakaoPlaceURL,
           let link = URL(string: rawLink) {
            return link
        }

        let query = [savedPlace.place.name, displayAddress]
            .joined(separator: " ")
        var components = URLComponents()
        components.scheme = "https"
        components.host = "map.kakao.com"
        components.path = "/link/search/\(query)"
        return components.url
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header
                placeHeading
                placeThumbnail
                tabBar
                tabContent
            }
        }
        .background(Color(uiColor: .systemBackground))
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            mapButton
        }
        .task(id: savedPlace.place.id) {
            await loadRelatedReels()
        }
    }

    private var header: some View {
        HStack {
            Button {
                dismiss()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 40, height: 40)
            }
            .accessibilityLabel("뒤로")

            Spacer()

            Image(systemName: "heart.fill")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color(red: 0.79, green: 0.82, blue: 1.0))
                .frame(width: 40, height: 40)
                .accessibilityLabel("저장된 장소")
        }
        .padding(.horizontal, 8)
        .padding(.top, 4)
    }

    private var placeHeading: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(savedPlace.place.name)
                .font(.system(size: 25, weight: .bold))
                .foregroundStyle(.primary)

            Text(displayAddress)
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 18)
    }

    private var placeThumbnail: some View {
        ZStack(alignment: .bottomTrailing) {
            AsyncImage(url: thumbnailURL) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                case .empty:
                    ZStack {
                        placePlaceholder
                        ProgressView()
                    }
                case .failure:
                    placePlaceholder
                @unknown default:
                    placePlaceholder
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 210)
            .clipped()

            if let attribution = savedPlace.place.photoAttribution,
               !attribution.isEmpty {
                Text(attribution)
                    .font(.system(size: 9))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
                    .background(.black.opacity(0.55))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                    .padding(8)
            }
        }
    }

    private var placePlaceholder: some View {
        Rectangle()
            .fill(Color(uiColor: .secondarySystemBackground))
            .overlay {
                Image(systemName: "photo")
                    .font(.largeTitle)
                    .foregroundStyle(.tertiary)
            }
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(PlaceDetailTab.allCases) { tab in
                Button {
                    selectedTab = tab
                } label: {
                    VStack(spacing: 10) {
                        Text(tab.title)
                            .font(.system(size: 14, weight: selectedTab == tab ? .bold : .medium))
                            .foregroundStyle(selectedTab == tab ? .primary : .tertiary)

                        Rectangle()
                            .fill(selectedTab == tab ? Color.primary : Color.clear)
                            .frame(height: 2)
                    }
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.top, 16)
        .overlay(alignment: .bottom) {
            Divider()
        }
    }

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .home:
            homeContent
        case .posts:
            relatedReelsContent
        case .reviews:
            emptyContent(
                icon: "text.bubble",
                message: "아직 등록된 리뷰가 없어요."
            )
        }
    }

    private var homeContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            detailRow(title: "주소", value: displayAddress)

            if let category = savedPlace.place.category,
               !category.isEmpty {
                detailRow(title: "카테고리", value: category)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
    }

    @ViewBuilder
    private var relatedReelsContent: some View {
        if isLoadingReels && relatedReels.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: 220)
        } else if let reelsErrorMessage, relatedReels.isEmpty {
            VStack(spacing: 12) {
                Text(reelsErrorMessage)
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                Button {
                    Task { await loadRelatedReels() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("다시 시도")
            }
            .frame(maxWidth: .infinity, minHeight: 220)
        } else if relatedReels.isEmpty {
            emptyContent(
                icon: "play.rectangle",
                message: "이 장소와 연결된 릴스가 없어요."
            )
        } else {
            LazyVGrid(
                columns: [
                    GridItem(.flexible(), spacing: 10),
                    GridItem(.flexible(), spacing: 10),
                ],
                spacing: 10
            ) {
                ForEach(relatedReels) { reel in
                    if let url = URL(string: reel.instagramURL) {
                        Link(destination: url) {
                            RelatedReelThumbnail(reel: reel)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Instagram 릴스 열기")
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
    }

    private func detailRow(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 15))
                .foregroundStyle(.primary)
        }
    }

    private func emptyContent(icon: String, message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 26))
                .foregroundStyle(.tertiary)
            Text(message)
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    @ViewBuilder
    private var mapButton: some View {
        if let kakaoMapURL {
            Link(destination: kakaoMapURL) {
                Label("카카오맵으로 바로가기", systemImage: "paperplane.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(Color(red: 0.55, green: 0.59, blue: 0.92))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)
        }
    }

    private func loadRelatedReels() async {
        guard let accessToken = appState.session?.accessToken else {
            reelsErrorMessage = YeogidamAPIError.missingSession.localizedDescription
            return
        }

        isLoadingReels = true
        defer { isLoadingReels = false }
        do {
            relatedReels = try await YeogidamAPI(accessToken: accessToken)
                .fetchRelatedReels(placeID: savedPlace.place.id)
            reelsErrorMessage = nil
        } catch {
            reelsErrorMessage = "관련 릴스를 불러오지 못했어요."
        }
    }
}

private enum PlaceDetailTab: String, CaseIterable, Identifiable {
    case home
    case posts
    case reviews

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: "홈"
        case .posts: "게시물"
        case .reviews: "리뷰"
        }
    }
}

private struct RelatedReelThumbnail: View {
    let reel: RelatedReelRow

    private var thumbnailURL: URL? {
        URL(string: reel.instagramThumbnailURL ?? "")
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            AsyncImage(url: thumbnailURL) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                case .empty:
                    ZStack {
                        placeholder
                        ProgressView()
                    }
                case .failure:
                    placeholder
                @unknown default:
                    placeholder
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Image(systemName: "play.rectangle.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
                .padding(8)
        }
        .aspectRatio(0.75, contentMode: .fit)
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .contentShape(RoundedRectangle(cornerRadius: 8))
    }

    private var placeholder: some View {
        Rectangle()
            .fill(Color(uiColor: .secondarySystemBackground))
            .overlay {
                Image(systemName: "play.fill")
                    .font(.title2)
                    .foregroundStyle(.tertiary)
            }
    }
}
