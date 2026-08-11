import AuthenticationServices
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

            SignInWithAppleButton(.signIn) { request in
                appState.prepareSignInWithApple(request)
            } onCompletion: { result in
                Task { await appState.completeSignInWithApple(result) }
            }
            .signInWithAppleButtonStyle(.black)
            .frame(maxWidth: .infinity, minHeight: 52, maxHeight: 52)
            .disabled(appState.isWorking)

            if appState.isWorking {
                ProgressView("로그인 확인 중...")
                    .font(.caption)
            }

            Text("Apple 계정으로 안전하게 로그인합니다.\n이메일 주소는 공개하지 않아도 돼요.")
                .font(.caption2)
                .multilineTextAlignment(.center)
                .foregroundStyle(.tertiary)
        }
        .padding(24)
    }
}
