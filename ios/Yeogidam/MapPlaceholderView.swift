import SwiftUI

/// 지도 탭 자리표시자. 네이버 지도 SDK 연동은 Plan 06(NCP 키 준비 후).
struct MapPlaceholderView: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                Image(systemName: "map")
                    .font(.system(size: 56))
                    .foregroundStyle(.secondary)
                Text("지도는 준비 중이에요")
                    .font(.headline)
                Text("네이버 지도 연동 후 저장한 장소를\n지도에서 볼 수 있어요.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            .padding(24)
            .navigationTitle("지도")
        }
    }
}
