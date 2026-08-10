import Foundation

enum YeogidamConfig {
    static let supabaseURL = URL(
        string: Bundle.main.object(forInfoDictionaryKey: "SUPABASE_URL") as? String
            ?? "http://127.0.0.1:54321"
    )!

    static let supabaseAnonKey =
        Bundle.main.object(forInfoDictionaryKey: "SUPABASE_ANON_KEY") as? String
        ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

    static let appGroupIdentifier = "group.com.yeogidam"
}
