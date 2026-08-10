import Foundation
import Supabase
import SwiftUI

/// 로그인 세션 상태를 관리하는 앱 전역 상태.
/// MVP 인증은 익명 로그인만 사용한다. 익명 세션도 실제 JWT 를 발급하므로
/// 이후 RLS·Edge Function 흐름이 최종 설계와 동일하게 동작한다.
@MainActor
final class AppState: ObservableObject {
    @Published var session: Session?
    @Published var isLoading = true
    @Published var isWorking = false
    @Published var errorMessage: String?

    private let auth = SupabaseManager.client.auth

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

    func signInAnonymously() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            session = try await auth.signInAnonymously()
            SharedSessionStore.save(session)
        } catch {
            errorMessage = "시작하지 못했어요. 잠시 후 다시 시도해주세요."
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
}
