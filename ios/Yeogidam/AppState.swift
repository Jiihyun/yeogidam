import AuthenticationServices
import CryptoKit
import Foundation
import Supabase
import SwiftUI

/// 로그인 세션 상태를 관리하는 앱 전역 상태.
/// Apple이 발급한 신원 토큰을 Supabase 세션으로 교환한다.
/// 기존 익명 세션이 있으면 Apple 계정을 연결해 저장된 장소의 소유권을 유지한다.
@MainActor
final class AppState: ObservableObject {
    @Published var session: Session?
    @Published var isLoading = true
    @Published var isWorking = false
    @Published var errorMessage: String?

    private let auth = SupabaseManager.client.auth
    private var currentAppleNonce: String?

    /// 익명 사용자는 로그인 화면에 머물고, Apple 계정이 연결된 사용자만 앱으로 진입한다.
    var hasPermanentSession: Bool {
        guard let session else { return false }
        return !session.user.isAnonymous
    }

    /// 앱 시작 시: 저장된 세션을 복원하고, 이후 인증 상태 변화를 계속 반영한다.
    func start() async {
        session = try? await auth.session
        if session == nil, let tokens = SharedSessionStore.load() {
            session = try? await auth.setSession(
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken
            )
        }
        SharedSessionStore.save(session)
        isLoading = false
        for await change in auth.authStateChanges {
            session = change.session
            SharedSessionStore.save(change.session)
        }
    }

    /// Apple 로그인 요청에 일회용 보안값을 넣는다.
    func prepareSignInWithApple(_ request: ASAuthorizationAppleIDRequest) {
        isWorking = true
        errorMessage = nil

        let rawNonce = UUID().uuidString
        currentAppleNonce = rawNonce
        request.requestedScopes = [.fullName, .email]
        request.nonce = Self.sha256(rawNonce)
    }

    /// Apple의 로그인 결과를 검증한 뒤 Supabase 세션으로 바꾼다.
    func completeSignInWithApple(_ result: Result<ASAuthorization, Error>) async {
        defer {
            currentAppleNonce = nil
            isWorking = false
        }

        switch result {
        case .failure(let error):
            if let authorizationError = error as? ASAuthorizationError,
               authorizationError.code == .canceled {
                return
            }
            errorMessage = "Apple 로그인을 완료하지 못했어요. 잠시 후 다시 시도해주세요."

        case .success(let authorization):
            do {
                guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                    throw AppleSignInError.invalidCredential
                }
                guard let tokenData = credential.identityToken,
                      let idToken = String(data: tokenData, encoding: .utf8) else {
                    throw AppleSignInError.missingIdentityToken
                }
                guard let rawNonce = currentAppleNonce else {
                    throw AppleSignInError.missingNonce
                }

                let credentials = OpenIDConnectCredentials(
                    provider: .apple,
                    idToken: idToken,
                    nonce: rawNonce
                )

                if session?.user.isAnonymous == true {
                    session = try await auth.linkIdentityWithIdToken(credentials: credentials)
                } else {
                    session = try await auth.signInWithIdToken(credentials: credentials)
                }
                SharedSessionStore.save(session)

                // Apple은 이름을 최초 승인 때만 제공하므로 받는 즉시 사용자 정보에 저장한다.
                if let fullName = credential.fullName?.formatted(), !fullName.isEmpty {
                    _ = try? await auth.update(
                        user: UserAttributes(data: ["full_name": .string(fullName)])
                    )
                }
            } catch {
                errorMessage = "Apple 로그인 정보를 확인하지 못했어요. 다시 시도해주세요."
            }
        }
    }

    func signOut() async {
        isWorking = true
        defer { isWorking = false }
        try? await auth.signOut()
        session = nil
        SharedSessionStore.clear()
    }

    /// 현재 사용자 식별자(마이페이지 표시용).
    var userIdShort: String {
        guard let id = session?.user.id.uuidString else { return "-" }
        return String(id.prefix(8))
    }

    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

private enum AppleSignInError: Error {
    case invalidCredential
    case missingIdentityToken
    case missingNonce
}
