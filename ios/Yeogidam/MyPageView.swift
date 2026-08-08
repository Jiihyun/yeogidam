import SwiftUI

struct MyPageView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        NavigationStack {
            List {
                Section("내 정보") {
                    LabeledContent("로그인", value: "익명")
                    LabeledContent("사용자 ID", value: appState.userIdShort)
                }

                Section("설정") {
                    Text("알림 설정").foregroundStyle(.secondary)
                    Text("기본 지도 설정").foregroundStyle(.secondary)
                    Text("문의하기").foregroundStyle(.secondary)
                }

                Section {
                    Button(role: .destructive) {
                        Task { await appState.signOut() }
                    } label: {
                        Text("로그아웃")
                    }
                    .disabled(appState.isWorking)
                }
            }
            .navigationTitle("마이")
        }
    }
}
