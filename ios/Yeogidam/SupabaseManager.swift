import Foundation
import Supabase

/// 앱 전역에서 사용하는 단일 Supabase 클라이언트.
/// 기본값은 로컬 Supabase 스택이며, 배포 빌드는 Info.plist 의 SUPABASE_URL / SUPABASE_ANON_KEY 로 전환한다.
enum SupabaseManager {
    static let client = SupabaseClient(
        supabaseURL: YeogidamConfig.supabaseURL,
        supabaseKey: YeogidamConfig.supabaseAnonKey
    )
}
