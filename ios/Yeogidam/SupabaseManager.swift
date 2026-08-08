import Foundation
import Supabase

/// 앱 전역에서 사용하는 단일 Supabase 클라이언트.
/// MVP 개발 단계에서는 로컬 Supabase 스택(127.0.0.1:54321)에 연결한다.
/// 시뮬레이터는 호스트의 loopback 을 그대로 사용할 수 있다.
/// 배포 시 이 값들은 클라우드 프로젝트 URL / anon key 로 교체한다.
enum SupabaseManager {
    // 로컬 Supabase 데모 anon key (공개된 로컬 전용 키 — 비밀이 아님).
    private static let url = URL(string: "http://127.0.0.1:54321")!
    private static let anonKey =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

    static let client = SupabaseClient(supabaseURL: url, supabaseKey: anonKey)
}
