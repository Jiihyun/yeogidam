import SwiftUI

/// 저장됨 탭. Plan 05 에서 실제 저장 장소/처리중/실패 카드를 채운다.
/// 지금은 빈 상태만 표시한다.
struct SavedPlacesView: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                Spacer()
                Image(systemName: "tray")
                    .font(.system(size: 56))
                    .foregroundStyle(.secondary)
                Text("아직 저장된 장소가 없어요")
                    .font(.headline)
                Text("인스타그램에서 가고 싶은 장소를 발견했다면\n공유 버튼을 눌러 여기담에 저장해보세요.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(24)
            .navigationTitle("저장됨")
        }
    }
}
