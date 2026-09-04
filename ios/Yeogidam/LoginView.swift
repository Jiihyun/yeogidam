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

            Button {
                Task { await appState.signInWithKakao() }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "bubble.left.fill")
                    Text("카카오로 계속하기")
                        .font(.system(size: 17, weight: .semibold))
                }
                .frame(maxWidth: .infinity, minHeight: 52, maxHeight: 52)
                .foregroundStyle(Color.black.opacity(0.85))
                .background(Color(red: 1.0, green: 0.90, blue: 0.0))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .disabled(appState.isWorking)

            Button {
                Task { await appState.signInWithGoogle() }
            } label: {
                HStack(spacing: 10) {
                    Text("G")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(Color(red: 0.26, green: 0.52, blue: 0.96))
                    Text("Google로 계속하기")
                        .font(.system(size: 17, weight: .semibold))
                }
                .frame(maxWidth: .infinity, minHeight: 52, maxHeight: 52)
                .foregroundStyle(Color.primary)
                .background(Color(uiColor: .systemBackground))
                .overlay {
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.secondary.opacity(0.35), lineWidth: 1)
                }
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .disabled(appState.isWorking)

            #if !LOCAL_BUILD
                SignInWithAppleButton(.signIn) { request in
                    appState.prepareSignInWithApple(request)
                } onCompletion: { result in
                    Task { await appState.completeSignInWithApple(result) }
                }
                .signInWithAppleButtonStyle(.black)
                .frame(maxWidth: .infinity, minHeight: 52, maxHeight: 52)
                .disabled(appState.isWorking)
            #endif

            if appState.isWorking {
                ProgressView("로그인 확인 중...")
                    .font(.caption)
            }

            Group {
                #if LOCAL_BUILD
                    Text("카카오 또는 Google 계정으로 안전하게 로그인합니다.\n계정 비밀번호는 여기담에 저장되지 않아요.")
                #else
                    Text("카카오, Google 또는 Apple 계정으로 안전하게 로그인합니다.\n계정 비밀번호는 여기담에 저장되지 않아요.")
                #endif
            }
            .font(.caption2)
            .multilineTextAlignment(.center)
            .foregroundStyle(.tertiary)
        }
        .padding(24)
    }
}
