import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        VStack(spacing: 16) {
            Spacer()

            Image(systemName: "mappin.and.ellipse")
                .font(.system(size: 64))
                .foregroundStyle(.tint)

            Text("여기담")
                .font(.largeTitle.bold())

            Text("가고 싶은 장소를\n지도에 담아보세요.")
                .font(.body)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)

            Spacer()

            if let message = appState.errorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }

            Button {
                Task { await appState.signInAnonymously() }
            } label: {
                Group {
                    if appState.isWorking {
                        ProgressView()
                    } else {
                        Text("시작하기")
                            .font(.headline)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 52)
            }
            .buttonStyle(.borderedProminent)
            .disabled(appState.isWorking)

            Text("빠른 개발을 위해 지금은 익명으로 시작합니다.\n카카오·Apple 로그인은 곧 추가됩니다.")
                .font(.caption2)
                .multilineTextAlignment(.center)
                .foregroundStyle(.tertiary)
        }
        .padding(24)
    }
}
