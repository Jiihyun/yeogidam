import SwiftUI

struct SavedPlaceDetailView: View {
    let savedPlace: SavedPlaceRow

    private var thumbnailURL: URL? {
        URL(string: savedPlace.thumbnailURL ?? savedPlace.place.thumbnailURL ?? "")
    }

    private var kakaoMapURL: URL? {
        if let rawLink = savedPlace.place.kakaoPlaceURL,
           let link = URL(string: rawLink) {
            return link
        }

        let address = savedPlace.place.roadAddress ?? savedPlace.place.address
        let query = [savedPlace.place.name, address]
            .compactMap { $0 }
            .joined(separator: " ")
        var components = URLComponents()
        components.scheme = "https"
        components.host = "map.kakao.com"
        components.path = "/link/search/\(query)"
        return components.url
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                thumbnail

                VStack(alignment: .leading, spacing: 8) {
                    Text(savedPlace.place.name)
                        .font(.title2.bold())
                    if let category = savedPlace.place.category, !category.isEmpty {
                        Text(category)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Text(savedPlace.place.sourceAddress ?? savedPlace.place.roadAddress ?? savedPlace.place.address ?? "주소 정보 없음")
                        .font(.body)
                }

                if let attribution = savedPlace.place.photoAttribution, !attribution.isEmpty {
                    Text("사진: \(attribution)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let url = kakaoMapURL {
                    Link("카카오맵에서 보기", destination: url)
                        .buttonStyle(.borderedProminent)
                }

                if let latitude = savedPlace.place.latitude, let longitude = savedPlace.place.longitude {
                    LabeledContent("좌표", value: "\(latitude), \(longitude)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(20)
        }
        .navigationTitle("장소")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var thumbnail: some View {
        AsyncImage(url: thumbnailURL) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFill()
            case .failure:
                placeholder
            case .empty:
                ZStack {
                    placeholder
                    ProgressView()
                }
            @unknown default:
                placeholder
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 240)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var placeholder: some View {
        Rectangle()
            .fill(.quaternary)
            .overlay {
                Image(systemName: "photo")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
            }
    }
}
