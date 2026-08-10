import Foundation
import Supabase

enum SharedSessionStore {
    struct Tokens {
        let accessToken: String
        let refreshToken: String
    }

    private static let accessTokenKey = "supabase.accessToken"
    private static let refreshTokenKey = "supabase.refreshToken"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: YeogidamConfig.appGroupIdentifier) ?? .standard
    }

    static func save(_ session: Session?) {
        guard let session else {
            clear()
            return
        }
        defaults.set(session.accessToken, forKey: accessTokenKey)
        defaults.set(session.refreshToken, forKey: refreshTokenKey)
    }

    static func load() -> Tokens? {
        guard
            let accessToken = defaults.string(forKey: accessTokenKey),
            let refreshToken = defaults.string(forKey: refreshTokenKey)
        else {
            return nil
        }
        return Tokens(accessToken: accessToken, refreshToken: refreshToken)
    }

    static func clear() {
        defaults.removeObject(forKey: accessTokenKey)
        defaults.removeObject(forKey: refreshTokenKey)
    }
}
