import Foundation
import Supabase

/// Supabase 세션은 Keychain에 영구 보관하고, OAuth PKCE code verifier는
/// 인증 화면이 열려 있는 동안에만 메모리에 보관한다.
///
/// 시뮬레이터에서 ASWebAuthenticationSession을 거쳐 돌아올 때 Keychain에 저장한
/// code verifier를 찾지 못하는 경우가 있어, 일회성 값만 별도로 다룬다.
private final class YeogidamAuthStorage: AuthLocalStorage, @unchecked Sendable {
    private let persistentStorage = KeychainLocalStorage(
        service: YeogidamConfig.authKeychainService
    )
    private let lock = NSLock()
    private var codeVerifier: Data?

    func store(key: String, value: Data) throws {
        guard isCodeVerifierKey(key) else {
            try persistentStorage.store(key: key, value: value)
            return
        }

        lock.lock()
        defer { lock.unlock() }
        codeVerifier = value
    }

    func retrieve(key: String) throws -> Data? {
        guard isCodeVerifierKey(key) else {
            return try persistentStorage.retrieve(key: key)
        }

        lock.lock()
        defer { lock.unlock() }
        return codeVerifier
    }

    func remove(key: String) throws {
        guard isCodeVerifierKey(key) else {
            try persistentStorage.remove(key: key)
            return
        }

        lock.lock()
        defer { lock.unlock() }
        codeVerifier = nil
    }

    private func isCodeVerifierKey(_ key: String) -> Bool {
        key.hasSuffix("-code-verifier")
    }
}

/// 앱 전역에서 사용하는 단일 Supabase 클라이언트.
/// 기본값은 로컬 Supabase 스택이며, 배포 빌드는 Info.plist 의 SUPABASE_URL / SUPABASE_ANON_KEY 로 전환한다.
enum SupabaseManager {
    static let client = SupabaseClient(
        supabaseURL: YeogidamConfig.supabaseURL,
        supabaseKey: YeogidamConfig.supabaseAnonKey,
        options: SupabaseClientOptions(
            auth: .init(
                storage: YeogidamAuthStorage(),
                redirectToURL: YeogidamConfig.oauthRedirectURL,
                flowType: .pkce
            )
        )
    )
}
