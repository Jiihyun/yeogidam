import SwiftUI

struct SavedPlacesView: View {
    @EnvironmentObject private var appState: AppState

    @State private var savedPlaces: [SavedPlaceRow] = []
    @State private var activeReels: [ReelRow] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showsAddSheet = false

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && savedPlaces.isEmpty && activeReels.isEmpty {
                    ProgressView()
                } else if savedPlaces.isEmpty && activeReels.isEmpty {
                    emptyState
                } else {
                    List {
                        if !activeReels.isEmpty {
                            Section("처리 중") {
                                ForEach(activeReels) { reel in
                                    ReelStatusRow(reel: reel)
                                }
                            }
                        }

                        Section("저장한 장소") {
                            ForEach(savedPlaces) { savedPlace in
                                NavigationLink {
                                    SavedPlaceDetailView(savedPlace: savedPlace)
                                } label: {
                                    SavedPlaceRowView(savedPlace: savedPlace)
                                }
                                .swipeActions {
                                    Button(role: .destructive) {
                                        Task { await delete(savedPlace) }
                                    } label: {
                                        Label("삭제", systemImage: "trash")
                                    }
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await load() }
                }
            }
            #if LOCAL_BUILD
            .navigationTitle("보관함")
            #else
            .navigationTitle("저장됨")
            #endif
            #if !LOCAL_BUILD
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showsAddSheet = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .disabled(appState.session == nil)
                }
            }
            #endif
            .safeAreaInset(edge: .bottom) {
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity)
                        .background(.red)
                }
            }
            #if !LOCAL_BUILD
            .sheet(isPresented: $showsAddSheet) {
                if let accessToken = appState.session?.accessToken {
                    AddByURLSheet(accessToken: accessToken) { _ in
                        await load()
                    }
                }
            }
            #endif
            #if LOCAL_BUILD
            .onAppear { Task { await load() } }
            #else
            .task { await load() }
            #endif
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "tray")
                .font(.system(size: 56))
                .foregroundStyle(.secondary)
            Text("아직 저장된 장소가 없어요")
                .font(.headline)
            #if LOCAL_BUILD
            Text("대기함에서 원하는 장소를 선택해\n보관함에 저장해보세요.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            #else
            Text("릴스 URL을 직접 입력해 먼저 저장 흐름을 확인해보세요.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            #endif
            #if !LOCAL_BUILD
            Button {
                showsAddSheet = true
            } label: {
                Label("릴스 URL 추가", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .padding(.top, 8)
            #endif
            Spacer()
        }
        .padding(24)
    }

    private func api() throws -> YeogidamAPI {
        guard let accessToken = appState.session?.accessToken else {
            throw YeogidamAPIError.missingSession
        }
        return YeogidamAPI(accessToken: accessToken)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let snapshot = try await api().fetchSnapshot()
            savedPlaces = snapshot.savedPlaces
            activeReels = snapshot.activeReels
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(_ savedPlace: SavedPlaceRow) async {
        do {
            try await api().deleteSavedPlace(id: savedPlace.id)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct SavedPlaceRowView: View {
    let savedPlace: SavedPlaceRow

    private var thumbnailURL: URL? {
        URL(string: savedPlace.thumbnailURL ?? savedPlace.place.thumbnailURL ?? "")
    }

    var body: some View {
        HStack(spacing: 12) {
            AsyncImage(url: thumbnailURL) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                case .failure:
                    placeholder
                case .empty:
                    placeholder.overlay { ProgressView().controlSize(.small) }
                @unknown default:
                    placeholder
                }
            }
            .frame(width: 72, height: 72)
            .clipShape(RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 5) {
                Text(savedPlace.place.name)
                    .font(.headline)
                    .lineLimit(1)
                Text(savedPlace.place.sourceAddress ?? savedPlace.place.roadAddress ?? savedPlace.place.address ?? "주소 정보 없음")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if let category = savedPlace.place.category, !category.isEmpty {
                    Text(category)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var placeholder: some View {
        Rectangle()
            .fill(.quaternary)
            .overlay {
                Image(systemName: "mappin.and.ellipse")
                    .foregroundStyle(.secondary)
            }
    }
}

private struct ReelStatusRow: View {
    let reel: ReelRow

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: reel.processingStatus == .failed ? "exclamationmark.triangle.fill" : "clock.fill")
                .foregroundStyle(reel.processingStatus == .failed ? Color.red : Color.accentColor)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                Text(reel.instagramURL)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 6)
    }

    private var title: String {
        if reel.processingStatus == .failed {
            #if LOCAL_BUILD
            return reel.failureReason?.displayText ?? "분석에 실패했어요"
            #else
            return reel.failureReason?.displayText ?? "저장에 실패했어요"
            #endif
        }
        return "장소를 찾고 있어요"
    }
}
