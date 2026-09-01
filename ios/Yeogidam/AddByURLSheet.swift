import SwiftUI

struct AddByURLSheet: View {
    let accessToken: String
    let onSaved: (SaveInstagramReelResponse) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var instagramURL = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var pendingSubmission: ReelSubmission?

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
            #if LOCAL_BUILD
            .navigationTitle("릴스 분석")
            #else
            .navigationTitle("릴스 저장")
            #endif
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
                            #if LOCAL_BUILD
                            Text("분석")
                            #else
                            Text("저장")
                            #endif
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
            let submission: ReelSubmission
            if let pendingSubmission, pendingSubmission.instagramURL == url {
                submission = pendingSubmission
            } else {
                submission = ReelSubmission(instagramURL: url)
                pendingSubmission = submission
            }

            let response = try await YeogidamAPI(accessToken: accessToken)
                .saveInstagramReel(submission)
            pendingSubmission = nil
            #if LOCAL_BUILD
            dismiss()
            Task {
                try? await Task.sleep(nanoseconds: 300_000_000)
                await onSaved(response)
            }
            #else
            await onSaved(response)
            dismiss()
            #endif
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func isInstagramURL(_ value: String) -> Bool {
        guard let host = URL(string: value)?.host?.lowercased() else { return false }
        return host == "instagram.com" || host == "www.instagram.com"
    }
}
