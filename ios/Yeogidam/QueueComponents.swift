#if LOCAL_BUILD
import SwiftUI

struct QueueRemoteThumbnail: View {
    let urlString: String?
    var systemImage = "photo"
    var width: CGFloat = 72
    var height: CGFloat = 72
    var cornerRadius: CGFloat = 10

    private var url: URL? {
        guard let urlString, !urlString.isEmpty else { return nil }
        return URL(string: urlString)
    }

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .scaledToFill()
            case .empty:
                placeholder
                    .overlay { ProgressView().controlSize(.small) }
            case .failure:
                placeholder
            @unknown default:
                placeholder
            }
        }
        .frame(width: width, height: height)
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
    }

    private var placeholder: some View {
        Rectangle()
            .fill(Color(uiColor: .secondarySystemBackground))
            .overlay {
                Image(systemName: systemImage)
                    .font(.system(size: min(width, height) * 0.3))
                    .foregroundStyle(.tertiary)
            }
    }
}

enum QueueSelectionState {
    case none
    case partial
    case all

    var systemImage: String {
        switch self {
        case .none: return "circle"
        case .partial: return "minus.circle.fill"
        case .all: return "checkmark.circle.fill"
        }
    }

    var accessibilityValue: String {
        switch self {
        case .none: return "선택 안 됨"
        case .partial: return "일부 선택됨"
        case .all: return "전체 선택됨"
        }
    }
}

struct QueueSelectionButton: View {
    let state: QueueSelectionState
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: state.systemImage)
                .font(.system(size: 23, weight: .semibold))
                .foregroundStyle(state == .none ? Color.secondary : Color.indigo)
                .frame(width: 38, height: 38)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(state.accessibilityValue)
    }
}

struct QueuePlaceSummaryRow: View {
    let place: PlaceRow

    var body: some View {
        HStack(spacing: 12) {
            QueueRemoteThumbnail(
                urlString: place.thumbnailURL,
                systemImage: "mappin.and.ellipse",
                width: 68,
                height: 68,
                cornerRadius: 9
            )

            VStack(alignment: .leading, spacing: 5) {
                Text(place.name)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Text(place.queueDisplayAddress)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)

                Text(place.queueDisplayCategory)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.indigo)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
    }
}
#endif
