import SwiftUI

struct AddByURLSheet: View {
    let accessToken: String
    let onSaved: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var instagramURL = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://www.instagram.com/reel/...", text: $instagramURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("릴스 저장")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Text("저장")
                        }
                    }
                    .disabled(isSaving || instagramURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func save() async {
        let url = instagramURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isInstagramURL(url) else {
            errorMessage = "인스타그램 릴스 URL을 입력해주세요."
            return
        }

        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            _ = try await YeogidamAPI(accessToken: accessToken).saveInstagramReel(url)
            await onSaved()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func isInstagramURL(_ value: String) -> Bool {
        guard let host = URL(string: value)?.host?.lowercased() else { return false }
        return host == "instagram.com" || host == "www.instagram.com"
    }
}
