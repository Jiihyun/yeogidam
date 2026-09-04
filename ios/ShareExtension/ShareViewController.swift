import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let statusLabel = UILabel()

    private var supabaseURL: URL {
        URL(string: Bundle.main.object(forInfoDictionaryKey: "SUPABASE_URL") as? String ?? "http://127.0.0.1:54321")!
    }

    private var supabaseAnonKey: String {
        Bundle.main.object(forInfoDictionaryKey: "SUPABASE_ANON_KEY") as? String
            ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
    }

    private var appGroupIdentifier: String {
        Bundle.main.object(forInfoDictionaryKey: "APP_GROUP_IDENTIFIER") as? String
            ?? "group.com.yeogidam"
    }

    private var saveInstagramReelFunctionSlug: String {
        Bundle.main.object(forInfoDictionaryKey: "SAVE_INSTAGRAM_REEL_FUNCTION_SLUG") as? String
            ?? "save-instagram-reel"
    }

    private var saveInstagramReelFunctionURL: URL {
        supabaseURL
            .appendingPathComponent("functions")
            .appendingPathComponent("v1")
            .appendingPathComponent(saveInstagramReelFunctionSlug)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        configureView()
        Task { await handleShare() }
    }

    private func configureView() {
        view.backgroundColor = .systemBackground
        statusLabel.text = "여기담에 저장하는 중..."
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            statusLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    private func handleShare() async {
        do {
            guard let url = try await firstSharedURL() else {
                throw ShareError.noURL
            }
            guard isInstagramURL(url) else {
                throw ShareError.invalidURL
            }
            guard let token = UserDefaults(suiteName: appGroupIdentifier)?.string(forKey: "supabase.accessToken") else {
                throw ShareError.missingSession
            }
            try await save(
                url: url.absoluteString,
                accessToken: token,
                clientRequestID: UUID()
            )
            complete("저장 요청을 보냈어요.")
        } catch {
            complete(error.localizedDescription)
        }
    }

    private func firstSharedURL() async throws -> URL? {
        guard let item = extensionContext?.inputItems.first as? NSExtensionItem,
              let providers = item.attachments else {
            return nil
        }

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                return try await withCheckedThrowingContinuation { continuation in
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier) { item, error in
                        if let error {
                            continuation.resume(throwing: error)
                        } else if let url = item as? URL {
                            continuation.resume(returning: url)
                        } else {
                            continuation.resume(returning: nil)
                        }
                    }
                }
            }
        }
        return nil
    }

    private func save(
        url instagramURL: String,
        accessToken: String,
        clientRequestID: UUID
    ) async throws {
        var request = URLRequest(url: saveInstagramReelFunctionURL)
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "instagramUrl": instagramURL,
            "source": "instagram_share",
            "clientRequestId": clientRequestID.uuidString,
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "저장 요청이 실패했어요."
            throw ShareError.server(message)
        }
    }

    private func isInstagramURL(_ url: URL) -> Bool {
        let host = url.host?.lowercased()
        return host == "instagram.com" || host == "www.instagram.com"
    }

    private func complete(_ message: String) {
        statusLabel.text = message
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
            self.extensionContext?.completeRequest(returningItems: nil)
        }
    }
}

private enum ShareError: LocalizedError {
    case noURL
    case invalidURL
    case missingSession
    case server(String)

    var errorDescription: String? {
        switch self {
        case .noURL:
            return "공유된 URL을 찾지 못했어요."
        case .invalidURL:
            return "인스타그램 URL만 저장할 수 있어요."
        case .missingSession:
            return "먼저 여기담 앱을 열어 시작해주세요."
        case .server(let message):
            return message
        }
    }
}
